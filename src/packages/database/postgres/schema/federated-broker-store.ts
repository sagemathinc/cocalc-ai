/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The token broker's own store (G3b design v3 §4): a Postgres instance local to
the broker VM, with no hub tables, holding only the mint log and the purge
log (lease locks are advisory locks, so they need no table).

Roles and the schema "broker" (owned by broker_migrate) are created by the VM
setup step, with peer authentication only:
- broker_migrate owns the schema, both tables, their ENABLE ALWAYS guards
  and the purge function. Only it runs this migration.
- broker_app (the broker process) may INSERT and SELECT the mint log, SELECT
  the purge log, and EXECUTE the purge. It owns nothing, so it can't ALTER a
  table or DISABLE a trigger, and it has no UPDATE, DELETE or TRUNCATE.

The purge is a SECURITY DEFINER function owned by broker_migrate: it deletes
only mint rows past the retention period and appends the count to the purge
log, which is append-only in the same way.
*/

import { FEDERATED_MINT_LOG_RETENTION } from "./federated-connector-mint-log";

export const BROKER_STORE_SCHEMA = "broker";
export const BROKER_MIGRATE_ROLE = "broker_migrate";
export const BROKER_APP_ROLE = "broker_app";
// Bump when the guard or the purge changes; the migration replaces both.
export const BROKER_STORE_CONTRACT = "federated-broker-store-v1";

export interface BrokerStoreDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, any>[] }>;
}

const S = BROKER_STORE_SCHEMA;

const MIGRATION_SQL = [
  // Run only as the owner role, which must not be a superuser, and with an
  // app role that can't act as the owner.
  `DO $$
   BEGIN
     IF current_user <> '${BROKER_MIGRATE_ROLE}' THEN
       RAISE EXCEPTION 'broker store migration must run as ${BROKER_MIGRATE_ROLE}';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BROKER_APP_ROLE}'
                      AND NOT rolsuper AND NOT rolbypassrls
                      AND NOT rolcreaterole AND NOT rolcreatedb) THEN
       RAISE EXCEPTION '${BROKER_APP_ROLE} missing or too privileged';
     END IF;
     IF pg_has_role('${BROKER_APP_ROLE}', '${BROKER_MIGRATE_ROLE}', 'MEMBER') THEN
       RAISE EXCEPTION '${BROKER_APP_ROLE} must not be a member of ${BROKER_MIGRATE_ROLE}';
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_namespace
                     WHERE nspname = '${S}'
                       AND nspowner = '${BROKER_MIGRATE_ROLE}'::regrole) THEN
       RAISE EXCEPTION 'schema ${S} must exist, owned by ${BROKER_MIGRATE_ROLE}';
     END IF;
   END $$`,
  `REVOKE ALL ON SCHEMA ${S} FROM PUBLIC`,
  `GRANT USAGE ON SCHEMA ${S} TO ${BROKER_APP_ROLE}`,
  `CREATE TABLE IF NOT EXISTS ${S}.federated_connector_mint_log (
     mint_id UUID PRIMARY KEY,
     time TIMESTAMP NOT NULL,
     outcome TEXT NOT NULL
       CONSTRAINT federated_connector_mint_log_outcome_check
       CHECK (outcome IN ('issued','denied','error')),
     reason TEXT,
     site_id TEXT,
     account_id UUID,
     agent_id UUID,
     project_id UUID,
     host_id UUID,
     run_id UUID,
     connection_id UUID,
     grant_id UUID,
     grant_revision INTEGER,
     lease_id UUID,
     jti UUID,
     key_version TEXT,
     service_account TEXT,
     issued_at TIMESTAMP,
     expires_at TIMESTAMP
   )`,
  `CREATE INDEX IF NOT EXISTS federated_connector_mint_log_time_idx
     ON ${S}.federated_connector_mint_log (time)`,
  `CREATE INDEX IF NOT EXISTS federated_connector_mint_log_grant_idx
     ON ${S}.federated_connector_mint_log (grant_id, time)`,
  `CREATE TABLE IF NOT EXISTS ${S}.broker_purge_log (
     purge_id BIGSERIAL PRIMARY KEY,
     time TIMESTAMP NOT NULL,
     deleted INTEGER NOT NULL CHECK (deleted >= 0)
   )`,
  // Append-only: the database's clock at insert; no UPDATE or TRUNCATE; a
  // DELETE only of a row past the retention period.
  `CREATE OR REPLACE FUNCTION ${S}.broker_append_only_guard()
     RETURNS TRIGGER
     SET search_path = pg_catalog
     AS $$
     -- ${BROKER_STORE_CONTRACT}
     BEGIN
       IF TG_OP = 'INSERT' THEN
         NEW.time := clock_timestamp();
         RETURN NEW;
       END IF;
       IF TG_OP = 'DELETE'
          AND OLD.time < NOW() - INTERVAL '${FEDERATED_MINT_LOG_RETENTION}' THEN
         RETURN OLD;
       END IF;
       RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP
         USING ERRCODE = 'insufficient_privilege';
     END;
     $$ LANGUAGE plpgsql`,
  ...["federated_connector_mint_log", "broker_purge_log"].flatMap((t) => [
    `DROP TRIGGER IF EXISTS ${t}_insert_time ON ${S}.${t}`,
    `CREATE TRIGGER ${t}_insert_time BEFORE INSERT ON ${S}.${t}
       FOR EACH ROW EXECUTE FUNCTION ${S}.broker_append_only_guard()`,
    `DROP TRIGGER IF EXISTS ${t}_append_only ON ${S}.${t}`,
    `CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${S}.${t}
       FOR EACH ROW EXECUTE FUNCTION ${S}.broker_append_only_guard()`,
    `DROP TRIGGER IF EXISTS ${t}_no_truncate ON ${S}.${t}`,
    `CREATE TRIGGER ${t}_no_truncate BEFORE TRUNCATE ON ${S}.${t}
       FOR EACH STATEMENT EXECUTE FUNCTION ${S}.broker_append_only_guard()`,
    `ALTER TABLE ${S}.${t} ENABLE ALWAYS TRIGGER ${t}_insert_time`,
    `ALTER TABLE ${S}.${t} ENABLE ALWAYS TRIGGER ${t}_append_only`,
    `ALTER TABLE ${S}.${t} ENABLE ALWAYS TRIGGER ${t}_no_truncate`,
    `REVOKE ALL ON ${S}.${t} FROM PUBLIC`,
    `REVOKE ALL ON ${S}.${t} FROM ${BROKER_APP_ROLE}`,
  ]),
  `GRANT INSERT, SELECT ON ${S}.federated_connector_mint_log TO ${BROKER_APP_ROLE}`,
  `GRANT SELECT ON ${S}.broker_purge_log TO ${BROKER_APP_ROLE}`,
  `CREATE OR REPLACE FUNCTION ${S}.broker_purge_mint_log()
     RETURNS INTEGER
     SECURITY DEFINER
     SET search_path = pg_catalog
     AS $$
     -- ${BROKER_STORE_CONTRACT}
     DECLARE
       n INTEGER;
     BEGIN
       DELETE FROM ${S}.federated_connector_mint_log
        WHERE time < NOW() - INTERVAL '${FEDERATED_MINT_LOG_RETENTION}';
       GET DIAGNOSTICS n = ROW_COUNT;
       INSERT INTO ${S}.broker_purge_log (time, deleted)
            VALUES (clock_timestamp(), n);
       RETURN n;
     END;
     $$ LANGUAGE plpgsql`,
  `REVOKE ALL ON FUNCTION ${S}.broker_purge_mint_log() FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION ${S}.broker_purge_mint_log() TO ${BROKER_APP_ROLE}`,
  `REVOKE ALL ON FUNCTION ${S}.broker_append_only_guard() FROM PUBLIC`,
];

