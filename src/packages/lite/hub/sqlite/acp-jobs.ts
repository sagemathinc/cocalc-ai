import type { AcpRequest } from "@cocalc/conat/ai/acp/types";
import { getDatabase } from "./database";

const TABLE = "acp_jobs";

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
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function normalizeRequest(request: AcpRequest): AcpRequest {
  return {
    ...request,
    runtime_env: undefined,
  };
}

function assertChatIdentity(request: AcpRequest): {
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  assistant_message_date: string;
} {
  const project_id = `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
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

export function enqueueAcpJob(request: AcpRequest): AcpJobRow {
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
  db.prepare(
    `INSERT INTO ${TABLE}
      (op_id, project_id, path, thread_id, user_message_id, assistant_message_id, assistant_message_date, session_id, state, send_mode, priority, request_json, error, created_at, updated_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?, NULL, NULL)
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
    request.session_id ?? null,
    send_mode,
    priority,
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
       ORDER BY priority DESC, updated_at DESC, created_at ASC`,
    )
    .all(project_id, path, thread_id) as AcpJobRow[];
}

export function claimNextQueuedAcpJobForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): AcpJobRow | undefined {
  ensureInit();
  const db = getDatabase();
  const next = db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND state = 'queued'
       ORDER BY priority DESC, updated_at DESC, created_at ASC
       LIMIT 1`,
    )
    .get(project_id, path, thread_id) as AcpJobRow | undefined;
  if (!next) return;
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'running',
          started_at = ?,
          updated_at = ?,
          error = NULL
      WHERE op_id = ?
        AND state = 'queued'`,
  ).run(now, now, next.op_id);
  return db
    .prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`)
    .get(next.op_id) as AcpJobRow | undefined;
}

export function setAcpJobState({
  op_id,
  state,
  error,
}: {
  op_id: string;
  state: Exclude<AcpJobState, "queued" | "running">;
  error?: string;
}): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = ?,
          error = COALESCE(?, error),
          updated_at = ?,
          finished_at = ?
      WHERE op_id = ?`,
  ).run(state, error ?? null, now, now, op_id);
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

export function decodeAcpJobRequest(row: AcpJobRow): AcpRequest {
  const parsed = JSON.parse(row.request_json ?? "{}") as AcpRequest;
  return {
    ...parsed,
    runtime_env: undefined,
  };
}
