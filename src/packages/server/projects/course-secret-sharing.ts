/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import type {
  CourseSecretGrant,
  CourseSecretPolicy,
  CourseSecretPolicyState,
  CourseSecretRecipient,
  CourseSecretSyncResult,
  CourseSecretSyncRun,
  CourseSecretSyncStatusResult,
} from "@cocalc/conat/hub/api/projects";
import getPool from "@cocalc/database/pool";
import { normalizeCoursePath } from "@cocalc/util/course-path";
import { isValidUUID } from "@cocalc/util/misc";
import { normalizeProjectSecretName } from "@cocalc/util/project-secrets";

const logger = getLogger("server:projects:course-secret-sharing");

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

const MAX_RECIPIENTS = 1_000;
const MAX_GRANTS = 20;

function pool(): Queryable {
  return getPool();
}

async function transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await (getPool() as any).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.warn("course secret sharing rollback failed", {
        err: `${rollbackErr}`,
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

function uuid(value: string, label: string): string {
  if (!isValidUUID(value)) throw new Error(`invalid ${label}`);
  return value;
}

function projectIds(values: string[]): string[] {
  const ids = Array.from(new Set(values ?? []));
  for (const id of ids) uuid(id, "recipient project id");
  if (ids.length > MAX_RECIPIENTS) {
    throw new Error(
      `course secret recipient limit reached (${MAX_RECIPIENTS})`,
    );
  }
  return ids;
}

function secretNames(values: string[]): string[] {
  const names = Array.from(
    new Set((values ?? []).map(normalizeProjectSecretName)),
  ).sort();
  if (names.length > MAX_GRANTS) {
    throw new Error(`course secret grant limit reached (${MAX_GRANTS})`);
  }
  return names;
}

function policy(row: any): CourseSecretPolicy {
  return {
    policy_id: row.policy_id,
    course_project_id: row.project_id,
    course_id: row.course_id,
    course_path: row.course_path,
    enabled: row.enabled === true,
    generation: Number(row.generation),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null,
  };
}

function grant(row: any): CourseSecretGrant {
  return {
    grant_id: row.grant_id,
    name: row.source_secret_name,
    enabled: row.enabled === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null,
  };
}

function recipient(row: any): CourseSecretRecipient {
  return {
    target_project_id: row.target_project_id,
    student_account_id: row.student_account_id ?? null,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    revoked_by: row.revoked_by ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

function syncRun(row: any): CourseSecretSyncRun {
  return {
    run_id: row.run_id,
    policy_id: row.policy_id,
    policy_generation: Number(row.policy_generation),
    mode: row.mode,
    status: row.status,
    requested_secret_names: row.requested_secret_names ?? [],
    requested_target_count: Number(row.requested_target_count ?? 0),
    copied_count: Number(row.copied_count ?? 0),
    unchanged_count: Number(row.unchanged_count ?? 0),
    conflict_count: Number(row.conflict_count ?? 0),
    skipped_count: Number(row.skipped_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    created_at: row.created_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
    error_code: row.error_code ?? null,
  };
}

function syncResult(row: any): CourseSecretSyncResult {
  return {
    run_id: row.run_id,
    target_project_id: row.target_project_id,
    secret_name: row.secret_name,
    source_revision:
      row.source_revision == null ? null : Number(row.source_revision),
    status: row.status,
    error_code: row.error_code ?? null,
    runtime_status: row.runtime_status ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Run once per process: the setup includes ALTER TABLE, which takes an ACCESS
// EXCLUSIVE lock even when nothing changes and queues every later query on the
// table behind any open transaction (production outage 2026-10-06).
let courseSecretSharingSchemaReady = false;
let courseSecretSharingSchemaSetup: Promise<void> | undefined;

function courseSecretSharingSchemaSetupOnPool(): Promise<void> {
  // Shared by concurrent callers; retried after a failure.
  courseSecretSharingSchemaSetup ??= createCourseSecretSharingSchema(
    pool(),
  ).then(
    () => {
      courseSecretSharingSchemaReady = true;
    },
    (err) => {
      courseSecretSharingSchemaSetup = undefined;
      throw err;
    },
  );
  return courseSecretSharingSchemaSetup;
}

export async function ensureCourseSecretSharingSchema(
  db: Queryable = pool(),
): Promise<void> {
  if (courseSecretSharingSchemaReady) return;
  if (db === pool()) return await courseSecretSharingSchemaSetupOnPool();
  // Inside a caller's transaction: create what it needs there (that may still
  // roll back), and finish the setup on the pool once the caller's locks are
  // released. Never wait for it here: the caller's transaction may hold locks
  // on these tables.
  await createCourseSecretSharingSchema(db);
  void courseSecretSharingSchemaSetupOnPool().catch(() => {});
}

async function createCourseSecretSharingSchema(db: Queryable): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_policies (
    policy_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    course_id UUID NOT NULL,
    course_path TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    generation BIGINT NOT NULL DEFAULT 1,
    created_by UUID NOT NULL,
    updated_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    UNIQUE(project_id, course_id)
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS course_secret_policies_path_idx
    ON course_secret_policies(project_id, course_path) WHERE revoked_at IS NULL`);
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_grants (
    grant_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES course_secret_policies(policy_id) ON DELETE CASCADE,
    source_secret_name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID NOT NULL,
    updated_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    UNIQUE(policy_id, source_secret_name)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_recipients (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES course_secret_policies(policy_id) ON DELETE CASCADE,
    target_project_id UUID NOT NULL,
    student_account_id UUID,
    approved_by UUID NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_by UUID,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY(policy_id, target_project_id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_sync_runs (
    run_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES course_secret_policies(policy_id) ON DELETE CASCADE,
    policy_generation BIGINT NOT NULL,
    actor_account_id UUID NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('sync', 'cleanup')),
    status TEXT NOT NULL CHECK(status IN ('pending','running','completed','partial','failed','cancelled')),
    requested_secret_names TEXT[] NOT NULL DEFAULT '{}',
    requested_target_count INTEGER NOT NULL DEFAULT 0,
    copied_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_code TEXT
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS course_secret_sync_runs_policy_idx
    ON course_secret_sync_runs(policy_id, created_at DESC)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS course_secret_sync_runs_active_idx
    ON course_secret_sync_runs(policy_id)
    WHERE status IN ('pending','running')`);
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_sync_results (
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES course_secret_sync_runs(run_id) ON DELETE CASCADE,
    target_project_id UUID NOT NULL,
    secret_name TEXT NOT NULL,
    source_revision BIGINT,
    status TEXT NOT NULL,
    error_code TEXT,
    runtime_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(run_id, target_project_id, secret_name)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS course_secret_audit_events (
    event_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    policy_id UUID,
    actor_account_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    target_project_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // These rows name the acting account, which may be homed on another bay
  // and have no local `accounts` row, so they must not reference accounts.
  await db.query(`
    ALTER TABLE course_secret_policies
      DROP CONSTRAINT IF EXISTS course_secret_policies_created_by_fkey,
      DROP CONSTRAINT IF EXISTS course_secret_policies_updated_by_fkey
  `);
  await db.query(`
    ALTER TABLE course_secret_grants
      DROP CONSTRAINT IF EXISTS course_secret_grants_created_by_fkey,
      DROP CONSTRAINT IF EXISTS course_secret_grants_updated_by_fkey
  `);
  await db.query(`
    ALTER TABLE course_secret_recipients
      DROP CONSTRAINT IF EXISTS course_secret_recipients_approved_by_fkey,
      DROP CONSTRAINT IF EXISTS course_secret_recipients_revoked_by_fkey
  `);
  await db.query(`
    ALTER TABLE course_secret_sync_runs
      DROP CONSTRAINT IF EXISTS course_secret_sync_runs_actor_account_id_fkey
  `);
  await db.query(`
    ALTER TABLE course_secret_audit_events
      DROP CONSTRAINT IF EXISTS course_secret_audit_events_actor_account_id_fkey
  `);
}

async function audit(
  db: Queryable,
  project_id: string,
  policy_id: string,
  actor: string,
  event: string,
): Promise<void> {
  await db.query(
    `INSERT INTO course_secret_audit_events
       (event_id,project_id,policy_id,actor_account_id,event_type,created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [randomUUID(), project_id, policy_id, actor, event],
  );
}

async function getRow(
  db: Queryable,
  project_id: string,
  course_id: string,
  lock = false,
): Promise<any | undefined> {
  const { rows } = await db.query(
    `SELECT * FROM course_secret_policies WHERE project_id=$1 AND course_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [project_id, course_id],
  );
  return rows[0];
}

function checkBinding(
  row: any,
  course_path: string,
  { allow_revoked = false }: { allow_revoked?: boolean } = {},
): void {
  if (row.course_path !== normalizeCoursePath(course_path)) {
    throw new Error(
      "course identity is bound to another path; reinitialize sharing for this copied or moved course",
    );
  }
  if (!allow_revoked && row.revoked_at != null)
    throw new Error("course secret policy is revoked");
}

async function contents(
  db: Queryable,
  row: any,
): Promise<CourseSecretPolicyState> {
  const [{ rows: grants }, { rows: recipients }] = await Promise.all([
    db.query(
      "SELECT * FROM course_secret_grants WHERE policy_id=$1 ORDER BY source_secret_name",
      [row.policy_id],
    ),
    db.query(
      "SELECT * FROM course_secret_recipients WHERE policy_id=$1 ORDER BY target_project_id",
      [row.policy_id],
    ),
  ]);
  return {
    policy: policy(row),
    grants: grants.map(grant),
    recipients: recipients.map(recipient),
  };
}

async function ensurePolicy(
  db: Queryable,
  opts: {
    course_project_id: string;
    course_id: string;
    course_path: string;
    account_id: string;
  },
): Promise<any> {
  uuid(opts.course_project_id, "course project id");
  uuid(opts.course_id, "course id");
  const path = normalizeCoursePath(opts.course_path);
  const existing = await getRow(
    db,
    opts.course_project_id,
    opts.course_id,
    true,
  );
  if (existing) {
    checkBinding(existing, path);
    return existing;
  }
  const policy_id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO course_secret_policies
       (policy_id,project_id,course_id,course_path,created_by,updated_by)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [policy_id, opts.course_project_id, opts.course_id, path, opts.account_id],
  );
  await audit(
    db,
    opts.course_project_id,
    policy_id,
    opts.account_id,
    "policy_created",
  );
  return rows[0];
}

async function bump(
  db: Queryable,
  policy_id: string,
  actor: string,
): Promise<any> {
  const { rows } = await db.query(
    `UPDATE course_secret_policies SET generation=generation+1,
       updated_by=$2,updated_at=NOW() WHERE policy_id=$1 RETURNING *`,
    [policy_id, actor],
  );
  return rows[0];
}

export async function getCourseSecretPolicyState(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
}): Promise<CourseSecretPolicyState | null> {
  uuid(opts.course_project_id, "course project id");
  uuid(opts.course_id, "course id");
  await ensureCourseSecretSharingSchema();
  const row = await getRow(pool(), opts.course_project_id, opts.course_id);
  if (!row) return null;
  checkBinding(row, opts.course_path, { allow_revoked: true });
  return await contents(pool(), row);
}

export async function setCourseSecretPolicyEnabled(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  enabled: boolean;
  account_id: string;
}): Promise<CourseSecretPolicyState> {
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    let row = await ensurePolicy(db, opts);
    if (row.enabled !== opts.enabled) {
      const { rows } = await db.query(
        `UPDATE course_secret_policies SET enabled=$2,generation=generation+1,
         updated_by=$3,updated_at=NOW() WHERE policy_id=$1 RETURNING *`,
        [row.policy_id, opts.enabled, opts.account_id],
      );
      row = rows[0];
      await audit(
        db,
        opts.course_project_id,
        row.policy_id,
        opts.account_id,
        opts.enabled ? "policy_enabled" : "policy_disabled",
      );
    }
    return await contents(db, row);
  });
}

export async function setCourseSecretGrants(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  names: string[];
  account_id: string;
}): Promise<CourseSecretPolicyState> {
  const selected = secretNames(opts.names);
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    let row = await ensurePolicy(db, opts);
    if (selected.length) {
      const { rows } = await db.query(
        `SELECT name FROM project_secrets WHERE project_id=$1
         AND name=ANY($2::TEXT[]) AND allow_course_sharing=TRUE`,
        [opts.course_project_id, selected],
      );
      const found = new Set(rows.map(({ name }) => name));
      const unavailable = selected.filter((name) => !found.has(name));
      if (unavailable.length) {
        throw new Error(
          `secret(s) are not eligible for course sharing: ${unavailable.join(", ")}`,
        );
      }
    }
    const { rows: current } = await db.query(
      "SELECT * FROM course_secret_grants WHERE policy_id=$1 FOR UPDATE",
      [row.policy_id],
    );
    const byName = new Map(
      current.map((item) => [item.source_secret_name, item]),
    );
    let changed = false;
    for (const name of selected) {
      const old = byName.get(name);
      if (!old) {
        await db.query(
          `INSERT INTO course_secret_grants
           (grant_id,project_id,policy_id,source_secret_name,created_by,updated_by)
           VALUES ($1,$2,$3,$4,$5,$5)`,
          [
            randomUUID(),
            opts.course_project_id,
            row.policy_id,
            name,
            opts.account_id,
          ],
        );
        changed = true;
      } else if (!old.enabled || old.revoked_at != null) {
        await db.query(
          `UPDATE course_secret_grants SET enabled=TRUE,revoked_at=NULL,
           updated_by=$2,updated_at=NOW() WHERE grant_id=$1`,
          [old.grant_id, opts.account_id],
        );
        changed = true;
      }
    }
    for (const old of current) {
      if (
        old.enabled &&
        old.revoked_at == null &&
        !selected.includes(old.source_secret_name)
      ) {
        await db.query(
          `UPDATE course_secret_grants SET enabled=FALSE,revoked_at=NOW(),
           updated_by=$2,updated_at=NOW() WHERE grant_id=$1`,
          [old.grant_id, opts.account_id],
        );
        changed = true;
      }
    }
    if (changed) {
      row = await bump(db, row.policy_id, opts.account_id);
      await audit(
        db,
        opts.course_project_id,
        row.policy_id,
        opts.account_id,
        "grants_changed",
      );
    }
    return await contents(db, row);
  });
}

