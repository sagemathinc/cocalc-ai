/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import type {
  AcpAttentionAction,
  AcpAttentionKind,
  AcpAttentionQuestion,
  AcpAttentionRecord,
  AcpAttentionSourceKind,
  AcpAttentionState,
  AcpChatContext,
} from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_attention_requests";
const MAX_PENDING_PER_PROJECT = 200;
const MAX_PENDING_PER_THREAD = 25;
const MAX_PENDING_PER_TURN = 10;
const MAX_CREATED_PER_ACCOUNT_PER_MINUTE = 240;
const MAX_CREATED_PER_PROJECT_PER_MINUTE = 120;
const MAX_CREATED_PER_THREAD_PER_MINUTE = 30;
export const ACP_ATTENTION_DISPATCH_LEASE_MS = 30_000;

type AcpAttentionRow = {
  attention_id: string;
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  turn_id: string | null;
  source_kind: AcpAttentionSourceKind;
  source_id: string;
  attention_kind: AcpAttentionKind;
  is_blocking: number;
  title: string;
  summary: string | null;
  questions_json: string;
  action_json: string | null;
  chat_json: string;
  state: AcpAttentionState;
  response_id: string | null;
  response_json: string | null;
  response_declined: number;
  response_submitted_at: number | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  expires_at: number | null;
  seen_at: number | null;
  acknowledged_at: number | null;
  snoozed_until: number | null;
  resolution_reason: string | null;
};

export type AcpAttentionStoredRecord = AcpAttentionRecord & {
  chat: AcpChatContext;
  response_id?: string;
  response?: Record<string, string[]>;
  response_declined?: boolean;
};

function init(db = getAcpDatabase()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      attention_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      attention_kind TEXT NOT NULL,
      is_blocking INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      questions_json TEXT NOT NULL,
      action_json TEXT,
      chat_json TEXT NOT NULL,
      state TEXT NOT NULL,
      response_id TEXT,
      response_json TEXT,
      response_declined INTEGER NOT NULL DEFAULT 0,
      response_submitted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      expires_at INTEGER,
      seen_at INTEGER,
      acknowledged_at INTEGER,
      snoozed_until INTEGER,
      resolution_reason TEXT,
      UNIQUE(project_id, source_kind, source_id)
    )
  `);
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name?: string;
  }>;
  if (!columns.some(({ name }) => name === "action_json")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN action_json TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_attention_account_state_idx ON ${TABLE}(account_id, project_id, state, updated_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_attention_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, updated_at)`,
  );
  ensureAcpTableMigrated(TABLE);
}

let initializedDatabase: ReturnType<typeof getAcpDatabase> | undefined;

function ensureInit(): void {
  const db = getAcpDatabase();
  if (initializedDatabase === db) return;
  init(db);
  initializedDatabase = db;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toStoredRecord(row: AcpAttentionRow): AcpAttentionStoredRecord {
  return {
    attention_id: row.attention_id,
    project_id: row.project_id,
    account_id: row.account_id,
    path: row.path,
    thread_id: row.thread_id,
    turn_id: row.turn_id ?? undefined,
    source_kind: row.source_kind,
    source_id: row.source_id,
    attention_kind: row.attention_kind,
    is_blocking: row.is_blocking === 1,
    title: row.title,
    summary: row.summary ?? undefined,
    questions: parseJson<AcpAttentionQuestion[]>(row.questions_json, []),
    action: parseJson<AcpAttentionAction | undefined>(
      row.action_json,
      undefined,
    ),
    chat: parseJson<AcpChatContext>(row.chat_json, {
      project_id: row.project_id,
      path: row.path,
      message_date: "",
      sender_id: "",
      thread_id: row.thread_id,
    }),
    state: row.state,
    response_id: row.response_id ?? undefined,
    response: parseJson<Record<string, string[]> | undefined>(
      row.response_json,
      undefined,
    ),
    response_declined: row.response_declined === 1 || undefined,
    response_submitted_at: row.response_submitted_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at ?? undefined,
    expires_at: row.expires_at ?? undefined,
    seen_at: row.seen_at ?? undefined,
    acknowledged_at: row.acknowledged_at ?? undefined,
    snoozed_until: row.snoozed_until ?? undefined,
    resolution_reason: row.resolution_reason ?? undefined,
  };
}

function getRow(attention_id: string): AcpAttentionRow | undefined {
  ensureInit();
  return getAcpDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE attention_id = ? LIMIT 1`)
    .get(attention_id) as AcpAttentionRow | undefined;
}

export function getAcpAttention(
  attention_id: string,
): AcpAttentionStoredRecord | undefined {
  const row = getRow(attention_id);
  return row ? toStoredRecord(row) : undefined;
}

export function getAcpAttentionBySource(opts: {
  project_id: string;
  source_kind: AcpAttentionSourceKind;
  source_id: string;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const row = getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND source_kind = ? AND source_id = ? LIMIT 1`,
    )
    .get(opts.project_id, opts.source_kind, opts.source_id) as
    | AcpAttentionRow
    | undefined;
  return row ? toStoredRecord(row) : undefined;
}

