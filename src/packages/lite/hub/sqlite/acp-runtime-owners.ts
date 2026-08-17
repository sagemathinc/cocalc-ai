import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_runtime_owners";

export interface AcpRuntimeOwnerRow {
  session_id: string;
  worker_id: string;
  project_id: string;
  account_id?: string | null;
  path?: string | null;
  created_at: number;
  updated_at: number;
}

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      session_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      account_id TEXT,
      path TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_runtime_owners_worker_idx ON ${TABLE}(worker_id, updated_at)`,
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

export function upsertAcpRuntimeOwner({
  session_id,
  worker_id,
  project_id,
  account_id,
  path,
}: {
  session_id: string;
  worker_id: string;
  project_id: string;
  account_id?: string | null;
  path?: string | null;
}): AcpRuntimeOwnerRow {
  ensureInit();
  const sessionId = `${session_id ?? ""}`.trim();
  const workerId = `${worker_id ?? ""}`.trim();
  const projectId = `${project_id ?? ""}`.trim();
  if (!sessionId || !workerId || !projectId) {
    throw new Error(
      "ACP runtime ownership requires session_id, worker_id, and project_id",
    );
  }
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `INSERT INTO ${TABLE}
        (session_id, worker_id, project_id, account_id, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         worker_id = excluded.worker_id,
         project_id = excluded.project_id,
         account_id = excluded.account_id,
         path = excluded.path,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionId,
      workerId,
      projectId,
      `${account_id ?? ""}`.trim() || null,
      `${path ?? ""}`.trim() || null,
      now,
      now,
    );
  return getAcpRuntimeOwner(sessionId)!;
}

export function getAcpRuntimeOwner(
  session_id?: string | null,
): AcpRuntimeOwnerRow | undefined {
  ensureInit();
  const sessionId = `${session_id ?? ""}`.trim();
  if (!sessionId) return;
  return getAcpDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE session_id = ?`)
    .get(sessionId) as AcpRuntimeOwnerRow | undefined;
}

export function releaseAcpRuntimeOwner({
  session_id,
  worker_id,
}: {
  session_id: string;
  worker_id: string;
}): boolean {
  ensureInit();
  const result = getAcpDatabase()
    .prepare(
      `DELETE FROM ${TABLE}
       WHERE session_id = ? AND worker_id = ?`,
    )
    .run(`${session_id ?? ""}`.trim(), `${worker_id ?? ""}`.trim());
  return Number(result?.changes ?? 0) > 0;
}

export function releaseAcpRuntimeOwnersForWorker(worker_id: string): number {
  ensureInit();
  const result = getAcpDatabase()
    .prepare(`DELETE FROM ${TABLE} WHERE worker_id = ?`)
    .run(`${worker_id ?? ""}`.trim());
  return Number(result?.changes ?? 0) || 0;
}
