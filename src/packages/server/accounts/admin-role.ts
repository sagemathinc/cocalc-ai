/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { publishAccountRowFeedEventsBestEffort } from "@cocalc/server/account/account-row-feed";
import { recordAccountAdminAuditEvent } from "@cocalc/server/accounts/admin-audit";
import { withAccountRehomeWriteFence } from "@cocalc/server/accounts/rehome-fence";
import { isValidUUID } from "@cocalc/util/misc";

export interface GrantAdminRoleResult {
  account_id: string;
  already_admin: boolean;
  groups: string[];
}

function normalizeGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return [...new Set(groups.filter((group) => typeof group === "string"))];
}

export async function grantAdminRole({
  account_id,
  actor_account_id,
  reason,
  metadata,
}: {
  account_id: string;
  actor_account_id?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<GrantAdminRoleResult> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }

  const result = await withAccountRehomeWriteFence({
    account_id: normalizedAccountId,
    action: "grant account admin role",
    fn: async (db) => {
      const { rows } = await db.query(
        "SELECT groups FROM accounts WHERE account_id=$1",
        [normalizedAccountId],
      );
      if (rows.length === 0) {
        throw Error("no such account");
      }
      const oldGroups = normalizeGroups(rows[0].groups);
      const already_admin = oldGroups.includes("admin");
      const groups = already_admin ? oldGroups : [...oldGroups, "admin"];
      if (!already_admin) {
        await db.query(
          "UPDATE accounts SET groups=$1::TEXT[] WHERE account_id=$2",
          [groups, normalizedAccountId],
        );
      }
      return {
        account_id: normalizedAccountId,
        already_admin,
        old_groups: oldGroups,
        groups,
      };
    },
  });

  if (!result.already_admin) {
    await publishAccountRowFeedEventsBestEffort({
      account_id: normalizedAccountId,
      patch: { groups: result.groups },
    });
  }

  await recordAccountAdminAuditEvent({
    account_id: normalizedAccountId,
    action: "grant-admin",
    actor_account_id,
    reason,
    metadata: {
      ...(metadata ?? {}),
      already_admin: result.already_admin,
      old_groups: result.old_groups,
      new_groups: result.groups,
    },
  });

  return {
    account_id: result.account_id,
    already_admin: result.already_admin,
    groups: result.groups,
  };
}
