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
  routeProjectSubject,
  listenForUpdates as listenForProjectHostUpdates,
} from "./route-project";

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
  token?: string;
  expiresAt?: number;
  inFlight?: Promise<string>;
};

const routedHubClients: Record<string, RoutedHubClientState> = {};

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
}: {
  host_id: string;
  address: string;
}): Client {
  const existing = routedHubClients[host_id];
  if (existing?.address === address) {
    return existing.client;
  }
  if (existing) {
    evictRoutedHubClient(host_id, existing);
  }
  const state: RoutedHubClientState = {
    address,
    client: connect({
      address,
      inboxPrefix: inboxPrefix({ hub_id: "hub" }),
      auth: async (cb) => {
        try {
          const token = await getHubRouteToken(host_id, state);
          cb({ bearer: token });
        } catch {
          cb({});
        }
      },
      reconnection: false,
    }),
  };
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
          if (!routed?.address || !routed.host_id) {
            return routed;
          }
          return {
            client: getOrCreateRoutedHubClient({
              host_id: routed.host_id,
              address: routed.address,
            }),
          };
        }
      : (subject: string) => {
          const custom = routeSubject(subject);
          if (custom) return custom;
          const routed = routeProjectSubject(subject);
          if (!routed?.address || !routed.host_id) {
            return routed;
          }
          return {
            client: getOrCreateRoutedHubClient({
              host_id: routed.host_id,
              address: routed.address,
            }),
          };
        };
  client.setRouteSubject(combinedRoute);
  return client;
}