/** Creates or updates the store. Only broker_migrate may run it. */
export async function migrateBrokerStore(db: BrokerStoreDb): Promise<void> {
  for (const sql of MIGRATION_SQL) {
    await db.query(sql);
  }
}

export interface BrokerStoreStatus {
  /**
   * ok: each of the six guards exists by name on its table, enabled ALWAYS
   * and current; the schema, both tables, the guard function and the
   * SECURITY DEFINER purge are owned by broker_migrate, both functions with
   * search_path=pg_catalog; broker_app has exactly INSERT+SELECT on the mint
   * log, SELECT on the purge log and EXECUTE on the purge;
   * broker_app can't UPDATE, DELETE or TRUNCATE either table, and isn't a
   * superuser, bypassrls or a member of broker_migrate. "privileges" is any
   * failure of the ownership or role checks.
   */
  state: "ok" | "missing" | "disabled" | "outdated" | "privileges";
}

const STORE_TABLES = ["federated_connector_mint_log", "broker_purge_log"];
const EXPECTED_GUARDS = STORE_TABLES.flatMap((t) =>
  ["insert_time", "append_only", "no_truncate"].map((g) => ({
    table: t,
    name: `${t}_${g}`,
  })),
);

/**
 * For the broker's health (OK/ALERT) and readiness: the guards, matched by
 * exact name and table, and the roles, checked now (not only at migration).
 */
