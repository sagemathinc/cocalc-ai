/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool, { type Pool, type PoolClient } from "@cocalc/database/pool";

async function hasTable(db: PoolClient, table: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`public.${table}`],
  );
  return rows[0]?.present === true;
}

async function hasColumn(
  db: PoolClient,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS present`,
    [table, column],
  );
  return rows[0]?.present === true;
}

/**
 * Permanently retire authority understood by pre-Session servers before the
 * Session subscribers start. The updates are deliberately idempotent so every
 * hub can enforce the cutover independently.
 */
export async function retireLegacyAgentMessagingAuthority(
  pool: Pick<Pool, "connect"> = getPool(),
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    if (await hasTable(db, "agent_personal_grants")) {
      await db.query(`UPDATE agent_personal_grants
        SET revoked_at=COALESCE(revoked_at,now()), paused=true
        WHERE revoked_at IS NULL OR paused=false`);
    }
    if (await hasTable(db, "agent_personal_requests")) {
      await db.query(`UPDATE agent_personal_requests
        SET state='invalidated'
        WHERE state='pending'`);
    }
    if (await hasTable(db, "agent_rpc_links")) {
      await db.query(`UPDATE agent_rpc_links
        SET revoked_at=COALESCE(revoked_at,now())
        WHERE revoked_at IS NULL`);
    }
    if (await hasTable(db, "agent_message_grants")) {
      await db.query(`UPDATE agent_message_grants
        SET revoked_at=COALESCE(revoked_at,now())
        WHERE revoked_at IS NULL`);
    }
    if (
      (await hasTable(db, "agent_external_installations")) &&
      (await hasColumn(db, "agent_external_installations", "destinations"))
    ) {
      await db.query(`UPDATE agent_external_installations
        SET state='revoked'
        WHERE state='active'
          AND jsonb_typeof(destinations)='array'
          AND jsonb_array_length(destinations)>0`);
    }

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
