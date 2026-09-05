import { randomUUID } from "node:crypto";
import type { AcpSteerRequest } from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_steers";

export const ACP_STEER_CLAIM_LEASE_MS = 30_000;

export type AcpSteerState = "pending" | "processing" | "handled" | "error";

export interface AcpSteerRow {
  id: string;
  project_id: string;
  path: string;
  thread_id: string;
  user_message_id: string;
  candidate_ids_json: string;
  request_json: string;
  state: AcpSteerState;
  claim_token?: string | null;
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
      claim_token TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      handled_at INTEGER,
      UNIQUE(project_id, path, user_message_id)
    )
  `);
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name?: string;
  }>;
  if (!columns.some(({ name }) => name === "claim_token")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN claim_token TEXT`);
  }
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
              state = CASE WHEN state = 'error' THEN 'pending' ELSE state END,
              claim_token = CASE WHEN state = 'error' THEN NULL ELSE claim_token END,
              error = CASE WHEN state = 'error' THEN NULL ELSE error END,
              handled_at = CASE WHEN state = 'error' THEN NULL ELSE handled_at END,
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
      (id, project_id, path, thread_id, user_message_id, candidate_ids_json, request_json, state, claim_token, error, created_at, updated_at, handled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
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

export function getAcpSteer({
  project_id,
  path,
  user_message_id,
}: {
  project_id: string;
  path: string;
  user_message_id: string;
}): AcpSteerRow | undefined {
  ensureInit();
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE project_id = ? AND path = ? AND user_message_id = ?
       LIMIT 1`,
    )
    .get(project_id, path, user_message_id) as AcpSteerRow | undefined;
}

export function listPendingAcpSteers(
  limit = 50,
  now = Date.now(),
): AcpSteerRow[] {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      `SELECT * FROM ${TABLE}
       WHERE state = 'pending'
          OR (state = 'processing' AND updated_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(now - ACP_STEER_CLAIM_LEASE_MS, limit) as AcpSteerRow[];
}

export function claimAcpSteer({
  id,
  now = Date.now(),
}: {
  id: string;
  now?: number;
}): string | undefined {
  ensureInit();
  const claimToken = randomUUID();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'processing', claim_token = ?, updated_at = ?
       WHERE id = ?
         AND (state = 'pending' OR
              (state = 'processing' AND updated_at <= ?))`,
    )
    .run(claimToken, now, id, now - ACP_STEER_CLAIM_LEASE_MS);
  return Number(result?.changes ?? 0) === 1 ? claimToken : undefined;
}

export function releaseAcpSteerClaim({
  id,
  claim_token,
}: {
  id: string;
  claim_token: string;
}): void {
  ensureInit();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'pending', claim_token = NULL, updated_at = ?
       WHERE id = ? AND state = 'processing' AND claim_token = ?`,
    )
    .run(Date.now(), id, claim_token);
}

export function heartbeatAcpSteerClaim({
  id,
  claim_token,
}: {
  id: string;
  claim_token: string;
}): boolean {
  ensureInit();
  const result = getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET updated_at = ?
       WHERE id = ? AND state = 'processing' AND claim_token = ?`,
    )
    .run(Date.now(), id, claim_token);
  return Number(result?.changes ?? 0) === 1;
}

export function ownsAcpSteerClaim({
  id,
  claim_token,
}: {
  id: string;
  claim_token: string;
}): boolean {
  ensureInit();
  return (
    getAcpDatabase()
      .prepare(
        `SELECT 1 FROM ${TABLE}
         WHERE id = ? AND state = 'processing' AND claim_token = ?
         LIMIT 1`,
      )
      .get(id, claim_token) != null
  );
}

export function markAcpSteerHandled({
  id,
  claim_token,
}: {
  id: string;
  claim_token: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'handled',
          claim_token = NULL,
          updated_at = ?,
          handled_at = ?,
          error = NULL
      WHERE id = ?
        AND state = 'processing' AND claim_token = ?`,
  ).run(now, now, id, claim_token);
}

export function markAcpSteerError({
  id,
  claim_token,
  error,
}: {
  id: string;
  claim_token: string;
  error: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = 'error',
          claim_token = NULL,
          updated_at = ?,
          handled_at = ?,
          error = ?
      WHERE id = ?
        AND state = 'processing' AND claim_token = ?`,
  ).run(now, now, error, id, claim_token);
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
