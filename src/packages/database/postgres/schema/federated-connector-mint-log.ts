/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The federated connector mint log (util/db-schema/federated-connectors.ts) is
append-only. Triggers refuse every UPDATE and TRUNCATE, and every DELETE of a
row younger than the retention period, so no code path (and no ordinary SQL
session) can rewrite or drop a mint record before it expires. Only rows older
than FEDERATED_MINT_LOG_RETENTION may be deleted, by the retention job.

A row's time is always the database's own clock at insert: a supplied time
is overwritten, so a record can't be backdated to make it deletable at once.
The triggers are enabled ALWAYS, so they also fire for sessions in replica
mode.
*/

import type { Client } from "@cocalc/database/pool";

export const FEDERATED_MINT_LOG_TABLE = "federated_connector_mint_log";
export const FEDERATED_MINT_LOG_ROW_TRIGGER =
  "federated_connector_mint_log_append_only";
export const FEDERATED_MINT_LOG_TRUNCATE_TRIGGER =
  "federated_connector_mint_log_no_truncate";
export const FEDERATED_MINT_LOG_INSERT_TRIGGER =
  "federated_connector_mint_log_insert_time";
const FEDERATED_MINT_LOG_TRIGGERS = [
  FEDERATED_MINT_LOG_ROW_TRIGGER,
  FEDERATED_MINT_LOG_TRUNCATE_TRIGGER,
  FEDERATED_MINT_LOG_INSERT_TRIGGER,
];
const FEDERATED_MINT_LOG_FUNCTION = "federated_connector_mint_log_guard";
// Bump when the function changes, so schema sync replaces it.
const FEDERATED_MINT_LOG_CONTRACT = "federated-mint-log-append-only-v2";
// At least 13 months (audit evidence).
export const FEDERATED_MINT_LOG_RETENTION = "13 months";

const CREATE_OR_REPLACE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${FEDERATED_MINT_LOG_FUNCTION}()
   RETURNS TRIGGER AS $$
   -- ${FEDERATED_MINT_LOG_CONTRACT}
   BEGIN
     IF TG_OP = 'INSERT' THEN
       NEW.time := NOW();
       RETURN NEW;
     END IF;
     IF TG_OP = 'DELETE'
        AND OLD.time < NOW() - INTERVAL '${FEDERATED_MINT_LOG_RETENTION}' THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION '${FEDERATED_MINT_LOG_TABLE} is append-only (% refused)', TG_OP
       USING ERRCODE = 'insufficient_privilege';
   END;
   $$ LANGUAGE plpgsql`;

async function triggerNames(db: Pick<Client, "query">): Promise<string[]> {
  const { rows } = await db.query<{ tgname: string }>(
    `SELECT tgname
       FROM pg_trigger
      WHERE tgrelid=$1::regclass
        AND NOT tgisinternal`,
    [FEDERATED_MINT_LOG_TABLE],
  );
  return rows.map(({ tgname }) => tgname);
}

export async function ensureFederatedMintLogSchema(db: Client): Promise<void> {
  await db.query(CREATE_OR_REPLACE_FUNCTION_SQL);
  const existing = await triggerNames(db);
  if (!existing.includes(FEDERATED_MINT_LOG_ROW_TRIGGER)) {
    await db.query(
      `CREATE TRIGGER ${FEDERATED_MINT_LOG_ROW_TRIGGER}
         BEFORE UPDATE OR DELETE
         ON ${FEDERATED_MINT_LOG_TABLE}
         FOR EACH ROW
         EXECUTE FUNCTION ${FEDERATED_MINT_LOG_FUNCTION}()`,
    );
  }
  if (!existing.includes(FEDERATED_MINT_LOG_TRUNCATE_TRIGGER)) {
    await db.query(
      `CREATE TRIGGER ${FEDERATED_MINT_LOG_TRUNCATE_TRIGGER}
         BEFORE TRUNCATE
         ON ${FEDERATED_MINT_LOG_TABLE}
         FOR EACH STATEMENT
         EXECUTE FUNCTION ${FEDERATED_MINT_LOG_FUNCTION}()`,
    );
  }
  if (!existing.includes(FEDERATED_MINT_LOG_INSERT_TRIGGER)) {
    await db.query(
      `CREATE TRIGGER ${FEDERATED_MINT_LOG_INSERT_TRIGGER}
         BEFORE INSERT
         ON ${FEDERATED_MINT_LOG_TABLE}
         FOR EACH ROW
         EXECUTE FUNCTION ${FEDERATED_MINT_LOG_FUNCTION}()`,
    );
  }
  // Fire in every session mode, including replica. A trigger someone
  // disabled (D) is left disabled and reported, never silently re-enabled.
  for (const tgname of FEDERATED_MINT_LOG_TRIGGERS) {
    const { rows } = await db.query<{ enabled: string }>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger
        WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal`,
      [FEDERATED_MINT_LOG_TABLE, tgname],
    );
    if (rows[0]?.enabled === "O") {
      await db.query(
        `ALTER TABLE ${FEDERATED_MINT_LOG_TABLE} ENABLE ALWAYS TRIGGER ${tgname}`,
      );
    }
  }
}

// A disabled trigger is not repaired here (someone disabled it on purpose);
// admin health reports it.
export async function federatedMintLogSchemaNeedsSync(
  db: Pick<Client, "query">,
): Promise<boolean> {
  const { state } = await getFederatedMintLogGuardStatus(db);
  return state === "missing" || state === "outdated";
}

export interface FederatedMintLogGuardStatus {
  // ok: every trigger enabled ALWAYS and current; disabled: someone disabled
  // one; outdated: an old function, or a trigger that doesn't fire always.
  state: "ok" | "missing" | "disabled" | "outdated";
}

export async function getFederatedMintLogGuardStatus(
  db: Pick<Client, "query">,
): Promise<FederatedMintLogGuardStatus> {
  const { rows } = await db.query<{
    tgname: string;
    enabled: string;
    current: boolean;
  }>(
    `SELECT t.tgname,
            t.tgenabled::text AS enabled,
            position($2 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
      WHERE t.tgrelid=$1::regclass
        AND NOT t.tgisinternal
        AND t.tgname = ANY($3::text[])`,
    [
      FEDERATED_MINT_LOG_TABLE,
      FEDERATED_MINT_LOG_CONTRACT,
      FEDERATED_MINT_LOG_TRIGGERS,
    ],
  );
  if (rows.length < FEDERATED_MINT_LOG_TRIGGERS.length) {
    return { state: "missing" };
  }
  // D (disabled) and R (replica only) don't fire for ordinary writes.
  if (rows.some((r) => r.enabled === "D" || r.enabled === "R")) {
    return { state: "disabled" };
  }
  // O fires, but not in replica mode: sync upgrades it to A.
  if (rows.some((r) => !r.current || r.enabled !== "A")) {
    return { state: "outdated" };
  }
  return { state: "ok" };
}

/** Deletes mint records older than the retention period. */
export async function purgeExpiredFederatedMintLog(
  db: Pick<Client, "query">,
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM ${FEDERATED_MINT_LOG_TABLE}
      WHERE time < NOW() - INTERVAL '${FEDERATED_MINT_LOG_RETENTION}'`,
  );
  return rowCount ?? 0;
}
