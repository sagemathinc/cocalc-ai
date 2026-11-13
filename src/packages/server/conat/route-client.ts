import {
  conatPassword,
  conatServer,
  getProjectHostAuthTokenPrivateKey,
} from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { projectHostAgentFor } from "@cocalc/backend/project-host-target";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  connect,
  type ClientOptions,
  type Client,
} from "@cocalc/conat/core/client";
import { issueProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import LRU from "lru-cache";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  materializeHostRouteTarget,
  materializeProjectHostTarget,
  routeProjectSubject,
  listenForUpdates as listenForProjectHostUpdates,
} from "./route-project";
import { resolveHostBayAcrossCluster } from "@cocalc/server/inter-bay/directory";

// Create or reuse a conat client and retrofit project routing onto it.
// We intentionally set the route function after creation so we can mutate
// an existing cached client that may have been created before routing
// was configured (e.g., backend/conat init).
let listenerStarted = false;
const HUB_ROUTE_TOKEN_LEEWAY_MS = 60_000;
const ROUTED_RECONNECT_DELAYS_MS = [1_000, 3_500, 10_000];
const DEFAULT_ROUTED_ACCOUNT_CLIENT_MAX = 256;
const DEFAULT_ROUTED_ACCOUNT_CLIENT_TTL_MS = 10 * 60_000;
const ROUTED_ACCOUNT_CLIENT_USE_GRACE_MS = 60_000;
const log = getLogger("server:conat:route-client");

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number.parseInt(`${process.env[name] ?? ""}`, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const ROUTED_ACCOUNT_CLIENT_MAX = positiveIntegerEnv(
  "COCALC_HUB_ROUTED_ACCOUNT_CLIENT_MAX",
  DEFAULT_ROUTED_ACCOUNT_CLIENT_MAX,
);
const ROUTED_ACCOUNT_CLIENT_TTL_MS = positiveIntegerEnv(
  "COCALC_HUB_ROUTED_ACCOUNT_CLIENT_TTL_MS",
  DEFAULT_ROUTED_ACCOUNT_CLIENT_TTL_MS,
);

type RoutedHubClientState = {
  key: string;
  address: string;
  client: Client;
  activeLeases: number;
  cached: boolean;
  closed: boolean;
  protectedUntil: number;
  host_session_id?: string;
  account_id?: string;
  token?: string;
  expiresAt?: number;
  inFlight?: Promise<string>;
  closeAfterInFlight?: Promise<void>;
  closeAfterUseTimer?: ReturnType<typeof setTimeout>;
};

const routedHubClients: Record<string, RoutedHubClientState> = {};
const routedAccountClientStates = new Set<RoutedHubClientState>();
let routedAccountClientEvictions = 0;
let routedAccountClientCreates = 0;
let routedAccountClientReuses = 0;
let routedHubClientCreates = 0;
let routedHubClientReuses = 0;

function closeRoutedClientWhenUnused(state: RoutedHubClientState): void {
  if (state.closed || state.cached || state.activeLeases > 0) {
    return;
  }
  if (state.inFlight) {
    if (!state.closeAfterInFlight) {
      const pending = state.inFlight;
      state.closeAfterInFlight = pending
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          delete state.closeAfterInFlight;
          closeRoutedClientWhenUnused(state);
        });
    }
    return;
  }
  const remainingProtectionMs = state.protectedUntil - Date.now();
  if (remainingProtectionMs > 0) {
    if (!state.closeAfterUseTimer) {
      state.closeAfterUseTimer = setTimeout(() => {
        delete state.closeAfterUseTimer;
        closeRoutedClientWhenUnused(state);
      }, remainingProtectionMs);
      state.closeAfterUseTimer.unref?.();
    }
    return;
  }
  state.closed = true;
  routedAccountClientStates.delete(state);
  try {
    state.client.close();
  } catch {
    // ignore close errors
  }
}

