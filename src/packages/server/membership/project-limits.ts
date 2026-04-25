/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import {
  getStorageHistory,
  type ProjectStorageHistory,
} from "@cocalc/conat/project/storage-info";
import {
  getBackups,
  type BackupSummary,
} from "@cocalc/conat/project/archive-info";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { conatWithProjectRoutingForAccount } from "@cocalc/server/conat/route-client";
import { resolveMembershipForAccount } from "./resolve";
import { getMembershipUsageStatusForAccount } from "./usage-status";

const log = getLogger("server:membership:project-limits");

export async function getOwnedProjectCountForAccount(
  account_id: string,
): Promise<number> {
  const { rows } = await getPool("medium").query<{ count: string | number }>(
    `
      SELECT COUNT(*)::BIGINT AS count
      FROM projects
      WHERE deleted IS NULL
        AND COALESCE(users -> $1::text ->> 'group', '') = 'owner'
    `,
    [account_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export async function getProjectOwnerAccountId(
  project_id: string,
): Promise<string | undefined> {
  const { rows } = await getPool("medium").query<{ account_id: string }>(
    `
      SELECT account_id_text::text AS account_id
      FROM projects
      CROSS JOIN LATERAL jsonb_each(COALESCE(users, '{}'::jsonb)) AS u(account_id_text, user_data)
      WHERE project_id = $1
        AND deleted IS NULL
        AND COALESCE(u.user_data ->> 'group', '') = 'owner'
      LIMIT 1
    `,
    [project_id],
  );
  return `${rows[0]?.account_id ?? ""}`.trim() || undefined;
}

async function getProjectStorageQuotaFallbackBytes(
  project_id: string,
): Promise<number | undefined> {
  const { rows } = await getPool("medium").query<{
    run_quota: { disk_quota?: number | string } | null;
    settings: { disk_quota?: number | string } | null;
  }>(
    `
      SELECT run_quota, settings
      FROM projects
      WHERE project_id = $1
        AND deleted IS NULL
      LIMIT 1
    `,
    [project_id],
  );
  const diskQuotaMb = Number(
    rows[0]?.run_quota?.disk_quota ?? rows[0]?.settings?.disk_quota,
  );
  if (!Number.isFinite(diskQuotaMb) || diskQuotaMb <= 0) {
    return undefined;
  }
  return Math.floor(diskQuotaMb * 1_000_000);
}

function estimateBytesFromStorageHistory(
  history: ProjectStorageHistory,
): number | undefined {
  for (let i = history.points.length - 1; i >= 0; i -= 1) {
    const used = history.points[i]?.quota_used_bytes;
    if (typeof used === "number" && Number.isFinite(used) && used > 0) {
      return Math.floor(used);
    }
  }
  return undefined;
}

function estimateBytesFromBackupSummary(
  backup: BackupSummary | undefined,
): number | undefined {
  const summary = backup?.summary ?? {};
  const candidates = [
    summary.total_bytes_processed,
    summary.total_bytes,
    summary.data_processed,
    summary.data_added,
    summary.data_added_packed,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.floor(Math.max(...candidates));
}

export async function estimateProvisionedRestoreBytesForProject({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id: string;
}): Promise<number | undefined> {
  const client = conatWithProjectRoutingForAccount({ account_id });
  try {
    try {
      const history = await getStorageHistory({
        client,
        project_id,
        window_minutes: 35 * 24 * 60,
        max_points: 512,
      });
      const historyEstimate = estimateBytesFromStorageHistory(history);
      if (historyEstimate != null) {
        return historyEstimate;
      }
    } catch (err) {
      log.debug("restore-size estimate: storage history unavailable", {
        account_id,
        project_id,
        err: `${err}`,
      });
    }

    try {
      const backups = await getBackups({
        client,
        project_id,
      });
      const latest = backups
        .slice()
        .sort((a, b) => b.time.valueOf() - a.time.valueOf())[0];
      const backupEstimate = estimateBytesFromBackupSummary(latest);
      if (backupEstimate != null) {
        return backupEstimate;
      }
    } catch (err) {
      log.debug("restore-size estimate: backup summary unavailable", {
        account_id,
        project_id,
        err: `${err}`,
      });
    }
  } finally {
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }

  return await getProjectStorageQuotaFallbackBytes(project_id);
}

function extractMaxProjects(
  resolution: MembershipResolution,
): number | undefined {
  const value = resolution.entitlements?.usage_limits?.max_projects;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export async function assertCanOwnAdditionalProject({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution?: MembershipResolution;
}): Promise<void> {
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const max_projects = extractMaxProjects(effectiveResolution);
  if (max_projects == null) {
    return;
  }
  const owned = await getOwnedProjectCountForAccount(account_id);
  if (owned >= max_projects) {
    throw new Error(
      `owned project limit reached (${owned}/${max_projects}); delete a project or upgrade membership`,
    );
  }
}

function extractTotalStorageHardBytes(
  resolution: MembershipResolution,
): number | undefined {
  const value = resolution.entitlements?.usage_limits?.total_storage_hard_bytes;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export async function assertCanIncreaseAccountStorage({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution?: MembershipResolution;
}): Promise<void> {
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const total_storage_hard_bytes =
    extractTotalStorageHardBytes(effectiveResolution);
  if (total_storage_hard_bytes == null) {
    return;
  }
  const usage = await getMembershipUsageStatusForAccount({
    account_id,
    resolution: effectiveResolution,
  });
  if (usage.total_storage_bytes >= total_storage_hard_bytes) {
    throw new Error(
      `total account storage hard cap reached (${formatBytes(usage.total_storage_bytes)} of ${formatBytes(total_storage_hard_bytes)}); delete data or upgrade membership`,
    );
  }
}

export async function assertCanRestoreProvisionedProjectStorage({
  project_id,
  account_id,
  resolution,
}: {
  project_id: string;
  account_id?: string;
  resolution?: MembershipResolution;
}): Promise<void> {
  const owner_account_id =
    account_id ?? (await getProjectOwnerAccountId(project_id));
  if (!owner_account_id) {
    return;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(owner_account_id));
  const total_storage_hard_bytes =
    extractTotalStorageHardBytes(effectiveResolution);
  if (total_storage_hard_bytes == null) {
    return;
  }
  const estimated_restore_bytes =
    await estimateProvisionedRestoreBytesForProject({
      project_id,
      account_id: owner_account_id,
    });
  if (
    estimated_restore_bytes == null ||
    !Number.isFinite(estimated_restore_bytes) ||
    estimated_restore_bytes <= 0
  ) {
    return;
  }
  const usage = await getMembershipUsageStatusForAccount({
    account_id: owner_account_id,
    resolution: effectiveResolution,
  });
  const projected_total = usage.total_storage_bytes + estimated_restore_bytes;
  if (projected_total > total_storage_hard_bytes) {
    throw new Error(
      `restoring this archived project would exceed the total account storage hard cap (${formatBytes(usage.total_storage_bytes)} current + ${formatBytes(estimated_restore_bytes)} estimated restore > ${formatBytes(total_storage_hard_bytes)} cap); archive/delete data or upgrade membership`,
    );
  }
}
