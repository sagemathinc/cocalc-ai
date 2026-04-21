import {
  getDiskQuota as getProjectDiskQuota,
  type ProjectDiskQuota,
} from "@cocalc/conat/project/storage-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";

export type DiskQuota = ProjectDiskQuota;

const quotaCache = new TTLCache<string, DiskQuota>({
  ttl: 1000 * 60,
});

export function key({ project_id }: { project_id: string }) {
  return `${project_id}-0`;
}

export default async function quota({
  project_id,
  cache = true,
}: {
  project_id: string;
  cache?: boolean;
}): Promise<DiskQuota> {
  const k = key({ project_id });
  if (cache && quotaCache.has(k)) {
    return quotaCache.get(k)!;
  }
  const client = await webapp_client.conat_client.projectConat({
    project_id,
    caller: "quota",
  });
  const x = await getProjectDiskQuota({
    client,
    project_id,
  });
  quotaCache.set(k, x);
  return x;
}
