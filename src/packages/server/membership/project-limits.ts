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
import { humanSize } from "@cocalc/util/misc";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveMembershipForAccount } from "./resolve";
import {
  getMembershipUsageStatusForAccount,
  peekCachedMembershipUsageStatusForAccount,
} from "./usage-status";

const log = getLogger("server:membership:project-limits");

export const DEFAULT_MAX_SNAPSHOTS_PER_PROJECT = 250;
export const DEFAULT_MAX_BACKUPS_PER_PROJECT = 30;

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
  return getEffectiveMembershipUsageLimits(resolution).max_projects;
}

function extractMaxSnapshotsPerProject(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution)
    .max_snapshots_per_project;
}

function extractMaxBackupsPerProject(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution).max_backups_per_project;
}

async function getProjectOwnerLimit({
  project_id,
  resolution,
  fallback,
  extract,
}: {
  project_id: string;
  resolution?: MembershipResolution;
  fallback: number;
  extract: (resolution: MembershipResolution) => number | undefined;
}): Promise<number> {
  const account_id = await getProjectOwnerAccountId(project_id);
  if (!account_id) {
    return fallback;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  return extract(effectiveResolution) ?? fallback;
}

export async function getProjectSnapshotLimit({
  project_id,
  resolution,
}: {
  project_id: string;
  resolution?: MembershipResolution;
}): Promise<number> {
  return await getProjectOwnerLimit({
    project_id,
    resolution,
    fallback: DEFAULT_MAX_SNAPSHOTS_PER_PROJECT,
    extract: extractMaxSnapshotsPerProject,
  });
}

export async function getProjectBackupLimit({
  project_id,
  resolution,
}: {
  project_id: string;
  resolution?: MembershipResolution;
}): Promise<number> {
  return await getProjectOwnerLimit({
    project_id,
    resolution,
    fallback: DEFAULT_MAX_BACKUPS_PER_PROJECT,
    extract: extractMaxBackupsPerProject,
  });
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
  return getEffectiveMembershipUsageLimits(resolution).total_storage_hard_bytes;
}

function extractTotalStorageSoftBytes(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution).total_storage_soft_bytes;
}

type AccountStorageBlockState = "ok" | "soft" | "hard";

function getAccountStorageBlockState({
  total_storage_bytes,
  resolution,
}: {
  total_storage_bytes: number;
  resolution: MembershipResolution;
}): {
  state: AccountStorageBlockState;
  soft_cap_bytes?: number;
  hard_cap_bytes?: number;
} {
  const soft_cap_bytes = extractTotalStorageSoftBytes(resolution);
  const hard_cap_bytes = extractTotalStorageHardBytes(resolution);
  if (
    hard_cap_bytes != null &&
    Number.isFinite(hard_cap_bytes) &&
    total_storage_bytes >= hard_cap_bytes
  ) {
    return {
      state: "hard",
      soft_cap_bytes,
      hard_cap_bytes,
    };
  }
  if (
    soft_cap_bytes != null &&
    Number.isFinite(soft_cap_bytes) &&
    total_storage_bytes >= soft_cap_bytes
  ) {
    return {
      state: "soft",
      soft_cap_bytes,
      hard_cap_bytes,
    };
  }
  return {
    state: "ok",
    soft_cap_bytes,
    hard_cap_bytes,
  };
}

export async function assertCanIncreaseAccountStorage({
  account_id,
  resolution,
  cache_only = false,
}: {
  account_id: string;
  resolution?: MembershipResolution;
  cache_only?: boolean;
}): Promise<void> {
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const total_storage_soft_bytes =
    extractTotalStorageSoftBytes(effectiveResolution);
  const total_storage_hard_bytes =
    extractTotalStorageHardBytes(effectiveResolution);
  if (total_storage_soft_bytes == null && total_storage_hard_bytes == null) {
    return;
  }
  const usage = cache_only
    ? peekCachedMembershipUsageStatusForAccount({
        account_id,
        resolution: effectiveResolution,
      })
    : await getMembershipUsageStatusForAccount({
        account_id,
        resolution: effectiveResolution,
      });
  if (usage == null) {
    return;
  }
  const state = getAccountStorageBlockState({
    total_storage_bytes: usage.total_storage_bytes,
    resolution: effectiveResolution,
  });
  if (state.state === "hard") {
    throw new Error(
      `total account storage hard cap reached (${humanSize(usage.total_storage_bytes)} of ${humanSize(state.hard_cap_bytes ?? total_storage_hard_bytes ?? 0)}); storage-increasing operations are blocked until you delete data or upgrade membership`,
    );
  }
  if (state.state === "soft") {
    throw new Error(
      `total account storage soft cap reached (${humanSize(usage.total_storage_bytes)} of ${humanSize(state.soft_cap_bytes ?? total_storage_soft_bytes ?? 0)}); storage-increasing operations are blocked until you delete data or upgrade membership`,
    );
  }
}

export async function assertProjectOwnerCanIncreaseAccountStorage({
  project_id,
  resolution,
}: {
  project_id: string;
  resolution?: MembershipResolution;
}): Promise<void> {
  const account_id = await getProjectOwnerAccountId(project_id);
  if (!account_id) {
    return;
  }
  await assertCanIncreaseAccountStorage({
    account_id,
    resolution,
  });
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
  const total_storage_soft_bytes =
    extractTotalStorageSoftBytes(effectiveResolution);
  const total_storage_hard_bytes =
    extractTotalStorageHardBytes(effectiveResolution);
  if (total_storage_soft_bytes == null && total_storage_hard_bytes == null) {
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
  const state = getAccountStorageBlockState({
    total_storage_bytes: projected_total,
    resolution: effectiveResolution,
  });
  if (state.state === "hard") {
    throw new Error(
      `restoring this archived project would exceed the total account storage hard cap (${humanSize(usage.total_storage_bytes)} current + ${humanSize(estimated_restore_bytes)} estimated restore > ${humanSize(total_storage_hard_bytes)} cap); archive/delete data or upgrade membership`,
    );
  }
  if (state.state === "soft") {
    throw new Error(
      `restoring this archived project would exceed the total account storage soft cap (${humanSize(usage.total_storage_bytes)} current + ${humanSize(estimated_restore_bytes)} estimated restore > ${humanSize(state.soft_cap_bytes ?? total_storage_soft_bytes ?? 0)} cap); archive/delete data or upgrade membership`,
    );
  }
}
