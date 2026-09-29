/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";

type Db = {
  query(sql: string, values?: unknown[]): Promise<any>;
};

// Run inside the maintenance transaction. Lock the turn before touching its key,
// matching renewal/finalization so cleanup cannot race a successful renewal.
export async function cleanupCocalcConnectorCredentials(db: Db, batch: number) {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 5000)
    throw Error("invalid connector cleanup batch size");
  const bay = getConfiguredBayId();
  const expired = await db.query(
    `WITH candidates AS (
       SELECT t.turn_id FROM agent_cocalc_connector_turns t
       JOIN accounts a ON a.account_id=t.account_id
       WHERE COALESCE(a.home_bay_id,$2)=$2
         AND COALESCE(t.ended_at,t.expires_at)<now()-interval '30 seconds'
         AND (t.secret_ciphertext<>'' OR EXISTS (
           SELECT 1 FROM api_keys k WHERE k.account_id=t.account_id AND k.key_id=t.key_id))
       ORDER BY COALESCE(t.ended_at,t.expires_at),t.turn_id
       LIMIT $1 FOR UPDATE OF t SKIP LOCKED
     ), scrubbed AS (
       UPDATE agent_cocalc_connector_turns t
       SET secret_ciphertext='',ended_at=COALESCE(t.ended_at,t.expires_at)
       FROM candidates c WHERE t.turn_id=c.turn_id
       RETURNING t.account_id,t.key_id
     ), removed AS (
       DELETE FROM api_keys k USING scrubbed s
       WHERE k.account_id=s.account_id AND k.key_id=s.key_id
       RETURNING k.key_id
     ) SELECT (SELECT count(*) FROM scrubbed)::INTEGER AS scrubbed,
              (SELECT count(*) FROM removed)::INTEGER AS removed`,
    [batch, bay],
  );
  const history = await db.query(
    `DELETE FROM agent_cocalc_connector_turns WHERE turn_id IN (
       SELECT t.turn_id FROM agent_cocalc_connector_turns t
       JOIN accounts a ON a.account_id=t.account_id
       WHERE COALESCE(a.home_bay_id,$2)=$2
         AND COALESCE(t.ended_at,t.expires_at)<now()-interval '30 days'
         AND t.secret_ciphertext=''
         AND NOT EXISTS (SELECT 1 FROM api_keys k
                         WHERE k.account_id=t.account_id AND k.key_id=t.key_id)
       ORDER BY COALESCE(t.ended_at,t.expires_at),t.turn_id
       LIMIT $1 FOR UPDATE OF t SKIP LOCKED
     )`,
    [batch, bay],
  );
  return {
    connector_secrets: Number(expired.rows[0]?.scrubbed ?? 0),
    connector_keys: Number(expired.rows[0]?.removed ?? 0),
    connector_history: history.rowCount ?? 0,
  };
}
