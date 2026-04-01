import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";
import type { ProjectStorageHistory } from "@cocalc/conat/hub/api/projects";

const storageHistoryCache = new TTLCache<string, ProjectStorageHistory>({
  ttl: 1000 * 30,
});

export function key({
  project_id,
  window_minutes,
  max_points,
}: {
  project_id: string;
  window_minutes: number;
  max_points: number;
}) {
  return `${project_id}:${window_minutes}:${max_points}`;
}

export default async function getStorageHistory({
  project_id,
  window_minutes,
  max_points,
  cache = true,
}: {
  project_id: string;
  window_minutes: number;
  max_points: number;
  cache?: boolean;
}): Promise<ProjectStorageHistory> {
  const k = key({ project_id, window_minutes, max_points });
  if (cache && storageHistoryCache.has(k)) {
    return storageHistoryCache.get(k)!;
  }
  const history =
    await webapp_client.conat_client.hub.projects.getStorageHistory({
      project_id,
      window_minutes,
      max_points,
    });
  storageHistoryCache.set(k, history);
  return history;
}