export async function approveCourseSecretRecipients(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  recipients: Array<{
    target_project_id: string;
    student_account_id?: string | null;
  }>;
  account_id: string;
}): Promise<CourseSecretPolicyState> {
  const ids = projectIds(
    opts.recipients.map(({ target_project_id }) => target_project_id),
  );
  const requested = new Map(
    opts.recipients.map((item) => [item.target_project_id, item]),
  );
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    let row = await ensurePolicy(db, opts);
    let changed = false;
    for (const target of ids) {
      const student = requested.get(target)?.student_account_id ?? null;
      if (student) uuid(student, "student account id");
      const { rows } = await db.query(
        `INSERT INTO course_secret_recipients
         (project_id,policy_id,target_project_id,student_account_id,approved_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (policy_id,target_project_id) DO UPDATE SET
           student_account_id=EXCLUDED.student_account_id,approved_by=EXCLUDED.approved_by,
           approved_at=NOW(),revoked_by=NULL,revoked_at=NULL
         WHERE course_secret_recipients.revoked_at IS NOT NULL
            OR course_secret_recipients.student_account_id IS DISTINCT FROM EXCLUDED.student_account_id
         RETURNING target_project_id`,
        [
          opts.course_project_id,
          row.policy_id,
          target,
          student,
          opts.account_id,
        ],
      );
      changed ||= rows.length > 0;
    }
    if (changed) {
      row = await bump(db, row.policy_id, opts.account_id);
      await audit(
        db,
        opts.course_project_id,
        row.policy_id,
        opts.account_id,
        "recipients_approved",
      );
    }
    return await contents(db, row);
  });
}