export async function getBrokerStoreStatus(
  db: BrokerStoreDb,
): Promise<BrokerStoreStatus> {
  const { rows } = await db.query(
    `SELECT c.relname AS table, t.tgname AS name, t.tgenabled::text AS enabled,
            position($1 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $2 AND NOT t.tgisinternal`,
    [BROKER_STORE_CONTRACT, S],
  );
  const guards = EXPECTED_GUARDS.map((g) =>
    rows.find((r) => r.table === g.table && r.name === g.name),
  );
  if (guards.some((g) => g == null)) return { state: "missing" };
  if (guards.some((g) => g!.enabled === "D" || g!.enabled === "R")) {
    return { state: "disabled" };
  }
  if (guards.some((g) => g!.enabled !== "A" || !g!.current)) {
    return { state: "outdated" };
  }
  const roles = await db.query(
    `SELECT
       (SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = ANY($2::text[])
           AND pg_get_userbyid(c.relowner) = '${BROKER_MIGRATE_ROLE}')
         AS owned_tables,
       (SELECT count(*) FROM pg_namespace n
         WHERE n.nspname = $1
           AND pg_get_userbyid(n.nspowner) = '${BROKER_MIGRATE_ROLE}')
         AS owned_schema,
       (SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = 'broker_purge_mint_log'
           AND p.prosecdef
           AND pg_get_userbyid(p.proowner) = '${BROKER_MIGRATE_ROLE}'
           AND p.proconfig = ARRAY['search_path=pg_catalog'])
         AS owned_purge,
       (SELECT count(*) FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proname = 'broker_append_only_guard'
           AND NOT p.prosecdef
           AND pg_get_userbyid(p.proowner) = '${BROKER_MIGRATE_ROLE}'
           AND p.proconfig = ARRAY['search_path=pg_catalog'])
         AS owned_guard,
       (has_table_privilege('${BROKER_APP_ROLE}',
          format('%I.federated_connector_mint_log', $1::text), 'INSERT')
        AND has_table_privilege('${BROKER_APP_ROLE}',
          format('%I.federated_connector_mint_log', $1::text), 'SELECT')
        AND has_table_privilege('${BROKER_APP_ROLE}',
          format('%I.broker_purge_log', $1::text), 'SELECT')
        AND NOT has_table_privilege('${BROKER_APP_ROLE}',
          format('%I.broker_purge_log', $1::text), 'INSERT')
        AND has_function_privilege('${BROKER_APP_ROLE}',
          format('%I.broker_purge_mint_log()', $1::text), 'EXECUTE'))
         AS app_grants_exact,
       (SELECT bool_or(has_table_privilege('${BROKER_APP_ROLE}',
                         format('%I.%I', $1::text, t), priv))
          FROM unnest($2::text[]) AS t,
               unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) AS priv)
         AS app_can_change,
       (SELECT rolsuper OR rolbypassrls FROM pg_roles
         WHERE rolname = '${BROKER_APP_ROLE}') AS app_privileged,
       pg_has_role('${BROKER_APP_ROLE}', '${BROKER_MIGRATE_ROLE}', 'MEMBER')
         AS app_is_owner`,
    [S, STORE_TABLES],
  );
  const r = roles.rows[0] ?? {};
  if (
    Number(r.owned_tables) !== STORE_TABLES.length ||
    Number(r.owned_schema) !== 1 ||
    Number(r.owned_purge) !== 1 ||
    Number(r.owned_guard) !== 1 ||
    r.app_grants_exact !== true ||
    r.app_can_change !== false ||
    r.app_privileged !== false ||
    r.app_is_owner !== false
  ) {
    return { state: "privileges" };
  }
  return { state: "ok" };
}

/** Appends a mint log row as broker_app. The database sets its time. */
export const BROKER_STORE_RECORD_MINT_SQL = `INSERT INTO ${S}.federated_connector_mint_log
       (mint_id, time, outcome, reason, site_id, account_id, agent_id,
        project_id, host_id, run_id, connection_id, grant_id, grant_revision,
        lease_id, jti, key_version, service_account, issued_at, expires_at)
     VALUES (gen_random_uuid(), clock_timestamp(), $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13, $14, $15,
             CASE WHEN $16::BIGINT IS NULL THEN NULL
                  ELSE to_timestamp($16::BIGINT / 1000.0) END,
             CASE WHEN $17::BIGINT IS NULL THEN NULL
                  ELSE to_timestamp($17::BIGINT / 1000.0) END)`;

/** Runs the retention purge as broker_app; returns the rows deleted. */
export async function purgeBrokerMintLog(db: BrokerStoreDb): Promise<number> {
  const { rows } = await db.query(
    `SELECT ${S}.broker_purge_mint_log() AS deleted`,
  );
  return Number(rows[0]?.deleted ?? 0);
}
