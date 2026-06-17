import type { AcpJobRequest, AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_sessions";

export type AcpSessionState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled"
  | "host_stopped"
  | "possibly_active"
  | "orphaned"
  | "unknown";

export interface AcpSessionRow {
  session_key: string;
  session_id?: string | null;
  op_id?: string | null;
  project_id: string;
  account_id?: string | null;
  approver_account_id?: string | null;
  host_id?: string | null;
  path?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  parent_message_id?: string | null;
  state: AcpSessionState;
  terminal: 0 | 1;
  payment_source_kind: string;
  payment_source_id?: string | null;
  payment_source_label?: string | null;
  payment_source_owner_account_id?: string | null;
  model?: string | null;
  agent_kind: string;
  run_kind?: string | null;
  title?: string | null;
  prompt_snippet?: string | null;
  queued_at?: number | null;
  started_at?: number | null;
  updated_at: number;
  last_heartbeat_at?: number | null;
  finished_at?: number | null;
  error?: string | null;
  metadata_json?: string | null;
}

export interface UpsertAcpSessionOptions {
  session_id?: string | null;
  op_id?: string | null;
  project_id: string;
  account_id?: string | null;
  approver_account_id?: string | null;
  host_id?: string | null;
  path?: string | null;
  thread_id?: string | null;
  message_id?: string | null;
  parent_message_id?: string | null;
  state: AcpSessionState;
  payment_source_kind?: string | null;
  payment_source_id?: string | null;
  payment_source_label?: string | null;
  payment_source_owner_account_id?: string | null;
  model?: string | null;
  agent_kind?: string | null;
  run_kind?: string | null;
  title?: string | null;
  prompt_snippet?: string | null;
  queued_at?: number | null;
  started_at?: number | null;
  last_heartbeat_at?: number | null;
  finished_at?: number | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AcpSessionJobMirrorRow {
  op_id: string;
  project_id: string;
  account_id?: string | null;
  path: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  session_id?: string | null;
  state:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "canceled"
    | "interrupted";
  request_json: string;
  error?: string | null;
  created_at: number;
  started_at?: number | null;
  updated_at: number;
  finished_at?: number | null;
}

const TERMINAL_STATES = new Set<AcpSessionState>([
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "host_stopped",
]);

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_key TEXT PRIMARY KEY,
      session_id TEXT,
      op_id TEXT,
      project_id TEXT NOT NULL,
      account_id TEXT,
      approver_account_id TEXT,
      host_id TEXT,
      path TEXT,
      thread_id TEXT,
      message_id TEXT,
      parent_message_id TEXT,
      state TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0,
      payment_source_kind TEXT NOT NULL DEFAULT 'unknown',
      payment_source_id TEXT,
      payment_source_label TEXT,
      payment_source_owner_account_id TEXT,
      model TEXT,
      agent_kind TEXT NOT NULL DEFAULT 'codex',
      run_kind TEXT,
      title TEXT,
      prompt_snippet TEXT,
      queued_at INTEGER,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      metadata_json TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_account_state_updated_idx ON ${TABLE}(account_id, terminal, updated_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_project_updated_idx ON ${TABLE}(project_id, updated_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_payment_state_updated_idx ON ${TABLE}(payment_source_kind, payment_source_id, terminal, updated_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_host_state_updated_idx ON ${TABLE}(host_id, terminal, updated_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_state_updated_idx ON ${TABLE}(state, updated_at)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS acp_sessions_op_id_idx ON ${TABLE}(op_id) WHERE op_id IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_sessions_session_id_idx ON ${TABLE}(session_id) WHERE session_id IS NOT NULL`,
  );
  ensureAcpTableMigrated(TABLE);
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function clean(value: unknown): string | null {
  const text = `${value ?? ""}`.trim();
  return text || null;
}

function sessionKey({
  session_id,
  op_id,
  project_id,
  path,
  message_id,
}: {
  session_id?: string | null;
  op_id?: string | null;
  project_id?: string | null;
  path?: string | null;
  message_id?: string | null;
}): string | undefined {
  const opId = clean(op_id);
  if (opId) return `op:${opId}`;
  const sessionId = clean(session_id);
  if (sessionId) return `session:${sessionId}`;
  const projectId = clean(project_id);
  const chatPath = clean(path);
  const messageId = clean(message_id);
  if (projectId && chatPath && messageId) {
    return `message:${projectId}:${chatPath}:${messageId}`;
  }
  return undefined;
}

function terminalFlag(state: AcpSessionState): 0 | 1 {
  return TERMINAL_STATES.has(state) ? 1 : 0;
}

function metadataJson(
  metadata?: Record<string, unknown> | null,
): string | null {
  if (!metadata) return null;
  try {
    return JSON.stringify(metadata);
  } catch {
    return null;
  }
}

function promptSnippet(request: AcpJobRequest): string | null {
  const source =
    request.request_kind === "command" ? request.command : request.prompt;
  const text = `${source ?? ""}`.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : null;
}

function modelFromRequest(request: AcpJobRequest): string | null {
  if (request.request_kind === "command") return null;
  return clean((request.config as any)?.model);
}

function runKindFromRequest(request: AcpJobRequest): string {
  if (request.request_kind === "command") return "command";
  return request.chat?.automation_id ? "automation" : "interactive";
}

function sessionStateFromJobState(
  state: AcpSessionJobMirrorRow["state"],
): AcpSessionState {
  if (state === "error") return "failed";
  return state;
}

function decodeJobRequest(row: AcpSessionJobMirrorRow): AcpJobRequest {
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

export function isTerminalAcpSessionState(state: AcpSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function upsertAcpSession(opts: UpsertAcpSessionOptions): AcpSessionRow {
  ensureInit();
  const key = sessionKey(opts);
  if (!key) {
    throw new Error("acp session is missing session_id, op_id, or message_id");
  }
  const db = getAcpDatabase();
  const now = Date.now();
  const state = opts.state;
  const terminal = terminalFlag(state);
  const metadata = metadataJson(opts.metadata);
  db.prepare(
    `INSERT INTO ${TABLE}
      (session_key, session_id, op_id, project_id, account_id, approver_account_id, host_id, path, thread_id, message_id, parent_message_id, state, terminal, payment_source_kind, payment_source_id, payment_source_label, payment_source_owner_account_id, model, agent_kind, run_kind, title, prompt_snippet, queued_at, started_at, updated_at, last_heartbeat_at, finished_at, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, ${TABLE}.session_id),
        op_id = COALESCE(excluded.op_id, ${TABLE}.op_id),
        project_id = excluded.project_id,
        account_id = COALESCE(excluded.account_id, ${TABLE}.account_id),
        approver_account_id = COALESCE(excluded.approver_account_id, ${TABLE}.approver_account_id),
        host_id = COALESCE(excluded.host_id, ${TABLE}.host_id),
        path = COALESCE(excluded.path, ${TABLE}.path),
        thread_id = COALESCE(excluded.thread_id, ${TABLE}.thread_id),
        message_id = COALESCE(excluded.message_id, ${TABLE}.message_id),
        parent_message_id = COALESCE(excluded.parent_message_id, ${TABLE}.parent_message_id),
        state = excluded.state,
        terminal = excluded.terminal,
        payment_source_kind = COALESCE(excluded.payment_source_kind, ${TABLE}.payment_source_kind),
        payment_source_id = COALESCE(excluded.payment_source_id, ${TABLE}.payment_source_id),
        payment_source_label = COALESCE(excluded.payment_source_label, ${TABLE}.payment_source_label),
        payment_source_owner_account_id = COALESCE(excluded.payment_source_owner_account_id, ${TABLE}.payment_source_owner_account_id),
        model = COALESCE(excluded.model, ${TABLE}.model),
        agent_kind = COALESCE(excluded.agent_kind, ${TABLE}.agent_kind),
        run_kind = COALESCE(excluded.run_kind, ${TABLE}.run_kind),
        title = COALESCE(excluded.title, ${TABLE}.title),
        prompt_snippet = COALESCE(excluded.prompt_snippet, ${TABLE}.prompt_snippet),
        queued_at = COALESCE(${TABLE}.queued_at, excluded.queued_at),
        started_at = COALESCE(excluded.started_at, ${TABLE}.started_at),
        updated_at = excluded.updated_at,
        last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, ${TABLE}.last_heartbeat_at),
        finished_at = CASE
          WHEN excluded.terminal = 1 THEN COALESCE(excluded.finished_at, ${TABLE}.finished_at, excluded.updated_at)
          ELSE NULL
        END,
        error = COALESCE(excluded.error, ${TABLE}.error),
        metadata_json = COALESCE(excluded.metadata_json, ${TABLE}.metadata_json)`,
  ).run(
    key,
    clean(opts.session_id),
    clean(opts.op_id),
    clean(opts.project_id),
    clean(opts.account_id),
    clean(opts.approver_account_id),
    clean(opts.host_id),
    clean(opts.path),
    clean(opts.thread_id),
    clean(opts.message_id),
    clean(opts.parent_message_id),
    state,
    terminal,
    clean(opts.payment_source_kind) ?? "unknown",
    clean(opts.payment_source_id),
    clean(opts.payment_source_label),
    clean(opts.payment_source_owner_account_id),
    clean(opts.model),
    clean(opts.agent_kind) ?? "codex",
    clean(opts.run_kind),
    clean(opts.title),
    clean(opts.prompt_snippet),
    opts.queued_at ?? null,
    opts.started_at ?? null,
    now,
    opts.last_heartbeat_at ?? null,
    opts.finished_at ?? null,
    clean(opts.error),
    metadata,
  );
  return getAcpSession(key)!;
}

export function upsertAcpSessionFromRequest({
  request,
  state,
  op_id,
  session_id,
  started_at,
  last_heartbeat_at,
  finished_at,
  error,
}: {
  request: AcpJobRequest;
  state: AcpSessionState;
  op_id?: string;
  session_id?: string | null;
  started_at?: number | null;
  last_heartbeat_at?: number | null;
  finished_at?: number | null;
  error?: string | null;
}): AcpSessionRow {
  const chat: AcpChatContext | undefined = request.chat;
  return upsertAcpSession({
    session_id:
      session_id ??
      (request.request_kind === "command" ? null : request.session_id),
    op_id,
    project_id: chat?.project_id ?? request.project_id,
    account_id: request.account_id,
    approver_account_id: request.account_id,
    path: chat?.path,
    thread_id: chat?.thread_id,
    message_id: chat?.message_id,
    parent_message_id: chat?.parent_message_id,
    state,
    payment_source_kind: "unknown",
    model: modelFromRequest(request),
    agent_kind: request.request_kind === "command" ? "command" : "codex",
    run_kind: runKindFromRequest(request),
    title: chat?.automation_title,
    prompt_snippet: promptSnippet(request),
    queued_at: state === "queued" ? Date.now() : undefined,
    started_at,
    last_heartbeat_at,
    finished_at,
    error,
    metadata: {
      request_kind: request.request_kind ?? "codex",
      automation_id: chat?.automation_id,
    },
  });
}

export function upsertAcpSessionFromJob(
  row: AcpSessionJobMirrorRow,
): AcpSessionRow {
  const request = decodeJobRequest(row);
  const state = sessionStateFromJobState(row.state);
  const chat = request.chat;
  return upsertAcpSession({
    session_id:
      row.session_id ??
      (request.request_kind === "command" ? null : request.session_id),
    op_id: row.op_id,
    project_id: row.project_id,
    account_id: row.account_id ?? request.account_id,
    approver_account_id: request.account_id,
    path: row.path,
    thread_id: row.thread_id,
    message_id: row.assistant_message_id || chat?.message_id,
    parent_message_id: row.user_message_id || chat?.parent_message_id,
    state,
    payment_source_kind: "unknown",
    model: modelFromRequest(request),
    agent_kind: request.request_kind === "command" ? "command" : "codex",
    run_kind: runKindFromRequest(request),
    title: chat?.automation_title,
    prompt_snippet: promptSnippet(request),
    queued_at: row.created_at,
    started_at: row.started_at ?? (state === "running" ? row.updated_at : null),
    last_heartbeat_at:
      state === "running" ? (row.updated_at ?? Date.now()) : undefined,
    finished_at: row.finished_at,
    error: row.error,
    metadata: {
      request_kind: request.request_kind ?? "codex",
      automation_id: chat?.automation_id,
      send_mode: chat?.send_mode,
      worker_started_at: row.started_at ?? undefined,
    },
  });
}

export function heartbeatAcpSession({
  session_id,
  op_id,
  project_id,
  path,
  message_id,
}: {
  session_id?: string | null;
  op_id?: string | null;
  project_id?: string | null;
  path?: string | null;
  message_id?: string | null;
}): void {
  ensureInit();
  const key = sessionKey({ session_id, op_id, project_id, path, message_id });
  if (!key) return;
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
        SET last_heartbeat_at = ?,
            updated_at = ?,
            session_id = COALESCE(?, session_id)
        WHERE session_key = ?
          AND terminal = 0`,
    )
    .run(now, now, clean(session_id), key);
}

export function getAcpSession(session_key: string): AcpSessionRow | undefined {
  ensureInit();
  return getAcpDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE session_key = ?`)
    .get(session_key) as AcpSessionRow | undefined;
}

export function getAcpSessionByOpId(op_id: string): AcpSessionRow | undefined {
  ensureInit();
  return getAcpDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE op_id = ?`)
    .get(op_id) as AcpSessionRow | undefined;
}

export function listAcpSessions({
  activeOnly = false,
  limit = 50,
}: {
  activeOnly?: boolean;
  limit?: number;
} = {}): AcpSessionRow[] {
  ensureInit();
  const max = Math.max(1, Math.floor(limit));
  const where = activeOnly ? "WHERE terminal = 0" : "";
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       ${where}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(max) as AcpSessionRow[];
}
