/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

const ACCOUNT_REHOME_OPERATIONS_TABLE = "account_rehome_operations";

export async function lockAccountRehomeFence({
  db,
  account_id,
}: {
  db: Queryable;
  account_id: string;
}): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))",
    ["account-rehome", account_id],
  );
}

async function accountRehomeOperationsTableExists(
  db: Queryable,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT to_regclass('public.${ACCOUNT_REHOME_OPERATIONS_TABLE}') AS table_name`,
  );
  return rows[0]?.table_name != null;
}

export async function assertAccountNotRehoming({
  db,
  account_id,
  action = "modify account",
}: {
  db: Queryable;
  account_id: string;
  action?: string;
}): Promise<void> {
  await lockAccountRehomeFence({ db, account_id });
  if (!(await accountRehomeOperationsTableExists(db))) {
    return;
  }
  const { rows } = await db.query(
    `
      SELECT op_id, source_bay_id, dest_bay_id, stage
        FROM ${ACCOUNT_REHOME_OPERATIONS_TABLE}
       WHERE account_id = $1
         AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1
    `,
    [account_id],
  );
  const active = rows[0];
  if (!active) return;
  throw new Error(
    `cannot ${action} for account ${account_id}; account rehome ${active.op_id} is running from ${active.source_bay_id} to ${active.dest_bay_id} at stage ${active.stage}`,
  );
}

export async function assertAccountWriteOnHomeBay({
  db,
  account_id,
  action = "modify account",
}: {
  db: Queryable;
  account_id: string;
  action?: string;
}): Promise<void> {
  const { rows } = await db.query(
    `
      SELECT home_bay_id
        FROM accounts
       WHERE account_id = $1
         AND deleted IS NOT TRUE
       LIMIT 1
    `,
    [account_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`cannot ${action}; account ${account_id} not found`);
  }
  const localBayId = getConfiguredBayId();
  const homeBayId = `${row.home_bay_id ?? ""}`.trim() || localBayId;
  if (homeBayId !== localBayId) {
    throw new Error(
      `cannot ${action} for account ${account_id} on bay ${localBayId}; account is homed on ${homeBayId}`,
    );
  }
}

export async function withAccountRehomeWriteFence<T>({
  account_id,
  action,
  fn,
}: {
  account_id: string;
  action?: string;
  fn: (db: Queryable) => Promise<T>;
}): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertAccountNotRehoming({ db: client, account_id, action });
    await assertAccountWriteOnHomeBay({ db: client, account_id, action });
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
