import type { AcpChatContext } from "@cocalc/conat/ai/acp/types";
import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_turns";

export type AcpTurnLeaseState = "running" | "completed" | "error" | "aborted";

export interface AcpTurnLeaseKey {
  project_id: string;
  path: string;
  message_date: string;
}

export interface AcpTurnLeaseRow extends AcpTurnLeaseKey {
  message_id?: string | null;
  thread_id?: string | null;
  sender_id?: string | null;
  session_id?: string | null;
  state: AcpTurnLeaseState;
  owner_instance_id: string;
  pid?: number | null;
  started_at: number;
  heartbeat_at: number;
  ended_at?: number | null;
  reason?: string | null;
}

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      message_date TEXT NOT NULL,
      message_id TEXT,
      thread_id TEXT,
      sender_id TEXT,
      session_id TEXT,
      state TEXT NOT NULL,
      owner_instance_id TEXT NOT NULL,
      pid INTEGER,
      started_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      ended_at INTEGER,
      reason TEXT,
      PRIMARY KEY (project_id, path, message_date)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_turns_state_heartbeat_idx ON ${TABLE}(state, heartbeat_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_turns_owner_state_idx ON ${TABLE}(owner_instance_id, state)`,
  );
  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{
    name: string;
  }>;
  const hasColumn = (name: string): boolean =>
    columns.some((x) => x?.name === name);
  if (!hasColumn("message_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN message_id TEXT`);
  }
  if (!hasColumn("thread_id")) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN thread_id TEXT`);
  }
  ensureAcpTableMigrated(TABLE);
}

let initialized = false;

function ensureInit(): void {
  if (!initialized) {
    init();
    initialized = true;
  }
}

function keyFromContext(context: AcpChatContext): AcpTurnLeaseKey {
  return {
    project_id: context.project_id,
    path: context.path,
    message_date: context.message_date,
  };
}

export function startAcpTurnLease({
  context,
  owner_instance_id,
  pid,
  session_id,
}: {
  context: AcpChatContext;
  owner_instance_id: string;
  pid: number;
  session_id?: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const key = keyFromContext(context);
  const now = Date.now();
  db.prepare(
    `INSERT INTO ${TABLE}
      (project_id, path, message_date, message_id, thread_id, sender_id, session_id, state, owner_instance_id, pid, started_at, heartbeat_at, ended_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(project_id, path, message_date) DO UPDATE SET
        message_id = COALESCE(excluded.message_id, ${TABLE}.message_id),
        thread_id = COALESCE(excluded.thread_id, ${TABLE}.thread_id),
        sender_id = excluded.sender_id,
        session_id = COALESCE(excluded.session_id, ${TABLE}.session_id),
        state = 'running',
        owner_instance_id = excluded.owner_instance_id,
        pid = excluded.pid,
        started_at = excluded.started_at,
        heartbeat_at = excluded.heartbeat_at,
        ended_at = NULL,
        reason = NULL`,
  ).run(
    key.project_id,
    key.path,
    key.message_date,
    context.message_id ?? null,
    context.thread_id ?? null,
    context.sender_id ?? null,
    session_id ?? null,
    owner_instance_id,
    pid,
    now,
    now,
  );
}

export function heartbeatAcpTurnLease({
  key,
  owner_instance_id,
  pid,
  session_id,
}: {
  key: AcpTurnLeaseKey;
  owner_instance_id: string;
  pid: number;
  session_id?: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  db.prepare(
    `UPDATE ${TABLE}
      SET heartbeat_at = ?,
          owner_instance_id = ?,
          pid = ?,
          session_id = COALESCE(?, session_id)
      WHERE project_id = ?
        AND path = ?
        AND message_date = ?
        AND state = 'running'`,
  ).run(
    Date.now(),
    owner_instance_id,
    pid,
    session_id ?? null,
    key.project_id,
    key.path,
    key.message_date,
  );
}

export function updateAcpTurnLeaseSessionId({
  key,
  session_id,
}: {
  key: AcpTurnLeaseKey;
  session_id: string;
}): void {
  if (!session_id) return;
  ensureInit();
  const db = getAcpDatabase();
  db.prepare(
    `UPDATE ${TABLE}
      SET session_id = ?
      WHERE project_id = ?
        AND path = ?
        AND message_date = ?`,
  ).run(session_id, key.project_id, key.path, key.message_date);
}

export function finalizeAcpTurnLease({
  key,
  state,
  reason,
  owner_instance_id,
}: {
  key: AcpTurnLeaseKey;
  state: Exclude<AcpTurnLeaseState, "running">;
  reason?: string;
  owner_instance_id?: string;
}): void {
  ensureInit();
  const db = getAcpDatabase();
  const now = Date.now();
  db.prepare(
    `UPDATE ${TABLE}
      SET state = ?,
          reason = COALESCE(?, reason),
          heartbeat_at = ?,
          ended_at = ?,
          owner_instance_id = COALESCE(?, owner_instance_id)
      WHERE project_id = ?
        AND path = ?
        AND message_date = ?
        AND state = 'running'`,
  ).run(
    state,
    reason ?? null,
    now,
    now,
    owner_instance_id ?? null,
    key.project_id,
    key.path,
    key.message_date,
  );
}

function selectLeaseByWhere(where: string): string {
  return `SELECT
      project_id,
      path,
      message_date,
      message_id,
      thread_id,
      sender_id,
      session_id,
      state,
      owner_instance_id,
      pid,
      started_at,
      heartbeat_at,
      ended_at,
      reason
    FROM ${TABLE}
    ${where}`;
}

export function listRunningAcpTurnLeases({
  exclude_owner_instance_id,
}: {
  exclude_owner_instance_id?: string;
} = {}): AcpTurnLeaseRow[] {
  ensureInit();
  const db = getAcpDatabase();
  let query = selectLeaseByWhere("WHERE state = 'running'");
  const params: any[] = [];
  if (exclude_owner_instance_id) {
    query += ` AND owner_instance_id != ?`;
    params.push(exclude_owner_instance_id);
  }
  query += " ORDER BY heartbeat_at ASC";
  return db.prepare(query).all(...params) as AcpTurnLeaseRow[];
}

export function getAcpTurnLease(
  key: AcpTurnLeaseKey,
): AcpTurnLeaseRow | undefined {
  ensureInit();
  const db = getAcpDatabase();
  return db
    .prepare(
      selectLeaseByWhere(
        "WHERE project_id = ? AND path = ? AND message_date = ?",
      ),
    )
    .get(key.project_id, key.path, key.message_date) as
    | AcpTurnLeaseRow
    | undefined;
}