export async function revokeCourseSecretRecipients(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  target_project_ids: string[];
  account_id: string;
}): Promise<CourseSecretPolicyState> {
  const ids = projectIds(opts.target_project_ids);
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    let row = await getRow(db, opts.course_project_id, opts.course_id, true);
    if (!row) throw new Error("course secret policy does not exist");
    checkBinding(row, opts.course_path);
    const { rows } = await db.query(
      `UPDATE course_secret_recipients SET revoked_by=$3,revoked_at=NOW()
       WHERE policy_id=$1 AND target_project_id=ANY($2::UUID[]) AND revoked_at IS NULL
       RETURNING target_project_id`,
      [row.policy_id, ids, opts.account_id],
    );
    if (rows.length) {
      row = await bump(db, row.policy_id, opts.account_id);
      await audit(
        db,
        opts.course_project_id,
        row.policy_id,
        opts.account_id,
        "recipients_revoked",
      );
    }
    return await contents(db, row);
  });
}

export async function revokeCourseSecretPolicy(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  account_id: string;
}): Promise<CourseSecretPolicyState> {
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    const row = await getRow(db, opts.course_project_id, opts.course_id, true);
    if (!row) throw new Error("course secret policy does not exist");
    checkBinding(row, opts.course_path);
    const { rows } = await db.query(
      `UPDATE course_secret_policies SET enabled=FALSE,revoked_at=NOW(),
       generation=generation+1,updated_by=$2,updated_at=NOW()
       WHERE policy_id=$1 RETURNING *`,
      [row.policy_id, opts.account_id],
    );
    await audit(
      db,
      opts.course_project_id,
      row.policy_id,
      opts.account_id,
      "policy_revoked",
    );
    return await contents(db, rows[0]);
  });
}