export function upsertAcpAttention(opts: {
  project_id: string;
  account_id: string;
  path: string;
  thread_id: string;
  turn_id?: string;
  source_kind: AcpAttentionSourceKind;
  source_id: string;
  attention_kind: AcpAttentionKind;
  is_blocking: boolean;
  title: string;
  summary?: string;
  questions: AcpAttentionQuestion[];
  action?: AcpAttentionAction;
  chat: AcpChatContext;
  expires_at?: number;
}): AcpAttentionStoredRecord {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  const existing = db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND source_kind = ? AND source_id = ? LIMIT 1`,
    )
    .get(opts.project_id, opts.source_kind, opts.source_id) as
    | AcpAttentionRow
    | undefined;
  if (existing) {
    return toStoredRecord(existing);
  }
  const createdSince = now - 60_000;
  const recentlyCreatedAccount = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE account_id = ? AND created_at >= ?`,
    )
    .get(opts.account_id, createdSince) as { count?: number } | undefined;
  if (
    Number(recentlyCreatedAccount?.count ?? 0) >=
    MAX_CREATED_PER_ACCOUNT_PER_MINUTE
  ) {
    throw new Error(
      "Too many Codex attention requests created for this account",
    );
  }
  const recentlyCreatedProject = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE project_id = ? AND created_at >= ?`,
    )
    .get(opts.project_id, createdSince) as { count?: number } | undefined;
  if (
    Number(recentlyCreatedProject?.count ?? 0) >=
    MAX_CREATED_PER_PROJECT_PER_MINUTE
  ) {
    throw new Error(
      "Too many Codex attention requests created in this project",
    );
  }
  const recentlyCreatedThread = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND thread_id = ? AND created_at >= ?`,
    )
    .get(opts.project_id, opts.path, opts.thread_id, createdSince) as
    | { count?: number }
    | undefined;
  if (
    Number(recentlyCreatedThread?.count ?? 0) >=
    MAX_CREATED_PER_THREAD_PER_MINUTE
  ) {
    throw new Error("Too many Codex attention requests created in this thread");
  }
  const pendingProject = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE project_id = ? AND state = 'pending'`,
    )
    .get(opts.project_id) as { count?: number } | undefined;
  if (Number(pendingProject?.count ?? 0) >= MAX_PENDING_PER_PROJECT) {
    throw new Error(
      "Too many pending Codex attention requests in this project",
    );
  }
  const pendingThread = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND thread_id = ? AND state = 'pending'`,
    )
    .get(opts.project_id, opts.path, opts.thread_id) as
    | { count?: number }
    | undefined;
  if (Number(pendingThread?.count ?? 0) >= MAX_PENDING_PER_THREAD) {
    throw new Error("Too many pending Codex attention requests in this thread");
  }
  if (opts.turn_id) {
    const pendingTurn = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${TABLE}
         WHERE project_id = ? AND thread_id = ? AND turn_id = ?
           AND state = 'pending'`,
      )
      .get(opts.project_id, opts.thread_id, opts.turn_id) as
      | { count?: number }
      | undefined;
    if (Number(pendingTurn?.count ?? 0) >= MAX_PENDING_PER_TURN) {
      throw new Error("Too many pending Codex attention requests in this turn");
    }
  }
  const attention_id = randomUUID();
  db.prepare(
    `INSERT INTO ${TABLE} (
       attention_id, project_id, account_id, path, thread_id, turn_id,
       source_kind, source_id, attention_kind, is_blocking, title, summary,
       questions_json, action_json, chat_json, state, response_id, response_json,
       response_declined, response_submitted_at, created_at, updated_at,
       resolved_at, expires_at, seen_at, acknowledged_at, snoozed_until,
       resolution_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL,
       NULL, 0, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
  ).run(
    attention_id,
    opts.project_id,
    opts.account_id,
    opts.path,
    opts.thread_id,
    opts.turn_id ?? null,
    opts.source_kind,
    opts.source_id,
    opts.attention_kind,
    opts.is_blocking ? 1 : 0,
    opts.title,
    opts.summary ?? null,
    JSON.stringify(opts.questions),
    opts.action ? JSON.stringify(opts.action) : null,
    JSON.stringify(opts.chat),
    now,
    now,
    opts.expires_at ?? null,
  );
  return toStoredRecord(getRow(attention_id)!);
}

