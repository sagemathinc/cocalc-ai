import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getStorageBreakdown as getProjectStorageBreakdown,
  type ProjectStorageBreakdown,
} from "@cocalc/conat/project/storage-info";
import TTLCache from "@isaacs/ttlcache";

const dustCache = new TTLCache<string, ProjectStorageBreakdown>({
  ttl: 3 * 60 * 1000,
});
const dustInflight = new Map<string, Promise<ProjectStorageBreakdown>>();

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
  const inflight = dustInflight.get(k);
  if (inflight) return await inflight;
  const request = (async () => {
    const client = await webapp_client.conat_client.projectConat({
      project_id,
      caller: "dust",
    });
    return await getProjectStorageBreakdown({
      client,
      project_id,
      path,
    });
  })();
  dustInflight.set(k, request);
  try {
    const v = await request;
    dustCache.set(k, v);
    return v;
  } finally {
    if (dustInflight.get(k) === request) {
      dustInflight.delete(k);
    }
  }
}
