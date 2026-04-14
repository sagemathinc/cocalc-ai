import { ensureAcpTableMigrated, getAcpDatabase } from "./acp-database";

const TABLE = "acp_workers";

export type AcpWorkerState = "active" | "draining" | "stopped";

export interface AcpWorkerRow {
  worker_id: string;
  host_id: string;
  bundle_version: string;
  bundle_path: string;
  pid?: number | null;
  state: AcpWorkerState;
  started_at: number;
  last_heartbeat_at: number;
  last_seen_running_jobs: number;
  exit_requested_at?: number | null;
  stopped_at?: number | null;
  stop_reason?: string | null;
}

function init(): void {
  const db = getAcpDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      worker_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      bundle_version TEXT NOT NULL,
      bundle_path TEXT NOT NULL,
      pid INTEGER,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_heartbeat_at INTEGER NOT NULL,
      last_seen_running_jobs INTEGER NOT NULL DEFAULT 0,
      exit_requested_at INTEGER,
      stopped_at INTEGER,
      stop_reason TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS acp_workers_host_state_idx ON ${TABLE}(host_id, state, last_heartbeat_at)`,
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

export function upsertAcpWorker(row: AcpWorkerRow): AcpWorkerRow {
  ensureInit();
  const db = getAcpDatabase();
  db.prepare(
    `INSERT INTO ${TABLE}
      (worker_id, host_id, bundle_version, bundle_path, pid, state, started_at, last_heartbeat_at, last_seen_running_jobs, exit_requested_at, stopped_at, stop_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        host_id = excluded.host_id,
        bundle_version = excluded.bundle_version,
        bundle_path = excluded.bundle_path,
        pid = COALESCE(excluded.pid, ${TABLE}.pid),
        state = excluded.state,
        started_at = COALESCE(${TABLE}.started_at, excluded.started_at),
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_seen_running_jobs = excluded.last_seen_running_jobs,
        exit_requested_at = excluded.exit_requested_at,
        stopped_at = excluded.stopped_at,
        stop_reason = excluded.stop_reason`,
  ).run(
    row.worker_id,
    row.host_id,
    row.bundle_version,
    row.bundle_path,
    row.pid ?? null,
    row.state,
    row.started_at,
    row.last_heartbeat_at,
    row.last_seen_running_jobs,
    row.exit_requested_at ?? null,
    row.stopped_at ?? null,
    row.stop_reason ?? null,
  );
  return getAcpWorker(row.worker_id)!;
}

export function getAcpWorker(
  worker_id?: string | null,
): AcpWorkerRow | undefined {
  ensureInit();
  const workerId = `${worker_id ?? ""}`.trim();
  if (!workerId) {
    return undefined;
  }
  return getAcpDatabase()
    .prepare(`SELECT * FROM ${TABLE} WHERE worker_id = ?`)
    .get(workerId) as AcpWorkerRow | undefined;
}

export function listAcpWorkers({
  host_id,
  states,
}: {
  host_id?: string;
  states?: AcpWorkerState[];
} = {}): AcpWorkerRow[] {
  ensureInit();
  const conditions: string[] = [];
  const params: any[] = [];
  if (`${host_id ?? ""}`.trim()) {
    conditions.push("host_id = ?");
    params.push(host_id);
  }
  if (states?.length) {
    conditions.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return getAcpDatabase()
    .prepare(
      `SELECT * FROM ${TABLE}
       ${where}
       ORDER BY last_heartbeat_at DESC, started_at DESC`,
    )
    .all(...params) as AcpWorkerRow[];
}

export function listLiveAcpWorkers({
  host_id,
  stale_after_ms,
}: {
  host_id?: string;
  stale_after_ms: number;
}): AcpWorkerRow[] {
  ensureInit();
  const cutoff = Date.now() - Math.max(0, stale_after_ms);
  const rows = listAcpWorkers({
    host_id,
    states: ["active", "draining"],
  });
  return rows.filter((row) => row.last_heartbeat_at >= cutoff);
}

export function setAcpWorkerState({
  worker_id,
  state,
  stop_reason,
}: {
  worker_id: string;
  state: AcpWorkerState;
  stop_reason?: string | null;
}): AcpWorkerRow | undefined {
  ensureInit();
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = ?,
           last_heartbeat_at = ?,
           exit_requested_at = CASE
             WHEN ? = 'draining' THEN COALESCE(exit_requested_at, ?)
             ELSE exit_requested_at
           END,
           stopped_at = CASE WHEN ? = 'stopped' THEN ? ELSE NULL END,
           stop_reason = CASE
             WHEN ? = 'stopped' THEN COALESCE(?, stop_reason)
             WHEN ? = 'draining' THEN NULL
             ELSE stop_reason
           END
       WHERE worker_id = ?`,
    )
    .run(
      state,
      now,
      state,
      now,
      state,
      now,
      state,
      stop_reason ?? null,
      state,
      worker_id,
    );
  return getAcpWorker(worker_id);
}

export function heartbeatAcpWorker({
  worker_id,
  pid,
  state,
  last_seen_running_jobs,
}: {
  worker_id: string;
  pid?: number | null;
  state?: AcpWorkerState;
  last_seen_running_jobs: number;
}): AcpWorkerRow | undefined {
  ensureInit();
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET pid = COALESCE(?, pid),
           state = COALESCE(?, state),
           exit_requested_at = CASE
             WHEN COALESCE(?, state) = 'draining' THEN COALESCE(exit_requested_at, ?)
             ELSE exit_requested_at
           END,
           last_heartbeat_at = ?,
           last_seen_running_jobs = ?
       WHERE worker_id = ?`,
    )
    .run(
      pid ?? null,
      state ?? null,
      state ?? null,
      now,
      now,
      Math.max(0, Math.floor(last_seen_running_jobs)),
      worker_id,
    );
  return getAcpWorker(worker_id);
}

export function stopAcpWorker({
  worker_id,
  reason,
}: {
  worker_id: string;
  reason?: string | null;
}): AcpWorkerRow | undefined {
  ensureInit();
  const now = Date.now();
  getAcpDatabase()
    .prepare(
      `UPDATE ${TABLE}
       SET state = 'stopped',
           last_heartbeat_at = ?,
           stopped_at = ?,
           stop_reason = COALESCE(?, stop_reason)
       WHERE worker_id = ?`,
    )
    .run(now, now, reason ?? null, worker_id);
  return getAcpWorker(worker_id);
}
