import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import {
  fsClient,
  fsSubject,
  type FilesystemClient,
} from "@cocalc/conat/files/fs";
import type { Client } from "@cocalc/conat/core/client";
import {
  conatWithProjectRouting,
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
}: {
  project_id: string;
  account_id?: string;
  ensure_route?: boolean;
  fresh?: boolean;
}): Promise<Client> {
  if (!ensure_route) {
    return getRoutedClient();
  }
  const target = await resolveProjectFileServerTarget({
    project_id,
    account_id,
  });
  if (!target?.address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  return target.local
    ? await getExplicitProjectRoutedClient({ project_id, fresh })
    : getRoutedClient();
}

async function resolveProjectFileServerTarget({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id?: string;
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
    fresh: true,
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
  });
  if (!target?.address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  return target.address;
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
  });
  // File-server is a server-only service. account_id is used above only to
  // discover a remote project route after caller-side permission checks.
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