export function listAcpAttention(opts: {
  account_id: string;
  project_id: string;
  path?: string;
  thread_id?: string;
  state?: AcpAttentionState | "all";
  limit?: number;
}): AcpAttentionStoredRecord[] {
  ensureInit();
  const clauses = ["account_id = ?", "project_id = ?"];
  const args: any[] = [opts.account_id, opts.project_id];
  if (opts.path) {
    clauses.push("path = ?");
    args.push(opts.path);
  }
  if (opts.thread_id) {
    clauses.push("thread_id = ?");
    args.push(opts.thread_id);
  }
  if (opts.state !== "all") {
    clauses.push("state = ?");
    args.push(opts.state ?? "pending");
  }
  args.push(Math.min(500, Math.max(1, opts.limit ?? 200)));
  return (
    getAcpDatabase()
      .prepare(
        `SELECT * FROM ${TABLE} WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args) as AcpAttentionRow[]
  ).map(toStoredRecord);
}

export function listPendingAcpActions(limit = 200): AcpAttentionStoredRecord[] {
  ensureInit();
  return (
    getAcpDatabase()
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE source_kind = 'cocalc_action' AND state = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(Math.min(500, Math.max(1, limit))) as AcpAttentionRow[]
  ).map(toStoredRecord);
}

export function submitAcpAttentionResponse(opts: {
  attention_id: string;
  account_id: string;
  project_id: string;
  response_id: string;
  answers?: Record<string, string[]>;
  decline?: boolean;
}): {
  state: "submitted" | "already_submitted" | "missing";
  record?: AcpAttentionStoredRecord;
} {
  ensureInit();
  const db = getAcpDatabase();
  const row = getRow(opts.attention_id);
  if (
    !row ||
    row.account_id !== opts.account_id ||
    row.project_id !== opts.project_id
  ) {
    return { state: "missing" };
  }
  if (row.response_id) {
    return {
      state:
        row.response_id === opts.response_id
          ? "submitted"
          : "already_submitted",
      record: toStoredRecord(row),
    };
  }
  if (row.state !== "pending") {
    return { state: "already_submitted", record: toStoredRecord(row) };
  }
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE ${TABLE}
       SET response_id = ?, response_json = ?, response_declined = ?,
           response_submitted_at = ?, updated_at = ?
       WHERE attention_id = ? AND state = 'pending' AND response_id IS NULL`,
    )
    .run(
      opts.response_id,
      JSON.stringify(opts.answers ?? {}),
      opts.decline ? 1 : 0,
      now,
      now,
      opts.attention_id,
    );
  const updated = getAcpAttention(opts.attention_id);
  return {
    state:
      Number(result?.changes ?? 0) === 1 ? "submitted" : "already_submitted",
    record: updated,
  };
}

export function claimAcpAttentionResponseDispatch(opts: {
  attention_id: string;
  response_id: string;
  now?: number;
}): boolean {
  ensureInit();
  const now = opts.now ?? Date.now();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET resolution_reason = 'dispatching', updated_at = ?
       WHERE attention_id = ? AND state = 'pending' AND response_id = ?
         AND (resolution_reason IS NULL OR resolution_reason = 'awaiting_delivery' OR
              (resolution_reason = 'dispatching' AND updated_at <= ?))`,
    )
    .run(
      now,
      opts.attention_id,
      opts.response_id,
      now - ACP_ATTENTION_DISPATCH_LEASE_MS,
    );
  return Number(result?.changes ?? 0) === 1;
}

export function deferAcpAttentionResponseDispatch(opts: {
  attention_id: string;
  response_id: string;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const now = Date.now();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET resolution_reason = 'awaiting_delivery', updated_at = ?
       WHERE attention_id = ? AND state = 'pending' AND response_id = ?
         AND resolution_reason IN ('dispatching', 'continuing')`,
    )
    .run(now, opts.attention_id, opts.response_id);
  return Number(result?.changes ?? 0) === 1
    ? getAcpAttention(opts.attention_id)
    : undefined;
}

