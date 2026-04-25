/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { resolveMembershipForAccount } from "./resolve";
import { getMembershipUsageStatusForAccount } from "./usage-status";

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
