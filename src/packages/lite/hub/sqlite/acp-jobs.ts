import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import { getDatabase } from "./database";

const TABLE = "acp_jobs";
const THREAD_QUEUE_ORDER = `
priority DESC,
CASE WHEN priority > 0 THEN updated_at END DESC,
created_at ASC
`;

export type AcpJobState =
  | "queued"
  | "running"
  | "completed"
  | "error"
  | "canceled"
  | "interrupted";

export interface AcpJobRow {
  op_id: string;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  assistant_message_date: string;
  session_id?: string | null;
  state: AcpJobState;
  send_mode?: "immediate" | null;
  priority: number;
  worker_id?: string | null;
  worker_bundle_version?: string | null;
  recovery_parent_op_id?: string | null;
  recovery_reason?: string | null;
  recovery_count?: number | null;
  request_json: string;
  error?: string | null;
  created_at: number;
  updated_at: number;
  started_at?: number | null;
  finished_at?: number | null;
}

function init(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      op_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      assistant_message_date TEXT NOT NULL,
      session_id TEXT,
      state TEXT NOT NULL,
      send_mode TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      worker_bundle_version TEXT,
      recovery_parent_op_id TEXT,
      recovery_reason TEXT,
      recovery_count INTEGER,
      request_json TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      UNIQUE(project_id, path, user_message_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, priority, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_state_updated_idx ON ${TABLE}(state, updated_at)`,
  );
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const hasColumn = (name: string): boolean =>
    columns.some((x) => x?.name === name);
  if (!hasColumn("worker_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN worker_id TEXT`);
  }
  if (!hasColumn("worker_bundle_version")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN worker_bundle_version TEXT`);
  }
  if (!hasColumn("recovery_parent_op_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_parent_op_id TEXT`);
  }
  if (!hasColumn("recovery_reason")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_reason TEXT`);
  }
  if (!hasColumn("recovery_count")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN recovery_count INTEGER`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_jobs_recovery_parent_idx ON ${TABLE}(recovery_parent_op_id, state, created_at)`,
  );
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function normalizeRequest(request: AcpJobRequest): AcpJobRequest {
  if (request.request_kind === "command") {
    return request;
  }
  return {
    ...request,
    request_kind: request.request_kind ?? "codex",
    runtime_env: undefined,
  };
}

function assertChatIdentity(request: AcpJobRequest): {
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  assistant_message_date: string;
} {
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? ""}`.trim();
  const thread_id = `${request.chat?.thread_id ?? ""}`.trim();
  const user_message_id = `${request.chat?.parent_message_id ?? ""}`.trim();
  const assistant_message_id = `${request.chat?.message_id ?? ""}`.trim();
  const assistant_message_date = `${request.chat?.message_date ?? ""}`.trim();
  if (!project_id || !path || !thread_id || !user_message_id) {
    throw new Error("acp job is missing required chat identity");
  }
  if (!assistant_message_id || !assistant_message_date) {
    throw new Error("acp job is missing assistant turn identity");
  }
  return {
    project_id,
    path,
    thread_id,
    user_message_id,
    assistant_message_id,
    assistant_message_date,
  };
}

export function enqueueAcpJob(request: AcpJobRequest): AcpJobRow {
  ensureInit();
  const db = getDatabase();
  const {
    project_id,
    path,
    thread_id,
    user_message_id,
    assistant_message_id,
    assistant_message_date,
  } = assertChatIdentity(request);
  const now = Date.now();
  const op_id = assistant_message_id;
  const send_mode = request.chat?.send_mode ?? null;
  const priority = send_mode === "immediate" ? 1 : 0;
  const request_json = JSON.stringify(normalizeRequest(request));
  const recovery_parent_op_id =
    request.request_kind === "command"
      ? null
      : `${(request as any).recovery_parent_op_id ?? ""}`.trim() || null;
  const recovery_reason =
    request.request_kind === "command"
      ? null
      : `${(request as any).recovery_reason ?? ""}`.trim() || null;
  const recovery_count =
    request.request_kind === "command"
      ? null
      : Number.isFinite(Number((request as any).recovery_count))
        ? Math.max(1, Math.floor(Number((request as any).recovery_count)))
        : null;
  db.prepare(
    `INSERT INTO ${TABLE}
      (op_id, project_id, path, thread_id, user_message_id, assistant_message_id, assistant_message_date, session_id, state, send_mode, priority, worker_id, worker_bundle_version, recovery_parent_op_id, recovery_reason, recovery_count, request_json, error, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)
      ON CONFLICT(project_id, path, user_message_id) DO UPDATE SET
        send_mode = COALESCE(excluded.send_mode, ${TABLE}.send_mode),
        priority = MAX(${TABLE}.priority, excluded.priority),
        updated_at = excluded.updated_at`,
  ).run(
    op_id,
    project_id,
    path,
    thread_id,
    user_message_id,
    assistant_message_id,
    assistant_message_date,
    request.request_kind === "command" ? null : (request.session_id ?? null),
    send_mode,
    priority,
    recovery_parent_op_id,
    recovery_reason,
    recovery_count,
    request_json,
    now,
    now,
  );
  return getAcpJob({
    project_id,
    path,
    user_message_id,
  })!;
}

