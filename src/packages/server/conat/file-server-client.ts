import {
  client as fileServerClient,
  type Fileserver,
} from "@cocalc/conat/files/file-server";
import { materializeProjectHost } from "./route-project";

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
  return fileServerClient({ project_id, timeout });
}
