/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Database guards for the federated connector tables written by agent turns and
by access changes (util/db-schema/federated-connectors.ts):

- federated_connector_assignment_audit is append-only, exactly like the mint
  log (./federated-connector-mint-log.ts): no UPDATE, no TRUNCATE, DELETE only
  for rows older than the retention period, and time is the database clock.
- federated_connector_turn_leases: a lease is inserted open, its binding
  never changes, and it ends exactly once, with ended_at from the database
  clock. An ended row can't change at all; DELETE only for rows that ended
  more than the retention period ago; no TRUNCATE.
- federated_connector_shared_project_approvals: an approval is inserted
  active, its binding never changes, and it is revoked exactly once (by an
  owner, or when the project leaves this bay), with revoked_at from the
  database clock. DELETE is allowed (project hard delete
  and the retention purge); the audit table holds the evidence.

Every trigger is enabled ALWAYS, so it also fires for sessions in replica
mode. A trigger someone disabled is reported, never silently re-enabled.
*/

import type { Client } from "@cocalc/database/pool";

// At least 13 months (audit evidence).
export const FEDERATED_CONNECTOR_RETENTION = "13 months";

type Db = Pick<Client, "query">;

interface Guard {
  table: string;
  // Installed only when these tables exist too.
  requires?: string[];
  fn: string;
  // Bump when the function changes, so schema sync replaces it.
  contract: string;
  triggers: Array<{ name: string; timing: string; level: "ROW" | "STATEMENT" }>;
  body: string;
}

const AUDIT_TABLE = "federated_connector_assignment_audit";
const LEASE_TABLE = "federated_connector_turn_leases";
const APPROVAL_TABLE = "federated_connector_shared_project_approvals";
const PROJECTS_TABLE = "projects";

const LEASE_BINDING = [
  "lease_id",
  "account_id",
  "agent_id",
  "source_project_id",
  "run_id",
  "turn_key",
  "host_id",
  "assignment_id",
  "assignment_revision",
  "grant_id",
  "grant_revision",
  "approval_id",
  "created_at",
];

const APPROVAL_BINDING = [
  "approval_id",
  "project_id",
  "account_id",
  "approver_account_id",
  "created_at",
];

function changed(columns: string[]): string {
  const row = (r: string) => `(${columns.map((c) => `${r}.${c}`).join(",")})`;
  return `${row("NEW")} IS DISTINCT FROM ${row("OLD")}`;
}

function refuse(table: string, what: string): string {
  return `RAISE EXCEPTION '${table}: % refused (${what})', TG_OP
         USING ERRCODE = 'insufficient_privilege';`;
}

