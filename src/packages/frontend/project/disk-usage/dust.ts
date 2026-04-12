import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getStorageBreakdown as getProjectStorageBreakdown,
  type ProjectStorageBreakdown,
} from "@cocalc/conat/project/storage-info";
import TTLCache from "@isaacs/ttlcache";

const dustCache = new TTLCache<string, ProjectStorageBreakdown>({
  ttl: 1000 * 30,
});

export function key({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}) {
  return `${project_id}-0-${path}`;
}

export default async function dust({
  project_id,
  path = "/",
  cache = true,
}: {
  project_id: string;
  path?: string;
  cache?: boolean;
}) {
  const k = key({ project_id, path });
  if (cache && dustCache.has(k)) {
    return dustCache.get(k)!;
  }
  const v = await getProjectStorageBreakdown({
    client: webapp_client.conat_client.conat(),
    project_id,
    path,
  });
  dustCache.set(k, v);
  return v;
}
