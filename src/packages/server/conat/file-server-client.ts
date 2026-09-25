import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import {
  fsClient,
  fsSubject,
  shareFsSubject,
  type FilesystemClient,
} from "@cocalc/conat/files/fs";
import type { Client } from "@cocalc/conat/core/client";
import {
  conatWithProjectRouting,
  conatWithProjectRoutingForAccount,
  getExplicitProjectHostRoutedHubClient,
  getExplicitProjectRoutedClient,
} from "./route-client";
import {
  materializeProjectHostTarget,
  materializeRemoteProjectHostTarget,
} from "./route-project";

let routedClient: Client | undefined;

type FileserverServiceClient = Fileserver & {
  conat?: {
    ping: (opts?: { maxWait?: number }) => Promise<void>;
  };
};

function getRoutedClient(): Client {
  routedClient ??= conatWithProjectRouting();
  return routedClient;
}

async function getProjectConatClient({
  project_id,
  account_id,
  ensure_route = true,
  fresh = true,
  hub_only = false,
}: {
  project_id: string;
  account_id?: string;
  ensure_route?: boolean;
  fresh?: boolean;
  hub_only?: boolean;
}): Promise<Client> {
  if (!ensure_route) {
    return getRoutedClient();
  }
  const target = await resolveProjectFileServerTarget({
    project_id,
    account_id,
    fresh,
  });
  if (!target?.address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  if (hub_only) {
    return getExplicitProjectHostRoutedHubClient({
      host_id: target.host_id,
      address: target.address,
      host_session_id: target.host_session_id,
    });
  }
  return target.local
    ? await getExplicitProjectRoutedClient({ project_id, fresh, account_id })
    : account_id
      ? conatWithProjectRoutingForAccount({ account_id })
      : getRoutedClient();
}

async function resolveProjectFileServerTarget({
  project_id,
  account_id,
  fresh = true,
}: {
  project_id: string;
  account_id?: string;
  fresh?: boolean;
}): Promise<
  | {
      address: string;
      host_id: string;
      host_session_id?: string;
      local: boolean;
    }
  | undefined
> {
  const local = await materializeProjectHostTarget(project_id, {
    fresh,
  });
  if (local?.address && local.host_id) {
    return { ...local, local: true };
  }
  if (!account_id) {
    return;
  }
  const remote = await materializeRemoteProjectHostTarget({
    account_id,
    project_id,
  });
  if (remote?.address && remote.host_id) {
    return { ...remote, local: false };
  }
}

export async function ensureProjectFileServerRoute(
  project_id: string,
  account_id?: string,
): Promise<string> {
  const target = await resolveProjectFileServerTarget({
    project_id,
    account_id,
    fresh: true,
  });
  if (!target?.address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  return target.address;
}

// For trusted server-side work after the caller has authorized project access.
// The route discovery remains account-scoped, but the direct host connection
// uses the server's short-lived hub principal.
export async function getTrustedProjectHostClient({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<Client> {
  return await getProjectConatClient({
    project_id,
    account_id,
    hub_only: true,
  });
}

export async function getProjectFileServerClient({
  project_id,
  account_id,
  timeout,
  ensure_route = true,
  fresh = true,
}: {
  project_id: string;
  account_id?: string;
  timeout?: number;
  ensure_route?: boolean;
  fresh?: boolean;
}): Promise<Fileserver> {
  const conatClient = await getProjectConatClient({
    project_id,
    account_id,
    ensure_route,
    fresh,
    hub_only: true,
  });
  // File-server management is server-only. account_id is used to authorize and
  // discover cross-bay placement, but the direct host connection always uses a
  // short-lived hub principal.
  return fileServerClient({
    client: conatClient,
    project_id,
    timeout,
    waitForInterest: true,
  });
}

export async function getProjectFsClient({
  project_id,
  account_id,
  timeout,
  ensure_route = true,
  fresh = true,
}: {
  project_id: string;
  account_id?: string;
  timeout?: number;
  ensure_route?: boolean;
  fresh?: boolean;
}): Promise<FilesystemClient> {
  const conatClient = await getProjectConatClient({
    project_id,
    account_id,
    ensure_route,
    fresh,
  });
  return fsClient({
    client: conatClient,
    subject: fsSubject({ project_id }),
    timeout,
    waitForInterest: true,
  });
}

export async function getProjectShareFsClient({
  project_id,
  share_id,
  account_id,
  timeout,
  ensure_route = true,
  fresh = true,
}: {
  project_id: string;
  share_id: string;
  account_id: string;
  timeout?: number;
  ensure_route?: boolean;
  fresh?: boolean;
}): Promise<FilesystemClient> {
  const conatClient = await getProjectConatClient({
    project_id,
    account_id,
    ensure_route,
    fresh,
  });
  return fsClient({
    client: conatClient,
    subject: shareFsSubject({ project_id, share_id, account_id }),
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
