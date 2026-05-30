/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 as uuid } from "uuid";

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

const TABLE = "account_admin_audit_log";

export type AccountAdminAuditAction = "grant-admin" | "revoke-admin";

function normalizeReason(reason?: string | null): string | null {
  const trimmed = `${reason ?? ""}`.trim();
  return trimmed ? trimmed.slice(0, 4000) : null;
}

export async function ensureAccountAdminAuditLogSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL,
      action VARCHAR(32) NOT NULL,
      actor_account_id UUID,
      reason TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_account_id_idx ON ${TABLE} (account_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_actor_account_id_idx ON ${TABLE} (actor_account_id)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_action_idx ON ${TABLE} (action)`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_created_idx ON ${TABLE} (created)`,
  );
}

export async function recordAccountAdminAuditEvent({
  account_id,
  action,
  actor_account_id,
  reason,
  metadata,
}: {
  account_id: string;
  action: AccountAdminAuditAction;
  actor_account_id?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  const actor =
    actor_account_id && isValidUUID(actor_account_id) ? actor_account_id : null;
  await ensureAccountAdminAuditLogSchema();
  await getPool().query(
    `INSERT INTO ${TABLE}
       (id, account_id, action, actor_account_id, reason, metadata)
     VALUES
       ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      uuid(),
      account_id,
      action,
      actor,
      normalizeReason(reason),
      JSON.stringify(metadata ?? {}),
    ],
  );
}
