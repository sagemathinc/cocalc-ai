/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Who created each admin balance adjustment, and why.

The creating admin of an admin balance adjustment (purpose
admin-balance-adjustment) is recorded in one of two places:

- since July 27, 2026: the account admin audit log (action balance-adjustment,
  metadata.purchase_id), because purchase notes are shown to the customer;
- before that: the purchase notes ("Admin-assisted purchase created by account
  `...`").

A credit with neither can be attributed after the fact with an audit entry
(action balance-adjustment-attribution). That never changes the purchase.
*/

import getPool from "@cocalc/database/pool";
import {
  ensureAccountAdminAuditLogSchema,
  recordAccountAdminAuditEvent,
} from "@cocalc/server/accounts/admin-audit";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { isBillingAccountAdmin } from "@cocalc/server/purchases/billing-account";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  AdminCreditAttribution,
  AdminCreditAttributionAttachResult,
} from "@cocalc/conat/hub/api/purchases";

export const ATTRIBUTION_ACTION = "balance-adjustment-attribution";
const MAX_LIMIT = 1000;

export type {
  AdminCreditAttribution,
  AdminCreditAttributionSource,
} from "@cocalc/conat/hub/api/purchases";

const NOTES_CREATOR =
  /Admin-assisted purchase created by account `([0-9a-fA-F-]{36})`/;

function reasonFromNotes(notes: string): string | null {
  const parts = notes
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => /^(Comment|Pricing note):/.test(part));
  return parts.length ? parts.join(" ") : null;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(value as any);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

export function attributionFromRow(row: any): AdminCreditAttribution {
  const base = {
    purchase_id: Number(row.id),
    time: iso(row.time) ?? "",
    account_id: row.account_id,
    amount: -Number(row.cost),
    description: row.description?.description ?? null,
  };
  if (row.audit?.actor_account_id) {
    return {
      ...base,
      created_by: row.audit.actor_account_id,
      reason: row.audit.reason ?? null,
      source: "audit-log",
    };
  }
  const notes = `${row.notes ?? ""}`;
  const match = NOTES_CREATOR.exec(notes);
  if (match) {
    return {
      ...base,
      created_by: match[1].toLowerCase(),
      reason: reasonFromNotes(notes),
      source: "notes",
    };
  }
  if (row.attached?.metadata?.attributed_admin_account_id) {
    return {
      ...base,
      created_by: row.attached.metadata.attributed_admin_account_id,
      reason: row.attached.reason ?? null,
      source: "attached",
      attached_by: row.attached.actor_account_id ?? null,
      attached_at: iso(row.attached.created),
    };
  }
  return { ...base, created_by: null, reason: null, source: "missing" };
}

const SELECT = `
  SELECT p.id, p.time, p.account_id, p.cost, p.description, p.notes,
    (SELECT row_to_json(l) FROM (
       SELECT actor_account_id, reason, created
         FROM account_admin_audit_log
        WHERE action = 'balance-adjustment'
          AND metadata->>'purchase_id' = p.id::text
        ORDER BY created LIMIT 1) l) AS audit,
    (SELECT row_to_json(a) FROM (
       SELECT actor_account_id, reason, metadata, created
         FROM account_admin_audit_log
        WHERE action = '${ATTRIBUTION_ACTION}'
          AND metadata->>'purchase_id' = p.id::text
        ORDER BY created DESC LIMIT 1) a) AS attached
    FROM purchases p
   WHERE p.description->>'purpose' = 'admin-balance-adjustment'`;

// Admins and attributed accounts may be homed on any bay, so both checks go
// through the cluster account directory.
async function assertAdmin(admin_account_id: string): Promise<void> {
  if (!(await isBillingAccountAdmin(admin_account_id))) {
    throw Error("must be an admin");
  }
}

