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
import { DEFAULT_MAX_PUBLIC_DIRECTORY_SHARES_PER_ACCOUNT } from "@cocalc/util/public-directory-share-labels";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveMembershipForAccount } from "./resolve";
import {
  getProjectOwnerAccountId,
  getProjectUsageAccountId,
  getUsageProjectCountForAccount,
} from "./project-usage";
import {
  getMembershipUsageStatusForAccount,
  peekCachedMembershipUsageStatusForAccount,
} from "./usage-status";

const log = getLogger("server:membership:project-limits");
let projectCollabInviteRoleSchemaReady: Promise<void> | undefined;

async function ensureProjectCollabInviteRoleSchema(): Promise<void> {
  projectCollabInviteRoleSchemaReady ??= (async () => {
    await getPool().query(`
      ALTER TABLE project_collab_invites
        ADD COLUMN IF NOT EXISTS invite_role VARCHAR(24)
    `);
  })();
  await projectCollabInviteRoleSchemaReady;
}

export {
  getProjectOwnerAccountId,
  getProjectUsageAccountId,
} from "./project-usage";

export const DEFAULT_MAX_SNAPSHOTS_PER_PROJECT = 250;
export const DEFAULT_MAX_BACKUPS_PER_PROJECT = 30;

export async function getOwnedProjectCountForAccount(
  account_id: string,
): Promise<number> {
  return await getUsageProjectCountForAccount(account_id);
}

async function getProjectStorageQuotaFallbackBytes(
  project_id: string,
): Promise<number | undefined> {
  const { rows } = await getPool("medium").query<{
    run_quota: { disk_quota?: number | string } | null;
  }>(
    `
      SELECT run_quota
      FROM projects
      WHERE project_id = $1
        AND deleted IS NULL
      LIMIT 1
    `,
    [project_id],
  );
  const diskQuotaMb = Number(rows[0]?.run_quota?.disk_quota);
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

function extractPublicDirectoryShareLimit(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution).public_directory_shares;
}

function extractProjectCollaboratorInviteLimit(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution)
    .project_max_collaborators_and_pending_invites;
}

function extractCourseStudentInviteLimit(
  resolution: MembershipResolution,
): number | undefined {
  return getEffectiveMembershipUsageLimits(resolution)
    .course_max_students_and_pending_invites;
}

export async function getProjectCollaboratorInviteLimit({
  project_id,
  resolution,
}: {
  project_id: string;
  resolution?: MembershipResolution;
}): Promise<number | undefined> {
  const account_id = await getProjectOwnerAccountId(project_id);
  if (!account_id) {
    return undefined;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  return extractProjectCollaboratorInviteLimit(effectiveResolution);
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
  const account_id = await getProjectUsageAccountId(project_id);
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

export async function getPublicDirectoryShareLimitForAccount({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution?: MembershipResolution;
}): Promise<number> {
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  return (
    extractPublicDirectoryShareLimit(effectiveResolution) ??
    DEFAULT_MAX_PUBLIC_DIRECTORY_SHARES_PER_ACCOUNT
  );
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
      `project limit reached (${owned}/${max_projects}); delete a project or upgrade membership`,
    );
  }
}

export async function getProjectCollaboratorsAndPendingInviteCount(
  project_id: string,
): Promise<number> {
  await ensureProjectCollabInviteRoleSchema();
  const pool = getPool("medium");
  const { rows } = await pool.query<{
    collaborators: string | number;
    pending_invites: string | number;
  }>(
    `
      WITH project_row AS (
        SELECT COALESCE(users, '{}'::jsonb) AS users
        FROM projects
        WHERE project_id = $1
          AND deleted IS NULL
        LIMIT 1
      )
      SELECT
        COALESCE((
          SELECT COUNT(*)
          FROM project_row p,
               jsonb_each(p.users) AS entry(account_id, value)
          WHERE entry.value ->> 'group' IN ('owner', 'collaborator')
        ), 0) AS collaborators,
        COALESCE((
          SELECT COUNT(*)
          FROM project_collab_invites
          WHERE project_id = $1
            AND status = 'pending'
            AND COALESCE(invite_role, 'collaborator') = 'collaborator'
        ), 0) AS pending_invites
    `,
    [project_id],
  );
  const row = rows[0];
  return Number(row?.collaborators ?? 0) + Number(row?.pending_invites ?? 0);
}

