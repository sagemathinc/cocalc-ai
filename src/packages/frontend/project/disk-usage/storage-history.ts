import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";
import {
  getStorageHistory as getProjectStorageHistory,
  type ProjectStorageHistory,
} from "@cocalc/conat/project/storage-info";

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
  const client = await webapp_client.conat_client.projectConat({
    project_id,
    caller: "getStorageHistory",
  });
  const history = await getProjectStorageHistory({
    client,
    project_id,
    window_minutes,
    max_points,
  });
  storageHistoryCache.set(k, history);
  return history;
}
