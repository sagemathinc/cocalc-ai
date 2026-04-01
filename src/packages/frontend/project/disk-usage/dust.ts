import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ProjectStorageBreakdown } from "@cocalc/conat/hub/api/projects";
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
  const v = await webapp_client.conat_client.hub.projects.getStorageBreakdown({
    project_id,
    path,
  });
  dustCache.set(k, v);
  return v;
}
