import { getSnapshotUsage as getProjectSnapshotUsage } from "@cocalc/conat/project/storage-info";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";

const snapshotUsageCache = new TTLCache<string, SnapshotUsage[]>({
  ttl: 1000 * 60,
});

export function key({ project_id }: { project_id: string }) {
  return `${project_id}-0`;
}

export default async function getSnapshotUsage({
  project_id,
  cache = true,
}: {
  project_id: string;
  cache?: boolean;
}): Promise<SnapshotUsage[]> {
  const k = key({ project_id });
  if (cache && snapshotUsageCache.has(k)) {
    return snapshotUsageCache.get(k)!;
  }
  const usage = await getProjectSnapshotUsage({
    client: webapp_client.conat_client.conat(),
    project_id,
  });
  snapshotUsageCache.set(k, usage);
  return usage;
}
