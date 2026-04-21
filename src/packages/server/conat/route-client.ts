import {
  conatPassword,
  conatServer,
  getProjectHostAuthTokenPrivateKey,
} from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import { inboxPrefix } from "@cocalc/conat/names";
import {
  connect,
  type ClientOptions,
  type Client,
} from "@cocalc/conat/core/client";
import { issueProjectHostAuthToken } from "@cocalc/conat/auth/project-host-token";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { isValidUUID } from "@cocalc/util/misc";
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
const log = getLogger("server:conat:route-client");

type RoutedHubClientState = {
  key: string;
  address: string;
  client: Client;
  host_session_id?: string;
  account_id?: string;
  project_id?: string;
  token?: string;
  expiresAt?: number;
  inFlight?: Promise<string>;
};

const routedHubClients: Record<string, RoutedHubClientState> = {};

type RoutedTarget =
  | {
      address?: string;
      host_id?: string;
      host_session_id?: string;
    }
  | {
      client: Client;
    };

function evictRoutedClient(key: string, expected?: RoutedHubClientState): void {
  const current = routedHubClients[key];
  if (!current) return;
  if (expected != null && current !== expected) return;
  delete routedHubClients[key];
  try {
    current.client.close();
  } catch {
    // ignore close errors
  }
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
  project_id,
}: {
  host_id: string;
  account_id: string;
  project_id?: string;
}): Promise<{
  token: string;
  expiresAt: number;
}> {
  const ownership = await resolveHostBayAcrossCluster(host_id);
  if (ownership && ownership.bay_id !== getConfiguredBayId()) {
    const issued = await getInterBayBridge()
      .projectHostAuthToken(ownership.bay_id, { timeout_ms: 15_000 })
      .issue({ account_id, host_id, project_id });
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
          project_id: state.project_id,
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
  project_id,
}: {
  host_id: string;
  account_id?: string;
  project_id?: string;
}): string {
  return account_id
    ? `${host_id}:account:${account_id}:project:${project_id ?? ""}`
    : `${host_id}:hub`;
}

function getOrCreateRoutedHubClient({
  host_id,
  address,
  host_session_id,
  account_id,
  project_id,
}: {
  host_id: string;
  address: string;
  host_session_id?: string;
  account_id?: string;
  project_id?: string;
}): Client {
  const key = routedClientKey({ host_id, account_id, project_id });
  const existing = routedHubClients[key];
  if (
    existing?.address === address &&
    existing?.host_session_id === host_session_id
  ) {
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
    project_id,
    client: undefined as unknown as Client,
  };
  state.client = connect({
    // Routed host clients already have explicit lifecycle via routedHubClients,
    // so they must not share the global Conat cache or socket.io manager state.
    noCache: true,
    forceNew: true,
    address,
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
        if (routedHubClients[key] !== state) {
          return;
        }
        if (state.client.conn?.connected) {
          return;
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
    evictRoutedClient(key, state);
  });
  routedHubClients[key] = state;
  return state.client;
}

function routeTargetToClient(
  subject: string,
  target?: {
    address?: string;
    host_id?: string;
    host_session_id?: string;
  },
  account_id?: string,
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
      project_id: account_id ? extractProjectRouteSubject(subject) : undefined,
    }),
  };
}

function extractProjectRouteSubject(subject: string): string | undefined {
  const parts = subject.split(".");
  if (parts[0] === "project" || parts[0] === "file-server") {
    const project_id = parts[1];
    return project_id && isValidUUID(project_id) ? project_id : undefined;
  }
  const maybe = parts[1];
  if (maybe?.startsWith("project-")) {
    const project_id = maybe.slice("project-".length);
    return isValidUUID(project_id) ? project_id : undefined;
  }
}

function hasRoutedClient(target?: RoutedTarget): target is { client: Client } {
  return !!target && "client" in target;
}

export async function getExplicitProjectRoutedClient({
  project_id,
  fresh = false,
}: {
  project_id: string;
  fresh?: boolean;
}): Promise<Client> {
  const routed = routeTargetToClient(
    `project.${project_id}`,
    await materializeProjectHostTarget(project_id, { fresh }),
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
  if (!routed?.host_id && !(await resolveHostBayAcrossCluster(host_id))) {
    throw new Error(`unable to route host ${host_id} to its owning bay`);
  }
  // The project-host control service currently lives on the owning bay hub
  // cluster, not the host-local Conat server. Keep the route materialization
  // explicit so callers fail fast on invalid ownership, but send the RPC over
  // the bay hub client.
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
  const client = connect({
    address: conatServer,
    inboxPrefix: inboxPrefix({ hub_id: "hub" }),
    extraHeaders: {
      Cookie: `${HUB_PASSWORD_COOKIE_NAME}=${conatPassword}`,
    },
    ...rest,
  });
  const combinedRoute =
    routeSubject == null
      ? (subject: string) => {
          const routed = routeProjectSubject(subject);
          return routeTargetToClient(subject, routed, account_id);
        }
      : (subject: string) => {
          const custom = routeSubject(subject);
          if (custom) return custom;
          const routed = routeProjectSubject(subject);
          return routeTargetToClient(subject, routed, account_id);
        };
  client.setRouteSubject(combinedRoute);
  return client;
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
