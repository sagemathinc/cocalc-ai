import { webapp_client } from "@cocalc/frontend/webapp-client";
import TTLCache from "@isaacs/ttlcache";
import {
  getStorageOverview as getProjectStorageOverview,
  type ProjectStorageOverview,
} from "@cocalc/conat/project/storage-info";
import { withTimeout } from "@cocalc/util/async-utils";

const STORAGE_OVERVIEW_REQUEST_TIMEOUT_MS = 15_000;

const storageOverviewCache = new TTLCache<string, ProjectStorageOverview>({
  ttl: 3 * 60 * 1000,
});
const storageOverviewInflight = new Map<
  string,
  Promise<ProjectStorageOverview>
>();

export function key({
  project_id,
  home,
}: {
  project_id: string;
  home: string;
}) {
  return `${project_id}:${home}`;
}

export function getCachedStorageOverview({
  project_id,
  home,
}: {
  project_id: string;
  home: string;
}): ProjectStorageOverview | undefined {
  return storageOverviewCache.get(key({ project_id, home }));
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
  const inflight = storageOverviewInflight.get(k);
  if (inflight) return await inflight;
  const request = withTimeout(
    (async () => {
      const client = await webapp_client.conat_client.projectConat({
        project_id,
        caller: "getStorageOverview",
      });
      return await getProjectStorageOverview({
        client,
        project_id,
        home,
        force_sample,
      });
    })(),
    STORAGE_OVERVIEW_REQUEST_TIMEOUT_MS,
  );
  storageOverviewInflight.set(k, request);
  try {
    const overview = await request;
    storageOverviewCache.set(k, overview);
    return overview;
  } finally {
    if (storageOverviewInflight.get(k) === request) {
      storageOverviewInflight.delete(k);
    }
  }
}