const routedAccountClients = new LRU<string, RoutedHubClientState>({
  max: ROUTED_ACCOUNT_CLIENT_MAX,
  ttl: ROUTED_ACCOUNT_CLIENT_TTL_MS,
  ttlAutopurge: true,
  updateAgeOnGet: true,
  dispose: (state, _key, reason) => {
    state.cached = false;
    if (reason === "evict") {
      routedAccountClientEvictions += 1;
    }
    closeRoutedClientWhenUnused(state);
  },
});

const HOST_CONTROL_DIRECT_INTEREST_TIMEOUT_MS = 1_500;

function hostControlSubject(host_id: string): string {
  return `project-host.${host_id}.api`;
}

type RoutedTarget =
  | {
      address?: string;
      host_id?: string;
      host_session_id?: string;
    }
  | {
      client: Client;
    };

function lookupRoutedClient(
  key: string,
  accountScoped: boolean,
  touch = true,
): RoutedHubClientState | undefined {
  if (!accountScoped) {
    return routedHubClients[key];
  }
  return touch ? routedAccountClients.get(key) : routedAccountClients.peek(key);
}

function removeClosedRoutedClient(state: RoutedHubClientState): void {
  if (state.closed) {
    return;
  }
  state.closed = true;
  if (state.closeAfterUseTimer) {
    clearTimeout(state.closeAfterUseTimer);
    delete state.closeAfterUseTimer;
  }
  routedAccountClientStates.delete(state);
  if (state.account_id) {
    if (routedAccountClients.peek(state.key) === state) {
      routedAccountClients.delete(state.key);
    }
    return;
  }
  if (routedHubClients[state.key] === state) {
    delete routedHubClients[state.key];
  }
}

function evictRoutedClient(key: string, expected?: RoutedHubClientState): void {
  const current =
    expected?.account_id != null
      ? routedAccountClients.peek(key)
      : (routedHubClients[key] ?? routedAccountClients.peek(key));
  if (!current) return;
  if (expected != null && current !== expected) return;
  if (current.account_id) {
    routedAccountClients.delete(key);
    return;
  }
  delete routedHubClients[key];
  current.cached = false;
  current.closed = true;
  try {
    current.client.close();
  } catch {
    // ignore close errors
  }
}

async function refreshRoutedTarget({
  host_id,
  project_id,
}: {
  host_id: string;
  project_id?: string;
}): Promise<
  | {
      address?: string;
      host_id?: string;
      host_session_id?: string;
    }
  | undefined
> {
  if (project_id) {
    return await materializeProjectHostTarget(project_id, { fresh: true });
  }
  return await materializeHostRouteTarget(host_id, { fresh: true });
}