export interface CourseSecretExecutionSnapshot extends CourseSecretPolicyState {
  run: CourseSecretSyncRun;
}

export async function beginCourseSecretRun(opts: {
  course_project_id: string;
  course_id: string;
  course_path: string;
  account_id: string;
  mode: "sync" | "cleanup";
}): Promise<CourseSecretExecutionSnapshot> {
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    const row = await getRow(db, opts.course_project_id, opts.course_id, true);
    if (!row) throw new Error("course secret policy does not exist");
    checkBinding(row, opts.course_path, {
      allow_revoked: opts.mode === "cleanup",
    });
    if (opts.mode === "sync" && !row.enabled)
      throw new Error("course secret policy is disabled");
    const state = await contents(db, row);
    const grants =
      opts.mode === "cleanup"
        ? state.grants
        : state.grants.filter(
            (item) => item.enabled && item.revoked_at == null,
          );
    const recipients =
      opts.mode === "cleanup"
        ? state.recipients
        : state.recipients.filter((item) => item.revoked_at == null);
    if (opts.mode === "sync" && !grants.length)
      throw new Error("no course secrets are selected");
    if (!recipients.length)
      throw new Error("no course secret recipients are approved");
    const { rows } = await db.query(
      `INSERT INTO course_secret_sync_runs
       (run_id,project_id,policy_id,policy_generation,actor_account_id,mode,status,
        requested_secret_names,requested_target_count,started_at)
       VALUES ($1,$2,$3,$4,$5,$6,'running',$7::TEXT[],$8,NOW()) RETURNING *`,
      [
        randomUUID(),
        opts.course_project_id,
        row.policy_id,
        row.generation,
        opts.account_id,
        opts.mode,
        grants.map(({ name }) => name),
        recipients.length,
      ],
    );
    await audit(
      db,
      opts.course_project_id,
      row.policy_id,
      opts.account_id,
      opts.mode === "sync" ? "sync_started" : "cleanup_started",
    );
    return { ...state, grants, recipients, run: syncRun(rows[0]) };
  });
}

