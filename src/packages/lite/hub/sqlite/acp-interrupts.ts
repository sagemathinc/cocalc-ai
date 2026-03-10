import { randomUUID } from "node:crypto";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { getDatabase } from "./database";

const TABLE = "acp_interrupts";

export type AcpInterruptState = "pending" | "handled" | "error";

export interface AcpInterruptRow {
  id: string;
  project_id: string;
  path: string;
  thread_id: string;
  candidate_ids_json: string;
  chat_json: string;
  state: AcpInterruptState;
  error?: string | null;
  created_at: number;
  updated_at: number;
  handled_at?: number | null;
}

function init(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL,
      chat_json TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handled_at INTEGER
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_interrupts_state_created_idx ON ${TABLE}(state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_interrupts_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, created_at)`,
  );
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

export function enqueueAcpInterrupt({
  project_id,
  path,
  thread_id,
  candidate_ids,
  chat,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  candidate_ids?: string[];
  chat?: AcpChatContext;
}): AcpInterruptRow {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ${TABLE}
      (id, project_id, path, thread_id, candidate_ids_json, chat_json, state, error, created_at, updated_at, handled_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
  ).run(
    id,
    project_id,
    path,
    thread_id,
    JSON.stringify(
      (candidate_ids ?? []).filter(
        (id) => typeof id === "string" && id.trim().length > 0,
      ),
    ),
    JSON.stringify(chat ?? {}),
    now,
    now,
  );
  return db
    .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
    .get(id) as AcpInterruptRow;
}

export function listPendingAcpInterrupts(limit = 50): AcpInterruptRow[] {
  ensureInit();
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as AcpInterruptRow[];
}

export function markAcpInterruptHandled({ id }: { id: string }): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'handled',
          updated_at = ?,
          handled_at = ?,
          error = NULL
      WHERE id = ?
        AND state = 'pending'`,
  ).run(now, now, id);
}

export function markAcpInterruptError({
  id,
  error,
}: {
  id: string;
  error: string;
}): void {
  ensureInit();
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'error',
          updated_at = ?,
          handled_at = ?,
          error = ?
      WHERE id = ?
        AND state = 'pending'`,
  ).run(now, now, error, id);
}

export function decodeAcpInterruptCandidateIds(row: AcpInterruptRow): string[] {
  const parsed = JSON.parse(row.candidate_ids_json ?? "[]");
  return Array.isArray(parsed)
    ? parsed.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
}

export function decodeAcpInterruptChat(
  row: AcpInterruptRow,
): AcpChatContext | undefined {
  const parsed = JSON.parse(row.chat_json ?? "{}");
  return parsed && typeof parsed === "object"
    ? (parsed as AcpChatContext)
    : undefined;
}