export async function getCourseStudentsAndPendingInviteCount(
  course_project_id: string,
): Promise<number> {
  const pool = getPool("medium");
  const { rows } = await pool.query<{
    students: string | number;
    pending_invites: string | number;
  }>(
    `
      SELECT
        COALESCE((
          SELECT COUNT(*)
          FROM projects
          WHERE deleted IS NULL
            AND course ->> 'type' = 'student'
            AND course ->> 'project_id' = $1
        ), 0) AS students,
        COALESCE((
          SELECT COUNT(*)
          FROM project_collab_invites
          WHERE status = 'pending'
            AND scope = 'course_student'
            AND context ->> 'course_project_id' = $1
        ), 0) AS pending_invites
    `,
    [course_project_id],
  );
  const row = rows[0];
  return Number(row?.students ?? 0) + Number(row?.pending_invites ?? 0);
}

export async function getProjectCollaboratorInviteUsage(project_id: string) {
  const [current, limit] = await Promise.all([
    getProjectCollaboratorsAndPendingInviteCount(project_id),
    getProjectCollaboratorInviteLimit({ project_id }),
  ]);
  return {
    current,
    limit: limit ?? null,
    remaining: limit == null ? null : Math.max(0, limit - current),
  };
}

export async function getCourseStudentInviteUsage(course_project_id: string) {
  const account_id = await getProjectUsageAccountId(course_project_id);
  const [current, resolution] = await Promise.all([
    getCourseStudentsAndPendingInviteCount(course_project_id),
    account_id ? resolveMembershipForAccount(account_id) : undefined,
  ]);
  const limit = resolution
    ? extractCourseStudentInviteLimit(resolution)
    : undefined;
  return {
    current,
    limit: limit ?? null,
    remaining: limit == null ? null : Math.max(0, limit - current),
  };
}

export async function assertProjectCollaboratorInviteLimit({
  project_id,
  resolution,
  additional = 1,
}: {
  project_id: string;
  resolution?: MembershipResolution;
  additional?: number;
}): Promise<void> {
  const account_id = await getProjectOwnerAccountId(project_id);
  if (!account_id) {
    return;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const limit = extractProjectCollaboratorInviteLimit(effectiveResolution);
  if (limit == null) {
    return;
  }
  const current =
    await getProjectCollaboratorsAndPendingInviteCount(project_id);
  if (current + additional > limit) {
    throw new Error(
      `project collaborator limit reached (${current}/${limit}); revoke a pending invite, remove a collaborator, or upgrade membership`,
    );
  }
}

export async function assertCourseStudentInviteLimit({
  course_project_id,
  resolution,
  additional = 1,
}: {
  course_project_id: string;
  resolution?: MembershipResolution;
  additional?: number;
}): Promise<void> {
  const account_id = await getProjectUsageAccountId(course_project_id);
  if (!account_id) {
    return;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const limit = extractCourseStudentInviteLimit(effectiveResolution);
  if (limit == null) {
    return;
  }
  const current =
    await getCourseStudentsAndPendingInviteCount(course_project_id);
  if (current + additional > limit) {
    throw new Error(
      `course student limit reached (${current}/${limit}); revoke pending invites, remove students, or upgrade membership`,
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

export async function getAccountStorageRemainingBytes({
  account_id,
  resolution,
  fresh = false,
}: {
  account_id: string;
  resolution?: MembershipResolution;
  fresh?: boolean;
}): Promise<number | undefined> {
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const total_storage_soft_bytes =
    extractTotalStorageSoftBytes(effectiveResolution);
  const total_storage_hard_bytes =
    extractTotalStorageHardBytes(effectiveResolution);
  if (total_storage_soft_bytes == null && total_storage_hard_bytes == null) {
    return undefined;
  }
  const usage = await getMembershipUsageStatusForAccount({
    account_id,
    resolution: effectiveResolution,
    fresh,
  });
  const remaining = [
    usage.total_storage_soft_remaining_bytes,
    usage.total_storage_hard_remaining_bytes,
  ].filter((value): value is number => typeof value === "number");
  if (remaining.length === 0) {
    return undefined;
  }
  return Math.min(...remaining);
}

export async function assertCanAddAccountStorage({
  account_id,
  additional_bytes,
  resolution,
  fresh = false,
  reason = "storage-increasing operation",
}: {
  account_id: string;
  additional_bytes: number;
  resolution?: MembershipResolution;
  fresh?: boolean;
  reason?: string;
}): Promise<void> {
  if (!Number.isFinite(additional_bytes) || additional_bytes <= 0) {
    return;
  }
  const remaining = await getAccountStorageRemainingBytes({
    account_id,
    resolution,
    fresh,
  });
  if (remaining == null) {
    return;
  }
  if (additional_bytes > remaining) {
    throw new Error(
      `${reason} requires ${humanSize(additional_bytes)}, but this account only has ${humanSize(Math.max(0, remaining))} storage remaining; delete data or upgrade membership`,
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
  const account_id = await getProjectUsageAccountId(project_id);
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
    account_id ?? (await getProjectUsageAccountId(project_id));
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