export const FEDERATED_CONNECTOR_GUARDS: Guard[] = [
  {
    table: AUDIT_TABLE,
    fn: "federated_connector_assignment_audit_guard",
    contract: "federated-assignment-audit-append-only-v1",
    triggers: [
      {
        name: "federated_connector_assignment_audit_append_only",
        timing: "BEFORE UPDATE OR DELETE",
        level: "ROW",
      },
      {
        name: "federated_connector_assignment_audit_no_truncate",
        timing: "BEFORE TRUNCATE",
        level: "STATEMENT",
      },
      {
        name: "federated_connector_assignment_audit_insert_time",
        timing: "BEFORE INSERT",
        level: "ROW",
      },
    ],
    body: `
     IF TG_OP = 'INSERT' THEN
       NEW.time := clock_timestamp();
       RETURN NEW;
     END IF;
     IF TG_OP = 'DELETE'
        AND OLD.time < NOW() - INTERVAL '${FEDERATED_CONNECTOR_RETENTION}' THEN
       RETURN OLD;
     END IF;
     ${refuse(AUDIT_TABLE, "append-only")}`,
  },
  {
    table: LEASE_TABLE,
    fn: "federated_connector_turn_leases_guard",
    contract: "federated-turn-leases-end-once-v1",
    triggers: [
      {
        name: "federated_connector_turn_leases_row_guard",
        timing: "BEFORE INSERT OR UPDATE OR DELETE",
        level: "ROW",
      },
      {
        name: "federated_connector_turn_leases_no_truncate",
        timing: "BEFORE TRUNCATE",
        level: "STATEMENT",
      },
    ],
    body: `
     IF TG_OP = 'INSERT' THEN
       NEW.created_at := clock_timestamp();
       NEW.ended_at := NULL;
       NEW.end_reason := NULL;
       RETURN NEW;
     END IF;
     IF TG_OP = 'DELETE' THEN
       IF OLD.ended_at IS NOT NULL
          AND OLD.ended_at < NOW() - INTERVAL '${FEDERATED_CONNECTOR_RETENTION}' THEN
         RETURN OLD;
       END IF;
       ${refuse(LEASE_TABLE, "only leases ended before the retention period may be deleted")}
     END IF;
     IF TG_OP = 'UPDATE' THEN
       IF OLD.ended_at IS NOT NULL THEN
         ${refuse(LEASE_TABLE, "an ended lease is immutable")}
       END IF;
       IF ${changed(LEASE_BINDING)} THEN
         ${refuse(LEASE_TABLE, "the lease binding is immutable")}
       END IF;
       IF NEW.ended_at IS NULL OR NEW.end_reason IS NULL THEN
         ${refuse(LEASE_TABLE, "the only change is ending the lease")}
       END IF;
       NEW.ended_at := clock_timestamp();
       RETURN NEW;
     END IF;
     ${refuse(LEASE_TABLE, "truncate")}`,
  },
  {
    table: APPROVAL_TABLE,
    fn: "federated_connector_shared_project_approvals_guard",
    contract: "federated-shared-approvals-revoke-once-v1",
    triggers: [
      {
        name: "federated_connector_shared_project_approvals_row_guard",
        timing: "BEFORE INSERT OR UPDATE",
        level: "ROW",
      },
    ],
    body: `
     IF TG_OP = 'INSERT' THEN
       NEW.created_at := clock_timestamp();
       NEW.revoked_at := NULL;
       NEW.revoked_by := NULL;
       NEW.revoke_reason := NULL;
       RETURN NEW;
     END IF;
     IF OLD.revoked_at IS NOT NULL THEN
       ${refuse(APPROVAL_TABLE, "a revoked approval is immutable")}
     END IF;
     IF ${changed(APPROVAL_BINDING)} THEN
       ${refuse(APPROVAL_TABLE, "the approval binding is immutable")}
     END IF;
     IF NEW.revoked_at IS NULL OR NEW.revoke_reason IS NULL THEN
       ${refuse(APPROVAL_TABLE, "the only change is revoking the approval")}
     END IF;
     NEW.revoked_at := clock_timestamp();
     RETURN NEW;`,
  },
  {
    table: PROJECTS_TABLE,
    requires: [APPROVAL_TABLE, AUDIT_TABLE],
    fn: "federated_connector_approver_demotion",
    contract: "federated-approver-demotion-revokes-v1",
    triggers: [
      {
        name: "federated_connector_approver_demotion",
        timing: "AFTER UPDATE OF users",
        level: "ROW",
      },
    ],
    body: `
     IF NEW.users IS NOT DISTINCT FROM OLD.users THEN
       RETURN NULL;
     END IF;
     WITH revoked AS (
       UPDATE ${APPROVAL_TABLE} a
          SET revoked_at = clock_timestamp(), revoke_reason = 'approver-demoted'
        WHERE a.project_id = NEW.project_id
          AND a.revoked_at IS NULL
          AND COALESCE(
                CASE jsonb_typeof(NEW.users -> a.approver_account_id::text)
                  WHEN 'string' THEN NEW.users ->> a.approver_account_id::text
                  ELSE NEW.users -> a.approver_account_id::text ->> 'group'
                END, '') <> 'owner'
        RETURNING a.approval_id, a.project_id, a.account_id, a.approver_account_id
     )
     INSERT INTO ${AUDIT_TABLE}
       (id, action, actor_account_id, account_id, source_project_id,
        approval_id, before, after)
     SELECT gen_random_uuid(), 'shared-revoke', NULL, account_id, project_id,
            approval_id,
            jsonb_build_object('approver_account_id', approver_account_id),
            jsonb_build_object('reason', 'approver-demoted')
       FROM revoked;
     RETURN NULL;`,
  },
];

function installed(guard: Guard, tables: ReadonlySet<string>): boolean {
  return (
    tables.has(guard.table) &&
    (guard.requires ?? []).every((t) => tables.has(t))
  );
}

function functionSql(guard: Guard): string {
  return `CREATE OR REPLACE FUNCTION ${guard.fn}()
   RETURNS TRIGGER AS $$
   -- ${guard.contract}
   BEGIN${guard.body}
   END;
   $$ LANGUAGE plpgsql`;
}

