/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Integrity of merge approval records (util/db-schema/merge-approvals.ts),
enforced in the database so that no code path, however wrong, can rewrite one:

- merge_approval_decisions and merge_approval_relays are append-only: no
  UPDATE, and no DELETE until the retention period has passed.
- A decision can only be inserted for a request that is pending and not
  expired; a relay only for an approve decision.
- A request starts pending, and its fields never change, except its status, which can only move
  pending -> approved | rejected | superseded | withdrawn | expired, or
  approved -> superseded; approved and rejected need the matching decision to
  be recorded first. Requests are deleted only after the retention period.
- None of the tables can be truncated.

These triggers guard against application bugs and compromised application
code paths. They don't guard against someone holding the table-owner role,
who can disable or drop them; that is why approvals are also recorded on
GitHub (the relayed review and status) and checked by the weekly
reconcile.

Installed by schema sync; a change to these functions bumps the contract so
that sync replaces them.
*/

import type { Client } from "@cocalc/database/pool";
import { isPgliteEnabled } from "@cocalc/database/pool/pglite";

// The only databases truncateTablesForTestReset works on.
const TEST_DATABASE = "smc_ephemeral_testing_database";

const CONTRACT = "merge-approval-integrity-v1";
const RETENTION = "13 months";

const TABLES = [
  "merge_approval_requests",
  "merge_approval_decisions",
  "merge_approval_relays",
] as const;

// pg_trigger.tgtype bits (PostgreSQL's TRIGGER_TYPE_*).
const TRIGGER_ROW = 1;
const TRIGGER_BEFORE = 2;
const TRIGGER_INSERT = 4;
const TRIGGER_DELETE = 8;
const TRIGGER_UPDATE = 16;
const TRIGGER_TRUNCATE = 32;
const ROW_BEFORE_IUD =
  TRIGGER_ROW |
  TRIGGER_BEFORE |
  TRIGGER_INSERT |
  TRIGGER_DELETE |
  TRIGGER_UPDATE;
const STATEMENT_BEFORE_TRUNCATE = TRIGGER_BEFORE | TRIGGER_TRUNCATE;

export const MERGE_APPROVAL_TRIGGERS = [
  {
    table: "merge_approval_requests",
    trigger: "merge_approval_requests_integrity_trigger",
    fn: "merge_approval_requests_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
    tgtype: ROW_BEFORE_IUD,
  },
  {
    table: "merge_approval_decisions",
    trigger: "merge_approval_decisions_integrity_trigger",
    fn: "merge_approval_decisions_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
    tgtype: ROW_BEFORE_IUD,
  },
  {
    table: "merge_approval_relays",
    trigger: "merge_approval_relays_integrity_trigger",
    fn: "merge_approval_relays_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
    tgtype: ROW_BEFORE_IUD,
  },
  // Row triggers don't see TRUNCATE.
  ...TABLES.map((table) => ({
    table,
    trigger: `${table}_no_truncate_trigger`,
    fn: "merge_approval_refuse_truncate",
    when: "BEFORE TRUNCATE",
    level: "STATEMENT",
    tgtype: STATEMENT_BEFORE_TRUNCATE,
  })),
] as const;

// One statement per query (some drivers refuse several in one).
const FUNCTIONS_SQL = [
  `
CREATE OR REPLACE FUNCTION merge_approval_requests_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
-- ${CONTRACT}
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'merge approval requests start pending'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.created_at >= now() - interval '${RETENTION}' THEN
      RAISE EXCEPTION 'merge approval requests are kept for ${RETENTION}'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.repo IS DISTINCT FROM OLD.repo
     OR NEW.pr_number IS DISTINCT FROM OLD.pr_number
     OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
     OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
     OR NEW.github_snapshot IS DISTINCT FROM OLD.github_snapshot
     OR NEW.agent_note IS DISTINCT FROM OLD.agent_note
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.chat IS DISTINCT FROM OLD.chat
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'merge approval requests cannot be changed, except their status'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN
        ('approved','rejected','superseded','withdrawn','expired'))
      OR (OLD.status = 'approved' AND NEW.status = 'superseded')
    ) THEN
      RAISE EXCEPTION 'merge approval request cannot go from % to %',
        OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('approved','rejected') AND NOT EXISTS (
      SELECT 1 FROM merge_approval_decisions d
       WHERE d.request_id = NEW.id
         AND d.decision = CASE NEW.status WHEN 'approved' THEN 'approve'
                                          ELSE 'reject' END
    ) THEN
      RAISE EXCEPTION 'merge approval request % needs a recorded decision', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
`,
  `
CREATE OR REPLACE FUNCTION merge_approval_decisions_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
-- ${CONTRACT}
DECLARE
  req record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'merge approval decisions are append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.decided_at >= now() - interval '${RETENTION}' THEN
      RAISE EXCEPTION 'merge approval decisions are kept for ${RETENTION}'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status, expires_at INTO req
    FROM merge_approval_requests WHERE id = NEW.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown merge approval request'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF req.status <> 'pending' THEN
    RAISE EXCEPTION 'merge approval request is %, not pending', req.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF req.expires_at <= now() THEN
    RAISE EXCEPTION 'merge approval request has expired'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
`,
  `
CREATE OR REPLACE FUNCTION merge_approval_relays_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
-- ${CONTRACT}
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'merge approval relays are append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.attempted_at >= now() - interval '${RETENTION}' THEN
      RAISE EXCEPTION 'merge approval relays are kept for ${RETENTION}'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM merge_approval_decisions d
     WHERE d.id = NEW.decision_id AND d.request_id = NEW.request_id
       AND d.decision = 'approve'
  ) THEN
    RAISE EXCEPTION 'merge approval relays need an approve decision'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
`,
  `
CREATE OR REPLACE FUNCTION merge_approval_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
-- ${CONTRACT}
BEGIN
  RAISE EXCEPTION 'merge approval records cannot be truncated'
    USING ERRCODE = 'check_violation';
END;
$$;
`,
];