export function getAcpJobByOpId(op_id: string): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  return db.prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`).get(op_id) as
    | AcpJobRow
    | undefined;
}

export function listAcpJobsByRecoveryParent({
  recovery_parent_op_id,
}: {
  recovery_parent_op_id: string;
}): AcpJobRow[] {
  ensureInit();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE recovery_parent_op_id = ?
       ORDER BY created_at ASC`,
    )
    .all(recovery_parent_op_id) as AcpJobRow[];
}

export function getAcpJob({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND user_message_id = ?`,
    )
    .get(project_id, path, user_message_id) as AcpJobRow | undefined;
}

export function listQueuedAcpJobs(): AcpJobRow[] {
  ensureInit();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'queued'
       ORDER BY created_at ASC`,
    )
    .all() as AcpJobRow[];
}

export function listRunningAcpJobs(): AcpJobRow[] {
  ensureInit();
  return listRunningAcpJobsByWorker();
}

export function listRunningAcpJobsByWorker(worker_id?: string): AcpJobRow[] {
  ensureInit();
  const db = getDatabase();
  if (`${worker_id ?? ""}`.trim()) {
    return db
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE state = 'running'
           AND worker_id = ?
         ORDER BY started_at ASC, created_at ASC`,
      )
      .all(worker_id) as AcpJobRow[];
  }
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'running'
       ORDER BY started_at ASC, created_at ASC`,
    )
    .all() as AcpJobRow[];
}

export function countRunningAcpJobsForWorker(worker_id: string): number {
  ensureInit();
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${TABLE}
       WHERE state = 'running'
         AND worker_id = ?`,
    )
    .get(worker_id) as { count?: number } | undefined;
  return Number(row?.count ?? 0) || 0;
}

export function listQueuedAcpJobsForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): AcpJobRow[] {
  ensureInit();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
       ORDER BY ${THREAD_QUEUE_ORDER}`,
    )
    .all(project_id, path, thread_id) as AcpJobRow[];
}

