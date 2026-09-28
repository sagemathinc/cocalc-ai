/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "../../pool";

/** Caller holds a transaction. Acquire account fences BEFORE cursor row locks,
 * without waiting on an in-flight snapshot or another maintenance worker. The
 * guards are rechecked after locking, including lazily installed handoff tables.
 */
export async function lockCollaborationMaintenanceAccounts(
  db: Pick<PoolClient, "query">,
  account_ids: readonly string[],
): Promise<Set<string>> {
  if (account_ids.length > 500)
    throw Error("account maintenance batch exceeds capacity");
  if (!account_ids.length) return new Set();
  const { rows: locks } = await db.query(
    `SELECT account_id,pg_try_advisory_xact_lock(hashtext('account-rehome'),hashtext(account_id::text)) AS locked
     FROM unnest($1::uuid[]) AS a(account_id) ORDER BY account_id`,
    [[...new Set(account_ids)].sort()],
  );
  const locked = locks.filter((row) => row.locked).map((row) => row.account_id);
  if (!locked.length) return new Set();
  const {
    rows: [tables],
  } = await db.query(`SELECT
    to_regclass('public.account_collaboration_handoffs') AS collaboration,
    to_regclass('public.account_financial_handoffs') AS financial,
    to_regclass('public.account_rehome_operations') AS operations`);
  const guards: string[] = [];
  if (tables.collaboration)
    guards.push(`NOT EXISTS(SELECT 1 FROM account_collaboration_handoffs h
    WHERE h.account_id=a.account_id AND h.state<>'active')`);
  if (tables.financial)
    guards.push(`NOT EXISTS(SELECT 1 FROM account_financial_handoffs h
    WHERE h.account_id=a.account_id AND h.state IN ('frozen','accepted','imported'))`);
  if (tables.operations)
    guards.push(`NOT EXISTS(SELECT 1 FROM account_rehome_operations o
    WHERE o.account_id=a.account_id AND o.status='running')`);
  const { rows } = await db.query(
    `SELECT account_id FROM unnest($1::uuid[]) AS a(account_id)
    WHERE ${guards.join(" AND ") || "TRUE"}`,
    [locked],
  );
  return new Set(rows.map((row) => row.account_id));
}
