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
  address: string;
  client: Client;
  host_session_id?: string;
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

function evictRoutedHubClient(
  host_id: string,
  expected?: RoutedHubClientState,
): void {
  const current = routedHubClients[host_id];
  if (!current) return;
  if (expected != null && current !== expected) return;
  delete routedHubClients[host_id];
  try {
    current.client.close();
  } catch {
    // ignore close errors
  }
}

function issueHubRouteToken(host_id: string): {
  token: string;
  expiresAt: number;
} {
  const { token, expires_at } = issueProjectHostAuthToken({
    host_id,
    actor: "hub",
    hub_id: "hub",
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
  state.inFlight = Promise.resolve().then(() => {
    const { token, expiresAt } = issueHubRouteToken(host_id);
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

function getOrCreateRoutedHubClient({
  host_id,
  address,
  host_session_id,
}: {
  host_id: string;
  address: string;
  host_session_id?: string;
}): Client {
  const existing = routedHubClients[host_id];
  if (
    existing?.address === address &&
    existing?.host_session_id === host_session_id
  ) {
    return existing.client;
  }
  if (existing) {
    evictRoutedHubClient(host_id, existing);
  }
  const state: RoutedHubClientState = {
    address,
    host_session_id,
    client: undefined as unknown as Client,
  };
  state.client = connect({
    // Routed host clients already have explicit lifecycle via routedHubClients,
    // so they must not share the global Conat cache or socket.io manager state.
    noCache: true,
    forceNew: true,
    address,
    inboxPrefix: inboxPrefix({ hub_id: "hub" }),
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
        if (routedHubClients[host_id] !== state) {
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
    evictRoutedHubClient(host_id, state);
  });
  routedHubClients[host_id] = state;
  return state.client;
}

function routeTargetToClient(target?: {
  address?: string;
  host_id?: string;
  host_session_id?: string;
}): RoutedTarget | undefined {
  if (!target?.address || !target.host_id) {
    return target;
  }
  return {
    client: getOrCreateRoutedHubClient({
      host_id: target.host_id,
      address: target.address,
      host_session_id: target.host_session_id,
    }),
  };
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

export function conatWithProjectRouting(options?: ClientOptions): Client {
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
          return routeTargetToClient(routed);
        }
      : (subject: string) => {
          const custom = routeSubject(subject);
          if (custom) return custom;
          const routed = routeProjectSubject(subject);
          return routeTargetToClient(routed);
        };
  client.setRouteSubject(combinedRoute);
  return client;
}
