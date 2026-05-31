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

export interface RevokeAdminRoleResult {
  account_id: string;
  was_admin: boolean;
  groups: string[];
}

function normalizeGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) {
    return [];
  }
  return [...new Set(groups.filter((group) => typeof group === "string"))];
}

async function hasOtherActiveAdminWithSecondFactor({
  db,
  account_id,
}: {
  db: { query: (query: string, params?: any[]) => Promise<{ rows: any[] }> };
  account_id: string;
}): Promise<boolean> {
  const { rows } = await db.query(
    `
      SELECT a.account_id
        FROM accounts AS a
       WHERE a.account_id <> $1::UUID
         AND coalesce(a.deleted, false) = false
         AND coalesce(a.banned, false) = false
         AND 'admin' = ANY(a.groups)
         AND EXISTS (
           SELECT 1
             FROM account_second_factors AS f
            WHERE f.account_id = a.account_id
              AND f.status = 'active'
              AND f.activated_at IS NOT NULL
              AND f.disabled_at IS NULL
         )
       LIMIT 1
    `,
    [account_id],
  );
  return rows.length > 0;
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

export async function revokeAdminRole({
  account_id,
  actor_account_id,
  reason,
  metadata,
}: {
  account_id: string;
  actor_account_id?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<RevokeAdminRoleResult> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }
  const normalizedActorId = `${actor_account_id ?? ""}`.trim().toLowerCase();
  const actorId = isValidUUID(normalizedActorId) ? normalizedActorId : null;
  const mustFindOtherActiveAdmin = !actorId || actorId === normalizedAccountId;

  const result = await withAccountRehomeWriteFence({
    account_id: normalizedAccountId,
    action: "revoke account admin role",
    fn: async (db) => {
      const { rows } = await db.query(
        "SELECT groups FROM accounts WHERE account_id=$1",
        [normalizedAccountId],
      );
      if (rows.length === 0) {
        throw Error("no such account");
      }
      const oldGroups = normalizeGroups(rows[0].groups);
      const was_admin = oldGroups.includes("admin");
      if (!was_admin) {
        return {
          account_id: normalizedAccountId,
          was_admin,
          old_groups: oldGroups,
          groups: oldGroups,
        };
      }

      if (
        mustFindOtherActiveAdmin &&
        !(await hasOtherActiveAdminWithSecondFactor({
          db,
          account_id: normalizedAccountId,
        }))
      ) {
        throw new Error(
          "cannot remove the last active site admin with verified 2FA",
        );
      }

      const groups = oldGroups.filter((group) => group !== "admin");
      await db.query(
        "UPDATE accounts SET groups=$1::TEXT[] WHERE account_id=$2",
        [groups, normalizedAccountId],
      );
      return {
        account_id: normalizedAccountId,
        was_admin,
        old_groups: oldGroups,
        groups,
      };
    },
  });

  if (result.was_admin) {
    await publishAccountRowFeedEventsBestEffort({
      account_id: normalizedAccountId,
      patch: { groups: result.groups },
    });
  }

  await recordAccountAdminAuditEvent({
    account_id: normalizedAccountId,
    action: "revoke-admin",
    actor_account_id,
    reason,
    metadata: {
      ...(metadata ?? {}),
      was_admin: result.was_admin,
      old_groups: result.old_groups,
      new_groups: result.groups,
    },
  });

  return {
    account_id: result.account_id,
    was_admin: result.was_admin,
    groups: result.groups,
  };
}