export function listPendingAcpAttentionResponseDispatches(
  now = Date.now(),
): AcpAttentionStoredRecord[] {
  ensureInit();
  return (
    getAcpDatabase()
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE (source_kind = 'codex_async_question' OR
                (source_kind = 'codex_sync_question' AND
                 resolution_reason = 'awaiting_delivery'))
           AND state = 'pending' AND response_id IS NOT NULL
           AND (resolution_reason IS NULL OR resolution_reason = 'awaiting_delivery' OR
                (resolution_reason = 'dispatching' AND updated_at <= ?))
         ORDER BY response_submitted_at ASC, attention_id ASC`,
      )
      .all(now - ACP_ATTENTION_DISPATCH_LEASE_MS) as AcpAttentionRow[]
  ).map(toStoredRecord);
}

export function claimStaleAcpAttentionContinue(opts: {
  attention_id: string;
  account_id: string;
  project_id: string;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const now = Date.now();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'pending', resolution_reason = 'continuing',
           resolved_at = NULL, updated_at = ?
       WHERE attention_id = ? AND account_id = ? AND project_id = ?
         AND source_kind IN ('codex_sync_question', 'codex_async_question')
         AND state = 'stale'
         AND response_id IS NOT NULL`,
    )
    .run(now, opts.attention_id, opts.account_id, opts.project_id);
  return Number(result?.changes ?? 0) === 1
    ? getAcpAttention(opts.attention_id)
    : undefined;
}

export function resolveAcpAttention(opts: {
  attention_id: string;
  state: Exclude<AcpAttentionState, "pending">;
  reason?: string;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = ?, resolution_reason = ?, resolved_at = ?, updated_at = ?
       WHERE attention_id = ? AND state = 'pending'`,
    )
    .run(opts.state, opts.reason ?? null, now, now, opts.attention_id);
  return getAcpAttention(opts.attention_id);
}

export function resolveAcpAttentionBySource(opts: {
  project_id: string;
  source_kind: AcpAttentionSourceKind;
  source_id: string;
  state: Exclude<AcpAttentionState, "pending">;
  reason?: string;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const record = getAcpAttentionBySource(opts);
  return record
    ? resolveAcpAttention({
        attention_id: record.attention_id,
        state: opts.state,
        reason: opts.reason,
      })
    : undefined;
}

export function markAcpSyncAttentionStale(opts: {
  project_id: string;
  thread_id?: string;
  turn_id?: string;
  reason: string;
}): AcpAttentionStoredRecord[] {
  ensureInit();
  const clauses = ["project_id = ?", "source_kind = 'codex_sync_question'"];
  const args: any[] = [opts.project_id];
  if (opts.thread_id) {
    clauses.push("thread_id = ?");
    args.push(opts.thread_id);
  }
  if (opts.turn_id) {
    clauses.push("turn_id = ?");
    args.push(opts.turn_id);
  }
  const now = Date.now();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'stale', resolution_reason = ?, resolved_at = ?, updated_at = ?
       WHERE ${clauses.join(" AND ")} AND state = 'pending'`,
    )
    .run(opts.reason, now, now, ...args);
  if (Number(result?.changes ?? 0) === 0) return [];
  return (
    getAcpDatabase()
      .prepare(
        `SELECT * FROM ${TABLE}
         WHERE ${clauses.join(" AND ")} AND state = 'stale' AND updated_at = ?
         ORDER BY updated_at DESC`,
      )
      .all(...args, now) as AcpAttentionRow[]
  ).map(toStoredRecord);
}