export function claimNextQueuedAcpJobForThread({
  project_id,
  path,
  thread_id,
  worker_id,
  worker_bundle_version,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  worker_id?: string;
  worker_bundle_version?: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const running = db
      .prepare(
        `SELECT op_id FROM ${TABLE}
         WHERE project_id = ?
           AND path = ?
           AND thread_id = ?
           AND state = 'running'
         LIMIT 1`,
      )
      .get(project_id, path, thread_id) as { op_id?: string } | undefined;
    if (running?.op_id) {
      db.exec("COMMIT");
      return undefined;
    }
    const next = db
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE project_id = ?
           AND path = ?
           AND thread_id = ?
           AND state = 'queued'
         ORDER BY ${THREAD_QUEUE_ORDER}
         LIMIT 1`,
      )
      .get(project_id, path, thread_id) as AcpJobRow | undefined;
    if (!next) {
      db.exec("COMMIT");
      return undefined;
    }
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE ${TABLE}
          SET state = 'running',
              started_at = ?,
              updated_at = ?,
              error = NULL,
              worker_id = ?,
              worker_bundle_version = ?
          WHERE op_id = ?
            AND state = 'queued'`,
      )
      .run(
        now,
        now,
        worker_id?.trim() || null,
        worker_bundle_version?.trim() || null,
        next.op_id,
      );
    if (result.changes === 0) {
      db.exec("COMMIT");
      return undefined;
    }
    const claimed = db
      .prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`)
      .get(next.op_id) as AcpJobRow | undefined;
    db.exec("COMMIT");
    return claimed;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setAcpJobState({
  op_id,
  state,
  error,
  worker_id,
}: {
  op_id: string;
  state: Exclude<AcpJobState, "queued" | "running">;
  error?: string;
  worker_id?: string;
}): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  if (`${worker_id ?? ""}`.trim()) {
    db.prepare(
      `UPDATE ${TABLE}
        SET state = ?,
            error = COALESCE(?, error),
            updated_at = ?,
            finished_at = ?
        WHERE op_id = ?
          AND (
            state != 'running'
            OR worker_id IS NULL
            OR worker_id = ?
          )`,
    ).run(state, error ?? null, now, now, op_id, worker_id);
    return;
  }
  db.prepare(
    `UPDATE ${TABLE}
      SET state = ?,
          error = COALESCE(?, error),
          updated_at = ?,
          finished_at = ?
      WHERE op_id = ?`,
  ).run(state, error ?? null, now, now, op_id);
}

export function requeueRunningAcpJob({
  op_id,
  error,
  worker_id,
}: {
  op_id: string;
  error?: string;
  worker_id?: string;
}): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  if (`${worker_id ?? ""}`.trim()) {
    db.prepare(
      `UPDATE ${TABLE}
        SET state = 'queued',
            error = COALESCE(?, error),
            updated_at = ?,
            started_at = NULL,
            finished_at = NULL,
            worker_id = NULL,
            worker_bundle_version = NULL
        WHERE op_id = ?
          AND state = 'running'
          AND (
            worker_id IS NULL
            OR worker_id = ?
          )`,
    ).run(error ?? null, now, op_id, worker_id);
    return;
  }
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'queued',
          error = COALESCE(?, error),
          updated_at = ?,
          started_at = NULL,
          finished_at = NULL,
          worker_id = NULL,
          worker_bundle_version = NULL
      WHERE op_id = ?
        AND state = 'running'`,
  ).run(error ?? null, now, op_id);
}

export function reprioritizeAcpJobImmediate({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET send_mode = 'immediate',
          priority = 1,
          updated_at = ?
      WHERE project_id = ?
        AND path = ?
        AND user_message_id = ?
        AND state = 'queued'`,
  ).run(now, project_id, path, user_message_id);
  return getAcpJob({ project_id, path, user_message_id });
}

export function cancelQueuedAcpJob({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'canceled',
          updated_at = ?,
          finished_at = ?
      WHERE project_id = ?
        AND path = ?
        AND user_message_id = ?
        AND state = 'queued'`,
  ).run(now, now, project_id, path, user_message_id);
  return getAcpJob({ project_id, path, user_message_id });
}

export function resendCanceledAcpJob({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'queued',
          priority = CASE
            WHEN send_mode = 'immediate' THEN 1
            ELSE 0
          END,
          updated_at = ?,
          started_at = NULL,
          finished_at = NULL,
          worker_id = NULL,
          worker_bundle_version = NULL
      WHERE project_id = ?
        AND path = ?
        AND user_message_id = ?
        AND state = 'canceled'`,
  ).run(now, project_id, path, user_message_id);
  return getAcpJob({ project_id, path, user_message_id });
}

export function markRunningAcpJobsInterrupted(reason = "server restart"): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'interrupted',
          error = COALESCE(error, ?),
          updated_at = ?,
          finished_at = COALESCE(finished_at, ?)
      WHERE state = 'running'`,
  ).run(reason, now, now);
}

export function decodeAcpJobRequest(row: AcpJobRow): AcpJobRequest {
  const parsed = JSON.parse(row.request_json ?? "{}") as AcpJobRequest;
  if (parsed.request_kind === "command") {
    return parsed;
  }
  return {
    ...parsed,
    request_kind: parsed.request_kind ?? "codex",
    runtime_env: undefined,
  };
}
