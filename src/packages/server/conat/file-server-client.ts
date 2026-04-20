import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import type { Client } from "@cocalc/conat/core/client";
import {
  conatWithProjectRouting,
  conatWithProjectRoutingForAccount,
} from "./route-client";
import {
  materializeProjectHostTarget,
  materializeRemoteProjectHostTarget,
} from "./route-project";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveHostBayAcrossCluster } from "@cocalc/server/inter-bay/directory";

let routedClient: Client | undefined;
const routedAccountClients = new Map<string, Client>();
const ROUTE_AUTH_SYNC_TTL_MS = 30_000;
const routeAuthSyncCache = new Map<
  string,
  { expiresAt: number; inFlight?: Promise<void> }
>();

type FileserverServiceClient = Fileserver & {
  conat?: {
    ping: (opts?: { maxWait?: number }) => Promise<void>;
  };
};

function getRoutedClient(account_id?: string): Client {
  if (account_id) {
    let client = routedAccountClients.get(account_id);
    if (!client) {
      client = conatWithProjectRoutingForAccount({ account_id });
      routedAccountClients.set(account_id, client);
    }
    return client;
  }
  routedClient ??= conatWithProjectRouting();
  return routedClient;
}

async function ensureProjectHostAccountRouteReady({
  account_id,
  project_id,
  host_id,
  host_session_id,
}: {
  account_id?: string;
  project_id: string;
  host_id: string;
  host_session_id?: string;
}): Promise<void> {
  if (!account_id) {
    return;
  }
  const key = `${account_id}:${project_id}:${host_id}:${host_session_id ?? ""}`;
  const now = Date.now();
  const cached = routeAuthSyncCache.get(key);
  if (cached?.expiresAt && now < cached.expiresAt) {
    if (cached.inFlight) {
      await cached.inFlight;
    }
    return;
  }
  if (cached?.inFlight) {
    await cached.inFlight;
    return;
  }

  const entry = {
    expiresAt: 0,
    inFlight: undefined as Promise<void> | undefined,
  };
  entry.inFlight = (async () => {
    const ownership = await resolveHostBayAcrossCluster(host_id);
    await getInterBayBridge()
      .projectHostAuthToken(ownership?.bay_id ?? getConfiguredBayId(), {
        timeout_ms: 15_000,
      })
      .issue({
        account_id,
        host_id,
        project_id,
        ttl_seconds: 60,
      });
    entry.expiresAt = Date.now() + ROUTE_AUTH_SYNC_TTL_MS;
  })();
  routeAuthSyncCache.set(key, entry);
  try {
    await entry.inFlight;
  } finally {
    delete entry.inFlight;
    if (!entry.expiresAt) {
      routeAuthSyncCache.delete(key);
    }
  }
}

export async function ensureProjectFileServerRoute(
  project_id: string,
  account_id?: string,
): Promise<string> {
  const target =
    (await materializeProjectHostTarget(project_id, {
      fresh: true,
    })) ??
    (account_id
      ? await materializeRemoteProjectHostTarget({
          account_id,
          project_id,
        })
      : undefined);
  if (!target?.address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  await ensureProjectHostAccountRouteReady({
    account_id,
    project_id,
    host_id: target.host_id,
    host_session_id: target.host_session_id,
  });
  return target.address;
}

export async function getProjectFileServerClient({
  project_id,
  account_id,
  timeout,
  ensure_route = true,
}: {
  project_id: string;
  account_id?: string;
  timeout?: number;
  ensure_route?: boolean;
}): Promise<Fileserver> {
  if (ensure_route) {
    await ensureProjectFileServerRoute(project_id, account_id);
  }
  return fileServerClient({
    client: getRoutedClient(account_id),
    project_id,
    timeout,
    waitForInterest: true,
  });
}

export async function ensureProjectFileServerClientReady({
  project_id,
  client,
  maxWait = 30_000,
}: {
  project_id: string;
  client: Fileserver;
  maxWait?: number;
}): Promise<void> {
  const serviceClient = client as FileserverServiceClient;
  if (typeof serviceClient?.conat?.ping !== "function") {
    return;
  }
  try {
    await serviceClient.conat.ping({ maxWait });
  } catch (err) {
    throw new Error(
      `project file-server service for ${project_id} is not responding: ${err}`,
    );
  }
}