type TriggerState = "ok" | "missing" | "mismatched" | "disabled" | "outdated";

// A trigger counts only if it is exactly the one sync creates: on this table,
// BEFORE the right events at the right level, calling the right function, with
// no WHEN clause or column list, enabled, and with the current function body.
async function triggerState(
  db: Pick<Client, "query">,
  { table, trigger, fn, tgtype }: (typeof MERGE_APPROVAL_TRIGGERS)[number],
): Promise<TriggerState> {
  const { rows } = await db.query<{
    enabled: string | null;
    shape: boolean | null;
    current: boolean | null;
  }>(
    `SELECT t.tgenabled::text AS enabled,
            (t.tgtype = $4
             AND p.proname = $3 AND p.pronargs = 0
             AND p.pronamespace = c.relnamespace
             AND t.tgqual IS NULL
             AND cardinality(t.tgattr::int2[]) = 0) AS shape,
            position($5 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname=$1
        AND t.tgrelid=to_regclass($2)
        AND NOT t.tgisinternal`,
    [trigger, table, fn, tgtype, CONTRACT],
  );
  const row = rows[0];
  if (row == null) return "missing";
  if (!row.shape) return "mismatched";
  if (row.enabled !== "O" && row.enabled !== "A") return "disabled";
  return row.current ? "ok" : "outdated";
}

export async function ensureMergeApprovalIntegritySchema(
  db: Client,
): Promise<void> {
  for (const sql of FUNCTIONS_SQL) {
    await db.query(sql);
  }
  for (const spec of MERGE_APPROVAL_TRIGGERS) {
    const { table, trigger, fn, when, level } = spec;
    const state = await triggerState(db, spec);
    if (state === "mismatched") {
      // Not the trigger sync creates (wrong events, level, function, ...):
      // replace it.
      await db.query(`DROP TRIGGER ${trigger} ON ${table}`);
    }
    if (state === "missing" || state === "mismatched") {
      await db.query(
        `CREATE TRIGGER ${trigger} ${when} ON ${table}
           FOR EACH ${level} EXECUTE FUNCTION ${fn}()`,
      );
    }
  }
}

// A disabled trigger is not re-enabled here: that was deliberate, and admin
// health should report it.
export async function mergeApprovalIntegritySchemaNeedsSync(
  db: Pick<Client, "query">,
): Promise<boolean> {
  for (const spec of MERGE_APPROVAL_TRIGGERS) {
    const state = await triggerState(db, spec);
    if (state === "missing" || state === "mismatched" || state === "outdated") {
      return true;
    }
  }
  return false;
}

// Test databases only: their reset truncates every table, which these
// triggers refuse. Truncates the given tables in one transaction with the
// truncate guards disabled just for it, so they are back on whether or not
// it succeeds. It refuses anywhere but the ephemeral test database or a
// PGlite test run (Lite also runs on PGlite, so PGlite alone isn't enough).
export async function truncateTablesForTestReset(
  db: Pick<Client, "query">,
  tableNames: string[],
): Promise<void> {
  if (tableNames.length === 0) return;
  const pgliteTest =
    isPgliteEnabled() && process.env.COCALC_TEST_USE_PGLITE === "1";
  if (!pgliteTest) {
    const { rows } = await db.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (rows[0]?.name !== TEST_DATABASE) {
      throw new Error(
        `truncateTablesForTestReset only runs on the test database (${TEST_DATABASE})`,
      );
    }
  }
  const { rows } = await db.query<{ table: string; trigger: string }>(
    `SELECT c.relname AS table, t.tgname AS trigger
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgname = ANY($1) AND NOT t.tgisinternal`,
    [
      MERGE_APPROVAL_TRIGGERS.filter((t) => t.level === "STATEMENT").map(
        (t) => t.trigger,
      ),
    ],
  );
  const guards = rows.filter((r) => tableNames.includes(r.table));
  await db.query("BEGIN");
  try {
    for (const { table, trigger } of guards) {
      await db.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    }
    await db.query(`TRUNCATE ${tableNames.join(",")}`);
    for (const { table, trigger } of guards) {
      await db.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  }
}

// Writers call this first and refuse to record anything while a trigger is
// missing, disabled or outdated: the records are only as good as the triggers.
export async function assertMergeApprovalIntegrity(
  db: Pick<Client, "query">,
): Promise<void> {
  for (const spec of MERGE_APPROVAL_TRIGGERS) {
    const { trigger } = spec;
    const state = await triggerState(db, spec);
    if (state !== "ok") {
      throw new Error(
        `merge approvals are unavailable: integrity trigger ${trigger} is ${state}`,
      );
    }
  }
}
