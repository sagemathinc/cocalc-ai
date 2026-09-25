import { randomUUID } from "node:crypto";
import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_interrupts";

export type AcpInterruptState = "pending" | "handled" | "error";

export interface AcpInterruptRow {
  id: string;
  project_id: string;
  path: string;
  thread_id: string;
  candidate_ids_json: string;
  chat_json: string;
  expected_message_id?: string | null;
  expected_session_id?: string | null;
  state: AcpInterruptState;
  error?: string | null;
  created_at: number;
  updated_at: number;
  handled_at?: number | null;
}

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL,
      chat_json TEXT NOT NULL,
      expected_message_id TEXT,
      expected_session_id TEXT,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handled_at INTEGER
    )
  `);
  if (
    !(
      db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]
    ).some(({ name }) => name === "expected_message_id")
  ) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN expected_message_id TEXT`);
  }
  if (
    !(
      db.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]
    ).some(({ name }) => name === "expected_session_id")
  ) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN expected_session_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_interrupts_state_created_idx ON ${TABLE}(state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_interrupts_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, created_at)`,
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

export function enqueueAcpInterrupt({
  project_id,
  path,
  thread_id,
  candidate_ids,
  chat,
  expected_message_id,
  expected_session_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  candidate_ids?: string[];
  chat?: AcpChatContext;
  expected_message_id?: string;
  expected_session_id?: string;
}): AcpInterruptRow {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  const normalizedCandidateIds = [
    ...new Set(
      (candidate_ids ?? []).filter(
        (id) => typeof id === "string" && id.trim().length > 0,
      ),
    ),
  ];
  const existing = db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ?
         AND path = ?
         AND thread_id = ?
         AND COALESCE(expected_message_id, '') = ?
         AND COALESCE(expected_session_id, '') = ?
         AND state = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(
      project_id,
      path,
      thread_id,
      expected_message_id ?? "",
      expected_session_id ?? "",
    ) as AcpInterruptRow | undefined;
  if (existing) {
    const mergedCandidateIds = [
      ...new Set([
        ...decodeAcpInterruptCandidateIds(existing),
        ...normalizedCandidateIds,
      ]),
    ];
    db.prepare(
      `UPDATE ${TABLE}
          SET candidate_ids_json = ?,
              chat_json = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(mergedCandidateIds),
      JSON.stringify(chat ?? decodeAcpInterruptChat(existing) ?? {}),
      now,
      existing.id,
    );
    return db
      .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
      .get(existing.id) as AcpInterruptRow;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ${TABLE}
      (id, project_id, path, thread_id, candidate_ids_json, chat_json, expected_message_id, expected_session_id, state, error, created_at, updated_at, handled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
  ).run(
    id,
    project_id,
    path,
    thread_id,
    JSON.stringify(normalizedCandidateIds),
    JSON.stringify(chat ?? {}),
    expected_message_id ?? null,
    expected_session_id ?? null,
    now,
    now,
  );
  return db
    .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
    .get(id) as AcpInterruptRow;
}

export function listPendingAcpInterrupts(limit = 50): AcpInterruptRow[] {
  ensureInit();
  const db = getAcpDatabase();
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
  const db = getAcpDatabase();
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

export function markAcpInterruptsHandledForThread({
  project_id,
  path,
  thread_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'handled',
          updated_at = ?,
          handled_at = ?,
          error = NULL
      WHERE project_id = ?
        AND path = ?
        AND thread_id = ?
        AND state = 'pending'`,
  ).run(now, now, project_id, path, thread_id);
}

export function markAcpInterruptsHandledForTurn({
  project_id,
  path,
  thread_id,
  expected_message_id,
  expected_session_id,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  expected_message_id: string;
  expected_session_id?: string;
}): void {
  ensureInit();
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE} SET state = 'handled', updated_at = ?, handled_at = ?, error = NULL
       WHERE project_id = ? AND path = ? AND thread_id = ?
         AND expected_message_id = ? AND COALESCE(expected_session_id, '') = ? AND state = 'pending'`,
    )
    .run(
      now,
      now,
      project_id,
      path,
      thread_id,
      expected_message_id,
      expected_session_id ?? "",
    );
}

export function markAcpInterruptError({
  id,
  error,
}: {
  id: string;
  error: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
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