async function issueHubRouteToken(host_id: string): Promise<{
  token: string;
  expiresAt: number;
}> {
  const ownership = await resolveHostBayAcrossCluster(host_id);
  if (ownership && ownership.bay_id !== getConfiguredBayId()) {
    const issued = await getInterBayBridge()
      .projectHostAuthToken(ownership.bay_id, { timeout_ms: 15_000 })
      .issue({ actor: "hub", host_id });
    return { token: issued.token, expiresAt: issued.expires_at };
  }
  const { token, expires_at } = issueProjectHostAuthToken({
    host_id,
    actor: "hub",
    hub_id: "hub",
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { token, expiresAt: expires_at };
}

async function issueAccountRouteToken({
  host_id,
  account_id,
}: {
  host_id: string;
  account_id: string;
}): Promise<{
  token: string;
  expiresAt: number;
}> {
  const ownership = await resolveHostBayAcrossCluster(host_id);
  if (ownership && ownership.bay_id !== getConfiguredBayId()) {
    const issued = await getInterBayBridge()
      .projectHostAuthToken(ownership.bay_id, { timeout_ms: 15_000 })
      .issue({ account_id, host_id });
    return { token: issued.token, expiresAt: issued.expires_at };
  }
  const { token, expires_at } = issueProjectHostAuthToken({
    host_id,
    actor: "account",
    account_id,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { token, expiresAt: expires_at };
}

async function getHubRouteToken(
  host_id: string,
  state: RoutedHubClientState,
): Promise<string> {
  const now = Date.now();
  if (
    state.token &&
    state.expiresAt &&
    now < state.expiresAt - HUB_ROUTE_TOKEN_LEEWAY_MS
  ) {
    return state.token;
  }
  if (state.inFlight) {
    return await state.inFlight;
  }
  state.inFlight = Promise.resolve().then(async () => {
    const { token, expiresAt } = state.account_id
      ? await issueAccountRouteToken({
          host_id,
          account_id: state.account_id,
        })
      : await issueHubRouteToken(host_id);
    state.token = token;
    state.expiresAt = expiresAt;
    return token;
  });
  try {
    return await state.inFlight;
  } finally {
    delete state.inFlight;
  }
}

function routedClientKey({
  host_id,
  account_id,
}: {
  host_id: string;
  account_id?: string;
}): string {
  return account_id ? `${host_id}:account:${account_id}` : `${host_id}:hub`;
}

function getOrCreateRoutedHubClient({
  host_id,
  address,
  host_session_id,
  account_id,
  onUse,
}: {
  host_id: string;
  address: string;
  host_session_id?: string;
  account_id?: string;
  onUse?: (state: RoutedHubClientState) => void;
}): Client {
  const key = routedClientKey({ host_id, account_id });
  const accountScoped = account_id != null;
  const existing = lookupRoutedClient(key, accountScoped);
  if (
    existing?.address === address &&
    existing?.host_session_id === host_session_id
  ) {
    if (accountScoped) {
      routedAccountClientReuses += 1;
    } else {
      routedHubClientReuses += 1;
    }
    existing.protectedUntil = Date.now() + ROUTED_ACCOUNT_CLIENT_USE_GRACE_MS;
    onUse?.(existing);
    return existing.client;
  }
  if (existing) {
    evictRoutedClient(key, existing);
  }
  const state: RoutedHubClientState = {
    key,
    address,
    host_session_id,
    account_id,
    activeLeases: 0,
    cached: true,
    closed: false,
    protectedUntil: Date.now() + ROUTED_ACCOUNT_CLIENT_USE_GRACE_MS,
    client: undefined as unknown as Client,
  };
  state.client = connect({
    // Routed host clients already have explicit lifecycle via routedHubClients,
    // so they must not share the global Conat cache or socket.io manager state.
    noCache: true,
    forceNew: true,
    address,
    // Both socket.io transports (polling and websocket) connect through this
    // agent, which checks the address actually connected to (054 C).
    agent: projectHostAgentFor(address) as any,
    inboxPrefix: account_id
      ? inboxPrefix({ account_id })
      : inboxPrefix({ hub_id: "hub" }),
    auth: async (cb) => {
      try {
        const token = await getHubRouteToken(host_id, state);
        cb({ bearer: token });
      } catch (err) {
        log.debug("failed issuing routed hub token", {
          host_id,
          address,
          err: `${err}`,
        });
        cb({});
      }
    },
    reconnection: false,
  });
  const reconnectRouted = () => {
    for (const delayMs of ROUTED_RECONNECT_DELAYS_MS) {
      setTimeout(() => {
        void (async () => {
          if (lookupRoutedClient(key, accountScoped, false) !== state) {
            return;
          }
          if (state.client.conn?.connected) {
            return;
          }
          try {
            const fresh = await refreshRoutedTarget({ host_id });
            if (
              !fresh?.address ||
              (fresh.host_id && fresh.host_id !== host_id) ||
              fresh.address !== state.address ||
              fresh.host_session_id !== state.host_session_id
            ) {
              evictRoutedClient(key, state);
              return;
            }
          } catch (err) {
            log.debug("failed refreshing routed hub client target", {
              host_id,
              address,
              err: `${err}`,
            });
          }
          try {
            state.client.connect();
          } catch (err) {
            log.debug("failed reconnecting routed hub client", {
              host_id,
              address,
              err: `${err}`,
            });
          }
        })();
      }, delayMs).unref?.();
    }
  };
  state.client.on("disconnected", () => {
    delete state.token;
    delete state.expiresAt;
    reconnectRouted();
  });
  state.client.conn.on("connect_error", () => {
    delete state.token;
    delete state.expiresAt;
    reconnectRouted();
  });
  state.client.conn.io.on("error", () => {
    reconnectRouted();
  });
  state.client.on("closed", () => {
    removeClosedRoutedClient(state);
  });
  if (accountScoped) {
    routedAccountClientCreates += 1;
    routedAccountClientStates.add(state);
    routedAccountClients.set(key, state);
  } else {
    routedHubClientCreates += 1;
    routedHubClients[key] = state;
  }
  state.protectedUntil = Date.now() + ROUTED_ACCOUNT_CLIENT_USE_GRACE_MS;
  onUse?.(state);
  return state.client;
}

export function getExplicitProjectHostRoutedHubClient({
  host_id,
  address,
  host_session_id,
}: {
  host_id: string;
  address: string;
  host_session_id?: string;
}): Client {
  if (!host_id || !address) {
    throw new Error(
      "an explicit project-host route requires host_id and address",
    );
  }
  return getOrCreateRoutedHubClient({
    host_id,
    address,
    host_session_id,
  });
}

function routeTargetToClient(
  _subject: string,
  target?: {
    address?: string;
    host_id?: string;
    host_session_id?: string;
  },
  account_id?: string,
  onUse?: (state: RoutedHubClientState) => void,
): RoutedTarget | undefined {
  if (!target?.address || !target.host_id) {
    return target;
  }
  return {
    client: getOrCreateRoutedHubClient({
      host_id: target.host_id,
      address: target.address,
      host_session_id: target.host_session_id,
      account_id,
      onUse,
    }),
  };
}

function hasRoutedClient(target?: RoutedTarget): target is { client: Client } {
  return !!target && "client" in target;
}

export async function getExplicitProjectRoutedClient({
  project_id,
  fresh = false,
  account_id,
}: {
  project_id: string;
  fresh?: boolean;
  account_id?: string;
}): Promise<Client> {
  const routed = routeTargetToClient(
    `project.${project_id}`,
    await materializeProjectHostTarget(project_id, { fresh }),
    account_id,
  );
  if (!hasRoutedClient(routed)) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  return routed.client;
}

export async function getExplicitHostRoutedClient({
  host_id,
  fresh = false,
}: {
  host_id: string;
  fresh?: boolean;
}): Promise<Client> {
  const routed = routeTargetToClient(
    `project-host.${host_id}`,
    await materializeHostRouteTarget(host_id, { fresh }),
  );
  if (!hasRoutedClient(routed)) {
    throw new Error(`unable to route host ${host_id} to its owning bay`);
  }
  return routed.client;
}

export async function getExplicitHostControlClient({
  host_id,
  fresh = false,
}: {
  host_id: string;
  fresh?: boolean;
}): Promise<Client> {
  const routed = await materializeHostRouteTarget(host_id, { fresh });
  if (routed?.host_id) {
    const subject = hostControlSubject(host_id);
    const target = routeTargetToClient(subject, routed);
    if (hasRoutedClient(target)) {
      try {
        if (
          await target.client.waitForInterest(subject, {
            timeout: HOST_CONTROL_DIRECT_INTEREST_TIMEOUT_MS,
          })
        ) {
          return target.client;
        }
      } catch (err) {
        log.debug("direct host control service interest check failed", {
          host_id,
          address: routed.address,
          err: `${err}`,
        });
      }
      log.debug("falling back to legacy host control route", {
        host_id,
        address: routed.address,
      });
      return conatWithProjectRouting();
    }
    throw new Error(`unable to route host ${host_id} to its control service`);
  }
  if (!routed?.host_id && !(await resolveHostBayAcrossCluster(host_id))) {
    throw new Error(`unable to route host ${host_id} to its owning bay`);
  }
  // Remote-bay hosts are handled by getRoutedHostControlClient before this
  // helper is called. Keep this fallback for direct callers that only need to
  // validate remote ownership here.
  return conatWithProjectRouting();
}

function conatWithProjectRoutingInternal(
  options?: ClientOptions,
  account_id?: string,
): Client {
  if (!listenerStarted) {
    listenerStarted = true;
    // Ensure we hear about project host changes so routing stays fresh.
    listenForProjectHostUpdates().catch(() => {
      listenerStarted = false;
    });
  }
  const { routeSubject, ...rest } = options ?? {};
  const leasedRoutedClients = account_id
    ? new Set<RoutedHubClientState>()
    : undefined;
  const leaseRoutedClient = (state: RoutedHubClientState) => {
    if (!leasedRoutedClients || leasedRoutedClients.has(state)) {
      return;
    }
    state.activeLeases += 1;
    leasedRoutedClients.add(state);
  };
  const client = connect({
    address: conatServer,
    inboxPrefix: inboxPrefix({ hub_id: "hub" }),
    extraHeaders: {
      Cookie: `${HUB_PASSWORD_COOKIE_NAME}=${conatPassword}`,
    },
    ...rest,
    ...(account_id ? { noCache: true } : undefined),
  });
  const combinedRoute =
    routeSubject == null
      ? (subject: string) => {
          const routed = routeProjectSubject(subject);
          return routeTargetToClient(
            subject,
            routed,
            account_id,
            leaseRoutedClient,
          );
        }
      : (subject: string) => {
          const custom = routeSubject(subject);
          if (custom) return custom;
          const routed = routeProjectSubject(subject);
          return routeTargetToClient(
            subject,
            routed,
            account_id,
            leaseRoutedClient,
          );
        };
  client.setRouteSubject(combinedRoute);
  if (leasedRoutedClients) {
    const close = client.close;
    let released = false;
    client.close = () => {
      if (released) {
        return;
      }
      released = true;
      try {
        close();
      } finally {
        for (const state of leasedRoutedClients) {
          state.activeLeases = Math.max(0, state.activeLeases - 1);
          if (state.activeLeases === 0) {
            state.protectedUntil = 0;
          }
          closeRoutedClientWhenUnused(state);
        }
        leasedRoutedClients.clear();
      }
    };
  }
  return client;
}

export function getRoutedClientCacheStats(): {
  hub_clients: number;
  hub_client_subscriptions: number;
  account_clients: number;
  tracked_account_clients: number;
  account_client_subscriptions: number;
  active_account_clients: number;
  deferred_account_clients: number;
  account_client_max: number;
  account_client_ttl_ms: number;
  account_client_creates: number;
  account_client_reuses: number;
  account_client_evictions: number;
  hub_client_creates: number;
  hub_client_reuses: number;
} {
  routedAccountClients.purgeStale();
  let active_account_clients = 0;
  let deferred_account_clients = 0;
  let account_client_subscriptions = 0;
  for (const state of routedAccountClientStates) {
    if (state.activeLeases > 0) {
      active_account_clients += 1;
    }
    if (!state.cached) {
      deferred_account_clients += 1;
    }
    account_client_subscriptions += state.client.numSubscriptions?.() ?? 0;
  }
  const hubStates = Object.values(routedHubClients);
  return {
    hub_clients: hubStates.length,
    hub_client_subscriptions: hubStates.reduce(
      (total, state) => total + (state.client.numSubscriptions?.() ?? 0),
      0,
    ),
    account_clients: routedAccountClients.size,
    tracked_account_clients: routedAccountClientStates.size,
    account_client_subscriptions,
    active_account_clients,
    deferred_account_clients,
    account_client_max: ROUTED_ACCOUNT_CLIENT_MAX,
    account_client_ttl_ms: ROUTED_ACCOUNT_CLIENT_TTL_MS,
    account_client_creates: routedAccountClientCreates,
    account_client_reuses: routedAccountClientReuses,
    account_client_evictions: routedAccountClientEvictions,
    hub_client_creates: routedHubClientCreates,
    hub_client_reuses: routedHubClientReuses,
  };
}

export function conatWithProjectRouting(options?: ClientOptions): Client {
  return conatWithProjectRoutingInternal(options);
}

export function conatWithProjectRoutingForAccount({
  account_id,
  options,
}: {
  account_id: string;
  options?: ClientOptions;
}): Client {
  return conatWithProjectRoutingInternal(options, account_id);
}