export async function assertCourseSecretPolicyGeneration(opts: {
  policy_id: string;
  generation: number;
  allow_disabled?: boolean;
  allow_revoked?: boolean;
}): Promise<void> {
  await ensureCourseSecretSharingSchema();
  const { rows } = await pool().query(
    "SELECT generation,enabled,revoked_at FROM course_secret_policies WHERE policy_id=$1",
    [opts.policy_id],
  );
  if (
    !rows[0] ||
    Number(rows[0].generation) !== opts.generation ||
    (!opts.allow_revoked && rows[0].revoked_at != null) ||
    (!opts.allow_disabled && rows[0].enabled !== true)
  ) {
    throw new Error("course secret policy changed during synchronization");
  }
}

export async function recordCourseSecretResults(opts: {
  course_project_id: string;
  results: Array<{
    run_id: string;
    target_project_id: string;
    secret_name: string;
    source_revision?: number | null;
    status: CourseSecretSyncResult["status"];
    error_code?: string | null;
    runtime_status?: CourseSecretSyncResult["runtime_status"];
  }>;
}): Promise<void> {
  await ensureCourseSecretSharingSchema();
  for (const item of opts.results) {
    await pool().query(
      `INSERT INTO course_secret_sync_results
       (project_id,run_id,target_project_id,secret_name,source_revision,status,error_code,runtime_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (run_id,target_project_id,secret_name) DO UPDATE SET
       source_revision=EXCLUDED.source_revision,status=EXCLUDED.status,
       error_code=EXCLUDED.error_code,runtime_status=EXCLUDED.runtime_status,updated_at=NOW()`,
      [
        opts.course_project_id,
        item.run_id,
        item.target_project_id,
        item.secret_name,
        item.source_revision ?? null,
        item.status,
        item.error_code ?? null,
        item.runtime_status ?? null,
      ],
    );
  }
}

