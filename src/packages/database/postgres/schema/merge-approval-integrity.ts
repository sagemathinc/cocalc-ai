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

Installed by schema sync; a change to these functions bumps the contract so
that sync replaces them.
*/

import type { Client } from "@cocalc/database/pool";

const CONTRACT = "merge-approval-integrity-v1";
const RETENTION = "13 months";

const TABLES = [
  "merge_approval_requests",
  "merge_approval_decisions",
  "merge_approval_relays",
] as const;

export const MERGE_APPROVAL_TRIGGERS = [
  {
    table: "merge_approval_requests",
    trigger: "merge_approval_requests_integrity_trigger",
    fn: "merge_approval_requests_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
  },
  {
    table: "merge_approval_decisions",
    trigger: "merge_approval_decisions_integrity_trigger",
    fn: "merge_approval_decisions_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
  },
  {
    table: "merge_approval_relays",
    trigger: "merge_approval_relays_integrity_trigger",
    fn: "merge_approval_relays_integrity",
    when: "BEFORE INSERT OR UPDATE OR DELETE",
    level: "ROW",
  },
  // Row triggers don't see TRUNCATE.
  ...TABLES.map((table) => ({
    table,
    trigger: `${table}_no_truncate_trigger`,
    fn: "merge_approval_refuse_truncate",
    when: "BEFORE TRUNCATE",
    level: "STATEMENT",
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

async function triggerState(
  db: Pick<Client, "query">,
  table: string,
  trigger: string,
): Promise<"ok" | "missing" | "disabled" | "outdated"> {
  const { rows } = await db.query<{
    enabled: string | null;
    current: boolean | null;
  }>(
    `SELECT t.tgenabled::text AS enabled,
            position($3 IN pg_get_functiondef(t.tgfoid)) > 0 AS current
       FROM pg_trigger t
      WHERE t.tgname=$1
        AND t.tgrelid=to_regclass($2)
        AND NOT t.tgisinternal`,
    [trigger, table, CONTRACT],
  );
  const row = rows[0];
  if (row == null) return "missing";
  if (row.enabled !== "O" && row.enabled !== "A") return "disabled";
  return row.current ? "ok" : "outdated";
}

export async function ensureMergeApprovalIntegritySchema(
  db: Client,
): Promise<void> {
  for (const sql of FUNCTIONS_SQL) {
    await db.query(sql);
  }
  for (const { table, trigger, fn, when, level } of MERGE_APPROVAL_TRIGGERS) {
    if ((await triggerState(db, table, trigger)) === "missing") {
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
  for (const { table, trigger } of MERGE_APPROVAL_TRIGGERS) {
    const state = await triggerState(db, table, trigger);
    if (state === "missing" || state === "outdated") return true;
  }
  return false;
}

// Test databases only: their reset truncates every table, which these
// triggers refuse. Truncates the given tables in one transaction with the
// truncate guards disabled just for it, so they are back on whether or not
// it succeeds. Production code never truncates them.
export async function truncateTablesForTestReset(
  db: Pick<Client, "query">,
  tableNames: string[],
): Promise<void> {
  if (tableNames.length === 0) return;
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
  for (const { table, trigger } of MERGE_APPROVAL_TRIGGERS) {
    const state = await triggerState(db, table, trigger);
    if (state !== "ok") {
      throw new Error(
        `merge approvals are unavailable: integrity trigger ${trigger} is ${state}`,
      );
    }
  }
}
