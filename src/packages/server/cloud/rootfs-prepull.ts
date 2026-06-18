/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import { enqueueCloudVmWorkOnce } from "./db";

const pool = () => getPool();

export const ROOTFS_PREPULL_SITE_SETTINGS = new Set([
  "project_rootfs_default_image",
  "project_rootfs_default_image_gpu",
  "project_rootfs_prepull_images",
]);

export function isRootfsPrepullSiteSetting(name: string): boolean {
  return ROOTFS_PREPULL_SITE_SETTINGS.has(`${name ?? ""}`.trim());
}

export async function enqueueRootfsPrepullForHost({
  row,
  source,
  reason,
}: {
  row: any;
  source: string;
  reason?: string;
}): Promise<string | undefined> {
  return await enqueueCloudVmWorkOnce({
    vm_id: row.id,
    action: "prepull_rootfs",
    payload: {
      source,
      reason,
      provider: normalizeProviderId(row.metadata?.machine?.cloud),
      host_last_seen: row.last_seen
        ? new Date(row.last_seen as any).toISOString()
        : undefined,
    },
  });
}

export async function enqueueRootfsPrepullForRunningHosts({
  source,
  reason,
  limit = 5000,
}: {
  source: string;
  reason?: string;
  limit?: number;
}): Promise<{ considered: number; enqueued: number }> {
  const normalizedLimit =
    Number.isFinite(limit) && limit > 0
      ? Math.max(1, Math.min(50_000, Math.floor(limit)))
      : 5000;
  const { rows } = await pool().query(
    `
      SELECT id, metadata, last_seen
        FROM project_hosts
       WHERE deleted IS NULL
         AND status IN ('running', 'active')
       ORDER BY last_seen DESC NULLS LAST, id ASC
       LIMIT $1
    `,
    [normalizedLimit],
  );
  let enqueued = 0;
  for (const row of rows) {
    if (
      await enqueueRootfsPrepullForHost({
        row,
        source,
        reason,
      })
    ) {
      enqueued += 1;
    }
  }
  return { considered: rows.length, enqueued };
}
