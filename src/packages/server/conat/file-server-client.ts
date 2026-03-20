import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import type { Client } from "@cocalc/conat/core/client";
import { conatWithProjectRouting } from "./route-client";
import { materializeProjectHost } from "./route-project";

let routedClient: Client | undefined;

function getRoutedClient(): Client {
  routedClient ??= conatWithProjectRouting();
  return routedClient;
}

export async function ensureProjectFileServerRoute(
  project_id: string,
): Promise<string> {
  const address = await materializeProjectHost(project_id);
  if (!address) {
    throw new Error(`unable to route project ${project_id} to a host`);
  }
  return address;
}

export async function getProjectFileServerClient({
  project_id,
  timeout,
  ensure_route = true,
}: {
  project_id: string;
  timeout?: number;
  ensure_route?: boolean;
}): Promise<Fileserver> {
  if (ensure_route) {
    await ensureProjectFileServerRoute(project_id);
  }
  return fileServerClient({
    client: getRoutedClient(),
    project_id,
    timeout,
  });
}
