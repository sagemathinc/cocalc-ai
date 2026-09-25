/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import type {
  HostProjectMaintenanceSchedule,
  ProjectMaintenanceReport,
} from "@cocalc/conat/project-host/api";

const TABLE = "project_maintenance_reports";
const ATTEMPTS_TABLE = "project_maintenance_attempts";
const ATTEMPTS_SCHEMA_VERSION = 1;
const MAX_DELIVERED_ATTEMPTS_PER_PROJECT_KIND = 128;
const MAX_PENDING_ATTEMPTS = 100_000;
const DELIVERED_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SCHEDULE_TABLE = "project_maintenance_schedules";
const SCHEDULE_SCHEMA_VERSION = 1;
const MAX_CACHED_SCHEDULES = 100_000;
export const MAX_MAINTENANCE_OWNERSHIP_LEASE_MS = 10 * 60_000;
let initializedDb: ReturnType<typeof initDatabase> | undefined;

function ensureTable(): void {
  const db = initDatabase();
  if (initializedDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      observed_ms INTEGER NOT NULL,
      payload TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, kind)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${TABLE}_pending_idx
       ON ${TABLE}(delivered, observed_ms)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ATTEMPTS_TABLE} (
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      observed_ms INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, kind, observed_ms)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${ATTEMPTS_TABLE}_pending_idx
       ON ${ATTEMPTS_TABLE}(delivered, observed_ms)`,
  );
  // The old table holds one report per project and operation. Carry pending
  // reports forward on upgrade without losing a bay-disconnect retry.
  db.exec(`
    INSERT OR IGNORE INTO ${ATTEMPTS_TABLE}
      (project_id, kind, observed_ms, schema_version, payload, delivered)
    SELECT project_id, kind, observed_ms, ${ATTEMPTS_SCHEMA_VERSION},
           payload, delivered FROM ${TABLE}
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEDULE_TABLE} (
      project_id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      verified_ms INTEGER NOT NULL,
      batch_id TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${SCHEDULE_TABLE}_host_verified_idx
       ON ${SCHEDULE_TABLE}(host_id, verified_ms)`,
  );
  initializedDb = db;
}

export function saveValidatedMaintenanceSchedules({
  hostId,
  rows,
  requestedProjectIds,
  verifiedAtMs = Date.now(),
}: {
  hostId: string;
  rows: HostProjectMaintenanceSchedule[];
  requestedProjectIds?: string[];
  verifiedAtMs?: number;
}): void {
  ensureTable();
  const db = getDatabase();
  const batchId = randomUUID();
  const upsert = db.prepare(
    `INSERT INTO ${SCHEDULE_TABLE}
       (project_id, host_id, schema_version, verified_ms, batch_id, payload)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       host_id=excluded.host_id,
       schema_version=excluded.schema_version,
       verified_ms=excluded.verified_ms,
       batch_id=excluded.batch_id,
       payload=excluded.payload`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      upsert.run(
        row.project_id,
        hostId,
        SCHEDULE_SCHEMA_VERSION,
        verifiedAtMs,
        batchId,
        JSON.stringify(row),
      );
    }
    if (requestedProjectIds) {
      const returned = new Set(rows.map(({ project_id }) => project_id));
      const remove = db.prepare(
        `DELETE FROM ${SCHEDULE_TABLE} WHERE project_id=? AND host_id=?`,
      );
      for (const projectId of requestedProjectIds) {
        if (!returned.has(projectId)) remove.run(projectId, hostId);
      }
    } else {
      // A complete bay inventory is authoritative, including an empty one.
      db.prepare(
        `DELETE FROM ${SCHEDULE_TABLE}
         WHERE host_id=? AND batch_id<>?`,
      ).run(hostId, batchId);
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM ${SCHEDULE_TABLE}`)
      .get() as { count: number };
    if (count.count > MAX_CACHED_SCHEDULES) {
      throw new Error("maintenance schedule cache capacity exceeded");
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listLeasedMaintenanceSchedules({
  hostId,
  projectIds,
  nowMs = Date.now(),
}: {
  hostId: string;
  projectIds?: string[];
  nowMs?: number;
}): HostProjectMaintenanceSchedule[] {
  ensureTable();
  if (projectIds?.length === 0) return [];
  const cutoff = nowMs - MAX_MAINTENANCE_OWNERSHIP_LEASE_MS;
  const filter = projectIds
    ? `AND project_id IN (${projectIds.map(() => "?").join(",")})`
    : "";
  const rows = getDatabase()
    .prepare(
      `SELECT payload FROM ${SCHEDULE_TABLE}
       WHERE host_id=? AND schema_version=? AND verified_ms>=?
       ${filter} ORDER BY project_id LIMIT ?`,
    )
    .all(
      hostId,
      SCHEDULE_SCHEMA_VERSION,
      cutoff,
      ...(projectIds ?? []),
      MAX_CACHED_SCHEDULES + 1,
    ) as Array<{ payload: string }>;
  if (rows.length > MAX_CACHED_SCHEDULES) {
    throw new Error("maintenance schedule cache capacity exceeded");
  }
  return rows.map(({ payload }) => JSON.parse(payload));
}

// The newest local observation survives a bay disconnect or host restart.
// Retaining its exact payload makes replay idempotent at the bay projection.
export function saveMaintenanceReport(report: ProjectMaintenanceReport): void {
  ensureTable();
  const observedMs = Date.parse(report.observed_at);
  if (!Number.isFinite(observedMs)) throw new Error("invalid report timestamp");
  const db = getDatabase();
  const payload = JSON.stringify(report);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO ${ATTEMPTS_TABLE}
         (project_id, kind, observed_ms, schema_version, payload, delivered)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(project_id, kind, observed_ms) DO UPDATE SET
         payload=excluded.payload, delivered=0
       WHERE ${ATTEMPTS_TABLE}.payload<>excluded.payload`,
    ).run(
      report.project_id,
      report.kind,
      observedMs,
      ATTEMPTS_SCHEMA_VERSION,
      payload,
    );
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${ATTEMPTS_TABLE} WHERE delivered=0`,
      )
      .get() as { count: number };
    if (pending.count > MAX_PENDING_ATTEMPTS) {
      throw new Error("maintenance report queue capacity exceeded");
    }
    db.prepare(
      `INSERT INTO ${TABLE}(project_id, kind, observed_ms, payload, delivered)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(project_id, kind) DO UPDATE SET
         observed_ms=excluded.observed_ms,
         payload=excluded.payload,
         delivered=0
       WHERE excluded.observed_ms >= ${TABLE}.observed_ms`,
    ).run(report.project_id, report.kind, observedMs, payload);
    db.prepare(
      `DELETE FROM ${ATTEMPTS_TABLE}
       WHERE project_id=? AND kind=? AND delivered=1
         AND observed_ms<?`,
    ).run(
      report.project_id,
      report.kind,
      observedMs - DELIVERED_ATTEMPT_RETENTION_MS,
    );
    db.prepare(
      `DELETE FROM ${ATTEMPTS_TABLE} WHERE rowid IN (
         SELECT rowid FROM ${ATTEMPTS_TABLE}
         WHERE project_id=? AND kind=? AND delivered=1
         ORDER BY observed_ms DESC LIMIT -1 OFFSET ?
       )`,
    ).run(
      report.project_id,
      report.kind,
      MAX_DELIVERED_ATTEMPTS_PER_PROJECT_KIND,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listPendingMaintenanceReports(
  limit = 500,
): ProjectMaintenanceReport[] {
  ensureTable();
  const rows = getDatabase()
    .prepare(
      `SELECT payload FROM ${ATTEMPTS_TABLE} WHERE delivered=0
       ORDER BY observed_ms ASC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{
    payload: string;
  }>;
  return rows.map(({ payload }) => JSON.parse(payload));
}

export function markMaintenanceReportDelivered(
  report: ProjectMaintenanceReport,
): void {
  ensureTable();
  const db = getDatabase();
  const args = [
    report.project_id,
    report.kind,
    Date.parse(report.observed_at),
    JSON.stringify(report),
  ] as const;
  db.prepare(
    `UPDATE ${ATTEMPTS_TABLE} SET delivered=1
       WHERE project_id=? AND kind=? AND observed_ms=? AND payload=?`,
  ).run(...args);
  db.prepare(
    `UPDATE ${TABLE} SET delivered=1
     WHERE project_id=? AND kind=? AND observed_ms=? AND payload=?`,
  ).run(...args);
}

export function listRecentMaintenanceAttempts({
  projectId,
  kind,
  limit = 20,
}: {
  projectId: string;
  kind?: "snapshot" | "backup";
  limit?: number;
}): ProjectMaintenanceReport[] {
  ensureTable();
  const rows = getDatabase()
    .prepare(
      `SELECT payload FROM ${ATTEMPTS_TABLE}
       WHERE project_id=? ${kind ? "AND kind=?" : ""}
       ORDER BY observed_ms DESC LIMIT ?`,
    )
    .all(
      projectId,
      ...(kind ? [kind] : []),
      Math.max(1, Math.min(128, Math.floor(limit))),
    ) as Array<{ payload: string }>;
  return rows.map(({ payload }) => JSON.parse(payload));
}