export function markAllPendingAcpSyncAttentionStale(
  reason: string,
  opts: {
    preserve?: (record: AcpAttentionStoredRecord) => boolean;
  } = {},
): AcpAttentionStoredRecord[] {
  ensureInit();
  const db = getAcpDatabase();
  const pending = (
    db
      .prepare(
        `SELECT * FROM ${TABLE}
       WHERE source_kind = 'codex_sync_question' AND state = 'pending'`,
      )
      .all() as AcpAttentionRow[]
  )
    .map(toStoredRecord)
    .filter((record) => !opts.preserve?.(record));
  if (pending.length === 0) return [];
  const now = Date.now();
  const update = db.prepare(
    `UPDATE ${TABLE}
     SET state = 'stale', resolution_reason = ?, resolved_at = ?, updated_at = ?
     WHERE attention_id = ?
       AND source_kind = 'codex_sync_question' AND state = 'pending'`,
  );
  const changed = new Set<string>();
  for (const { attention_id } of pending) {
    const result = update.run(reason, now, now, attention_id);
    if (Number(result.changes ?? 0) > 0) changed.add(attention_id);
  }
  return pending
    .filter(({ attention_id }) => changed.has(attention_id))
    .map(({ attention_id }) => getAcpAttention(attention_id))
    .filter((record): record is AcpAttentionStoredRecord => record != null);
}

export function markAcpAsyncAttentionSuperseded(opts: {
  project_id: string;
  path: string;
  thread_id: string;
  reason: string;
}): AcpAttentionStoredRecord[] {
  ensureInit();
  const now = Date.now();
  const db = getAcpDatabase();
  const pending = db
    .prepare(
      `SELECT attention_id FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND thread_id = ?
         AND source_kind = 'codex_async_question' AND state = 'pending'
         AND response_id IS NULL`,
    )
    .all(opts.project_id, opts.path, opts.thread_id) as Array<{
    attention_id: string;
  }>;
  if (pending.length === 0) return [];
  const ids = pending.map(({ attention_id }) => attention_id);
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE ${TABLE}
     SET state = 'superseded', resolution_reason = ?, resolved_at = ?, updated_at = ?
     WHERE attention_id IN (${placeholders}) AND state = 'pending'
       AND response_id IS NULL`,
  ).run(opts.reason, now, now, ...ids);
  return ids
    .map((attention_id) => getAcpAttention(attention_id))
    .filter((record): record is AcpAttentionStoredRecord => record != null);
}

export function updateAcpAttentionDelivery(opts: {
  attention_id: string;
  account_id: string;
  project_id: string;
  seen_at?: number;
  acknowledged_at?: number;
  snoozed_until?: number;
}): AcpAttentionStoredRecord | undefined {
  ensureInit();
  const now = Date.now();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET seen_at = COALESCE(?, seen_at),
           acknowledged_at = COALESCE(?, acknowledged_at),
           snoozed_until = COALESCE(?, snoozed_until), updated_at = ?
       WHERE attention_id = ? AND account_id = ? AND project_id = ?`,
    )
    .run(
      opts.seen_at ?? null,
      opts.acknowledged_at ?? null,
      opts.snoozed_until ?? null,
      now,
      opts.attention_id,
      opts.account_id,
      opts.project_id,
    );
  return Number(result?.changes ?? 0) === 1
    ? getAcpAttention(opts.attention_id)
    : undefined;
}

export const __test__ = { toStoredRecord };
