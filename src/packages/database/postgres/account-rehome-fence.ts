/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PostgreSQLMethods } from "@cocalc/database/postgres/types";
import { DEFAULT_BAY_ID } from "@cocalc/util/bay";

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

const ACCOUNT_REHOME_OPERATIONS_TABLE = "account_rehome_operations";

function getConfiguredBayId(): string {
  const bayId = `${process.env.COCALC_BAY_ID ?? ""}`.trim();
  return bayId || DEFAULT_BAY_ID;
}

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

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const { rows } = await db.query("SELECT to_regclass($1) AS table_name", [
    `public.${table}`,
  ]);
  return rows[0]?.table_name != null;
}

async function accountRehomeOperationsTableExists(
  db: Queryable,
): Promise<boolean> {
  return await tableExists(db, ACCOUNT_REHOME_OPERATIONS_TABLE);
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
  const { rows: accountRows } = await db.query(
    `
      SELECT home_bay_id
        FROM accounts
       WHERE account_id = $1
         AND deleted IS NOT TRUE
       LIMIT 1
    `,
    [account_id],
  );
  const row = accountRows[0];
  if (!row) {
    throw new Error(`cannot ${action}; account ${account_id} not found`);
  }
  const localBayId = getConfiguredBayId();
  let homeBayId = `${row.home_bay_id ?? ""}`.trim() || localBayId;
  if (await tableExists(db, "cluster_account_directory")) {
    const { rows: directoryRows } = await db.query(
      `
        SELECT home_bay_id
          FROM cluster_account_directory
         WHERE account_id = $1
         LIMIT 1
      `,
      [account_id],
    );
    homeBayId = `${directoryRows[0]?.home_bay_id ?? ""}`.trim() || homeBayId;
  }
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

export async function withAccountRehomeUserQueryFence<T>({
  database,
  account_id,
  action = "modify account via user query",
  fn,
}: {
  database: PostgreSQLMethods;
  account_id: string;
  action?: string;
  fn: () => Promise<T>;
}): Promise<T> {
  const existingClient = database._query_client;
  if (existingClient) {
    await assertAccountNotRehoming({ db: existingClient, account_id, action });
    await assertAccountWriteOnHomeBay({
      db: existingClient,
      account_id,
      action,
    });
    return await fn();
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    database._query_client = client;
    await assertAccountNotRehoming({ db: client, account_id, action });
    await assertAccountWriteOnHomeBay({ db: client, account_id, action });
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    if (database._query_client === client) {
      delete database._query_client;
    }
    client.release();
  }
}
