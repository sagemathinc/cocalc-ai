import { randomUUID } from "node:crypto";
import type { AcpSteerRequest } from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_steers";

export type AcpSteerState = "pending" | "handled" | "error";

export interface AcpSteerRow {
  id: string;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  candidate_ids_json: string;
  request_json: string;
  state: AcpSteerState;
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
      user_message_id TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handled_at INTEGER,
      UNIQUE(project_id, path, user_message_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_steers_state_created_idx ON ${TABLE}(state, created_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_steers_thread_state_idx ON ${TABLE}(project_id, path, thread_id, state, created_at)`,
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

export function enqueueAcpSteer({
  request,
  candidate_ids,
}: {
  request: AcpSteerRequest;
  candidate_ids?: string[];
}): AcpSteerRow {
  ensureInit();
  const db = getAcpDatabase();
  const project_id =
    `${request.chat?.project_id ?? request.project_id ?? ""}`.trim();
  const path = `${request.chat?.path ?? ""}`.trim();
  const thread_id = `${request.chat?.thread_id ?? ""}`.trim();
  const user_message_id = `${request.chat?.parent_message_id ?? ""}`.trim();
  if (!project_id || !path || !thread_id || !user_message_id) {
    throw new Error("acp steer is missing required chat identity");
  }
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
         AND user_message_id = ?
         AND state = 'pending'
       LIMIT 1`,
    )
    .get(project_id, path, user_message_id) as AcpSteerRow | undefined;
  if (existing) {
    const mergedCandidateIds = [
      ...new Set([
        ...decodeAcpSteerCandidateIds(existing),
        ...normalizedCandidateIds,
      ]),
    ];
    db.prepare(
      `UPDATE ${TABLE}
          SET candidate_ids_json = ?,
              request_json = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      JSON.stringify(mergedCandidateIds),
      JSON.stringify(request),
      now,
      existing.id,
    );
    return db
      .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
      .get(existing.id) as AcpSteerRow;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ${TABLE}
      (id, project_id, path, thread_id, user_message_id, candidate_ids_json, request_json, state, error, created_at, updated_at, handled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
  ).run(
    id,
    project_id,
    path,
    thread_id,
    user_message_id,
    JSON.stringify(normalizedCandidateIds),
    JSON.stringify(request),
    now,
    now,
  );
  return db
    .prepare(`SELECT * FROM ${TABLE} WHERE id = ?`)
    .get(id) as AcpSteerRow;
}

export function listPendingAcpSteers(limit = 50): AcpSteerRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as AcpSteerRow[];
}

export function markAcpSteerHandled({ id }: { id: string }): void {
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

export function markAcpSteerError({
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

export function decodeAcpSteerCandidateIds(row: AcpSteerRow): string[] {
  const parsed = JSON.parse(row.candidate_ids_json ?? "[]");
  return Array.isArray(parsed)
    ? parsed.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
}

export function decodeAcpSteerRequest(row: AcpSteerRow): AcpSteerRequest {
  return JSON.parse(row.request_json ?? "{}") as AcpSteerRequest;
}
