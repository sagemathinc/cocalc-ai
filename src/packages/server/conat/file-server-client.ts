import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import type { Client } from "@cocalc/conat/core/client";
import { conatWithProjectRouting } from "./route-client";
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
    client: getRoutedClient(),
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