async function triggerNames(db: Db, table: string): Promise<string[]> {
  const { rows } = await db.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid=$1::regclass AND NOT tgisinternal`,
    [table],
  );
  return rows.map(({ tgname }) => tgname);
}

async function ensureGuard(db: Client, guard: Guard): Promise<void> {
  await db.query(functionSql(guard));
  const existing = await triggerNames(db, guard.table);
  for (const trigger of guard.triggers) {
    if (!existing.includes(trigger.name)) {
      await db.query(
        `CREATE TRIGGER ${trigger.name}
           ${trigger.timing}
           ON ${guard.table}
           FOR EACH ${trigger.level}
           EXECUTE FUNCTION ${guard.fn}()`,
      );
    }
  }
  for (const trigger of guard.triggers) {
    const { rows } = await db.query<{ enabled: string }>(
      `SELECT tgenabled::text AS enabled FROM pg_trigger
        WHERE tgrelid=$1::regclass AND tgname=$2 AND NOT tgisinternal`,
      [guard.table, trigger.name],
    );
    if (rows[0]?.enabled === "O") {
      await db.query(
        `ALTER TABLE ${guard.table} ENABLE ALWAYS TRIGGER ${trigger.name}`,
      );
    }
  }
}

/** Installs the guards for the tables present in the schema. */
export async function ensureFederatedConnectorGuards(
  db: Client,
  tables: ReadonlySet<string>,
): Promise<void> {
  for (const guard of FEDERATED_CONNECTOR_GUARDS) {
    if (installed(guard, tables)) {
      await ensureGuard(db, guard);
    }
  }
}

export type FederatedConnectorGuardState =
  | "ok"
  | "missing"
  | "disabled"
  | "outdated";

export async function getFederatedConnectorGuardStatus(
  db: Db,
  table: string,
): Promise<FederatedConnectorGuardState> {
  const guard = FEDERATED_CONNECTOR_GUARDS.find((g) => g.table === table);
  // (Each table has at most one guard.)
  if (guard == null) {
    throw Error(`no federated connector guard for ${table}`);
  }
  const names = guard.triggers.map(({ name }) => name);
  const { rows } = await db.query<{ enabled: string; current: boolean }>(
    `SELECT t.tgenabled::text AS enabled,
            position($2 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
      WHERE t.tgrelid=$1::regclass
        AND NOT t.tgisinternal
        AND t.tgname = ANY($3::text[])`,
    [guard.table, guard.contract, names],
  );
  if (rows.length < names.length) return "missing";
  // D (disabled) and R (replica only) don't fire for ordinary writes.
  if (rows.some((r) => r.enabled === "D" || r.enabled === "R")) {
    return "disabled";
  }
  // O fires, but not in replica mode: sync upgrades it to A.
  if (rows.some((r) => !r.current || r.enabled !== "A")) return "outdated";
  return "ok";
}

// A disabled trigger is not repaired here (someone disabled it on purpose);
// admin health reports it.
export async function federatedConnectorGuardsNeedSync(
  db: Db,
  tables: ReadonlySet<string>,
): Promise<boolean> {
  for (const guard of FEDERATED_CONNECTOR_GUARDS) {
    if (!installed(guard, tables)) continue;
    const state = await getFederatedConnectorGuardStatus(db, guard.table);
    if (state === "missing" || state === "outdated") return true;
  }
  return false;
}

/** Retention purge (G3b scheduler): rows past retention on these tables. */
export async function purgeExpiredFederatedConnectorRecords(
  db: Db,
): Promise<{ audit: number; leases: number; approvals: number }> {
  const interval = `INTERVAL '${FEDERATED_CONNECTOR_RETENTION}'`;
  const audit = await db.query(
    `DELETE FROM ${AUDIT_TABLE} WHERE time < NOW() - ${interval}`,
  );
  const leases = await db.query(
    `DELETE FROM ${LEASE_TABLE}
      WHERE ended_at IS NOT NULL AND ended_at < NOW() - ${interval}`,
  );
  const approvals = await db.query(
    `DELETE FROM ${APPROVAL_TABLE}
      WHERE revoked_at IS NOT NULL AND revoked_at < NOW() - ${interval}`,
  );
  return {
    audit: audit.rowCount ?? 0,
    leases: leases.rowCount ?? 0,
    approvals: approvals.rowCount ?? 0,
  };
}