export async function finishCourseSecretRun(opts: {
  run_id: string;
  account_id: string;
  error_code?: string | null;
}): Promise<CourseSecretSyncRun> {
  return await transaction(async (db) => {
    await ensureCourseSecretSharingSchema(db);
    const { rows: countRows } = await db.query(
      "SELECT status,COUNT(*)::int AS count FROM course_secret_sync_results WHERE run_id=$1 GROUP BY status",
      [opts.run_id],
    );
    const counts = new Map(
      countRows.map(({ status, count }) => [status, Number(count)]),
    );
    const copied = (counts.get("copied") ?? 0) + (counts.get("removed") ?? 0);
    const unchanged = counts.get("unchanged") ?? 0;
    const conflict = counts.get("conflict") ?? 0;
    const skipped = counts.get("skipped") ?? 0;
    const failed = counts.get("failed") ?? 0;
    const bad = conflict + skipped + failed;
    const status = opts.error_code
      ? "failed"
      : bad
        ? copied + unchanged
          ? "partial"
          : "failed"
        : "completed";
    const { rows } = await db.query(
      `UPDATE course_secret_sync_runs SET status=$2,copied_count=$3,unchanged_count=$4,
       conflict_count=$5,skipped_count=$6,failed_count=$7,finished_at=NOW(),error_code=$8
       WHERE run_id=$1 RETURNING *`,
      [
        opts.run_id,
        status,
        copied,
        unchanged,
        conflict,
        skipped,
        failed,
        opts.error_code ?? null,
      ],
    );
    if (!rows[0]) throw new Error("course secret sync run does not exist");
    await audit(
      db,
      rows[0].project_id,
      rows[0].policy_id,
      opts.account_id,
      rows[0].mode === "cleanup" ? "cleanup_finished" : "sync_finished",
    );
    return syncRun(rows[0]);
  });
}

export async function getCourseSecretRunStatus(opts: {
  course_project_id: string;
  course_id: string;
  run_id?: string;
}): Promise<CourseSecretSyncStatusResult | null> {
  await ensureCourseSecretSharingSchema();
  const params: any[] = [opts.course_project_id, opts.course_id];
  const filter = opts.run_id
    ? (params.push(uuid(opts.run_id, "sync run id")), "AND r.run_id=$3")
    : "";
  const { rows } = await pool().query(
    `SELECT r.* FROM course_secret_sync_runs r JOIN course_secret_policies p ON p.policy_id=r.policy_id
     WHERE r.project_id=$1 AND p.course_id=$2 ${filter} ORDER BY r.created_at DESC LIMIT 1`,
    params,
  );
  if (!rows[0]) return null;
  const { rows: results } = await pool().query(
    "SELECT * FROM course_secret_sync_results WHERE run_id=$1 ORDER BY target_project_id,secret_name",
    [rows[0].run_id],
  );
  return { run: syncRun(rows[0]), results: results.map(syncResult) };
}
