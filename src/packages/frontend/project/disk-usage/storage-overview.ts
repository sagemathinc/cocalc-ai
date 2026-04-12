import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";
import {
  getStorageOverview as getProjectStorageOverview,
  type ProjectStorageOverview,
} from "@cocalc/conat/project/storage-info";

const storageOverviewCache = new TTLCache<string, ProjectStorageOverview>({
  ttl: 1000 * 30,
});

export function key({
  project_id,
  home,
}: {
  project_id: string;
  home: string;
}) {
  return `${project_id}:${home}`;
}

export default async function getStorageOverview({
  project_id,
  home,
  cache = true,
  force_sample = false,
}: {
  project_id: string;
  home: string;
  cache?: boolean;
  force_sample?: boolean;
}): Promise<ProjectStorageOverview> {
  const k = key({ project_id, home });
  if (cache && storageOverviewCache.has(k)) {
    return storageOverviewCache.get(k)!;
  }
  const overview = await getProjectStorageOverview({
    client: webapp_client.conat_client.conat(),
    project_id,
    home,
    force_sample,
  });
  storageOverviewCache.set(k, overview);
  return overview;
}