// The SQL condition for "no recorded creator": no balance-adjustment audit
// entry, no creator in the old notes, and no attached attribution.
const MISSING = `
  NOT EXISTS (SELECT 1 FROM account_admin_audit_log
               WHERE action = 'balance-adjustment'
                 AND actor_account_id IS NOT NULL
                 AND metadata->>'purchase_id' = p.id::text)
  AND COALESCE(p.notes, '') !~ 'Admin-assisted purchase created by account \`[0-9a-fA-F-]{36}\`'
  AND NOT EXISTS (SELECT 1 FROM account_admin_audit_log
                   WHERE action = '${ATTRIBUTION_ACTION}'
                     AND metadata->>'purchase_id' = p.id::text)`;

export async function listAdminCreditAttribution({
  admin_account_id,
  since,
  until,
  missing_only,
  limit = 200,
}: {
  admin_account_id: string;
  since?: string | Date;
  until?: string | Date;
  missing_only?: boolean;
  limit?: number;
}): Promise<AdminCreditAttribution[]> {
  await assertAdmin(admin_account_id);
  await ensureAccountAdminAuditLogSchema();
  const n = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(limit) || 200)));
  const { rows } = await getPool().query(
    `${SELECT}
       AND ($1::timestamptz IS NULL OR p.time >= $1)
       AND ($2::timestamptz IS NULL OR p.time < $2)
       ${missing_only ? `AND ${MISSING}` : ""}
     ORDER BY p.time DESC, p.id DESC
     LIMIT $3`,
    [iso(since), iso(until), n],
  );
  return rows.map(attributionFromRow);
}

export async function getAdminCreditAttribution(
  purchase_id: number,
): Promise<AdminCreditAttribution | undefined> {
  const { rows } = await getPool().query(`${SELECT} AND p.id = $1`, [
    purchase_id,
  ]);
  return rows[0] == null ? undefined : attributionFromRow(rows[0]);
}

// Records which admin created a credit that has no attribution yet. Without
// commit it only returns what would be recorded.
export async function attachAdminCreditAttribution({
  admin_account_id,
  purchase_id,
  attributed_admin_account_id,
  reason,
  commit,
}: {
  admin_account_id: string;
  purchase_id: number;
  attributed_admin_account_id: string;
  reason: string;
  commit?: boolean;
}): Promise<AdminCreditAttributionAttachResult> {
  await assertAdmin(admin_account_id);
  await ensureAccountAdminAuditLogSchema();
  const id = Number(purchase_id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Error("purchase_id must be a positive integer");
  }
  const attributed = `${attributed_admin_account_id ?? ""}`
    .trim()
    .toLowerCase();
  if (!isValidUUID(attributed)) {
    throw Error("the attributed admin must be an account id");
  }
  const why = `${reason ?? ""}`.trim();
  if (!why) {
    throw Error("a reason is required");
  }
  const before = await getAdminCreditAttribution(id);
  if (before == null) {
    throw Error(`purchase ${id} is not an admin balance adjustment`);
  }
  if (before.source !== "missing") {
    throw Error(
      `purchase ${id} is already attributed to ${before.created_by} (${before.source})`,
    );
  }
  if ((await getClusterAccountById(attributed)) == null) {
    throw Error(`account ${attributed} does not exist`);
  }
  const after: AdminCreditAttribution = {
    ...before,
    created_by: attributed,
    reason: why,
    source: "attached",
    attached_by: admin_account_id,
    attached_at: null,
  };
  if (!commit) {
    return { committed: false, before, after };
  }
  try {
    // A unique index allows one attribution per purchase
    // (account_admin_audit_log_attribution_purchase_unique), so of two
    // concurrent attaches exactly one is recorded.
    await recordAccountAdminAuditEvent({
      account_id: before.account_id,
      action: ATTRIBUTION_ACTION,
      actor_account_id: admin_account_id,
      reason: why,
      metadata: {
        purchase_id: id,
        attributed_admin_account_id: attributed,
        amount: before.amount,
      },
    });
  } catch (err) {
    if ((err as any)?.code === "23505") {
      const current = await getAdminCreditAttribution(id);
      throw Error(
        `purchase ${id} is already attributed to ${current?.created_by} (${current?.source})`,
      );
    }
    throw err;
  }
  return {
    committed: true,
    before,
    after: (await getAdminCreditAttribution(id)) ?? after,
  };
}
