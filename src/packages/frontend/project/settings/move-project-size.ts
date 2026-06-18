/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getStorageHistory from "@cocalc/frontend/project/disk-usage/storage-history";
import getStorageOverview from "@cocalc/frontend/project/disk-usage/storage-overview";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

const STORAGE_HISTORY_WINDOW_MINUTES = 35 * 24 * 60;
const STORAGE_HISTORY_MAX_POINTS = 512;

function finiteNonnegativeBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function latestQuotaUsedBytesFromHistory(history: {
  points?: { quota_used_bytes?: number }[];
}): number | undefined {
  const points = Array.isArray(history.points) ? history.points : [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const bytes = finiteNonnegativeBytes(points[i]?.quota_used_bytes);
    if (bytes != null) return bytes;
  }
  return undefined;
}

export async function loadProjectMoveSizeBytes({
  project_id,
}: {
  project_id: string;
}): Promise<number | undefined> {
  const home = getProjectHomeDirectory(project_id);

  try {
    const overview = await getStorageOverview({
      project_id,
      home,
      cache: true,
    });
    const projectQuota =
      overview.quotas.find((quota) => quota.key === "project") ??
      overview.quotas[0];
    const bytes = finiteNonnegativeBytes(projectQuota?.used);
    if (bytes != null) return bytes;
  } catch {
    // Fall through to persisted storage history; move estimates are best effort.
  }

  try {
    const history = await getStorageHistory({
      project_id,
      window_minutes: STORAGE_HISTORY_WINDOW_MINUTES,
      max_points: STORAGE_HISTORY_MAX_POINTS,
      cache: true,
    });
    return latestQuotaUsedBytesFromHistory(history);
  } catch {
    return undefined;
  }
}
