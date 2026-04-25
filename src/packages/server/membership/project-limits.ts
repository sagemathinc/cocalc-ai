/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";
import { resolveMembershipForAccount } from "./resolve";

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
