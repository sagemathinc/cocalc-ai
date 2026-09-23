/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import type { ProjectMaintenanceReport } from "@cocalc/conat/project-host/api";

const TABLE = "project_maintenance_reports";
let initialized = false;

function ensureTable(): void {
  if (initialized) return;
  const db = initDatabase();
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
  initialized = true;
}

// The newest local observation survives a bay disconnect or host restart.
// Retaining its exact payload makes replay idempotent at the bay projection.
export function saveMaintenanceReport(report: ProjectMaintenanceReport): void {
  ensureTable();
  const observedMs = Date.parse(report.observed_at);
  if (!Number.isFinite(observedMs)) throw new Error("invalid report timestamp");
  getDatabase()
    .prepare(
      `INSERT INTO ${TABLE}(project_id, kind, observed_ms, payload, delivered)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(project_id, kind) DO UPDATE SET
         observed_ms=excluded.observed_ms,
         payload=excluded.payload,
         delivered=0
       WHERE excluded.observed_ms >= ${TABLE}.observed_ms`,
    )
    .run(report.project_id, report.kind, observedMs, JSON.stringify(report));
}

export function listPendingMaintenanceReports(
  limit = 500,
): ProjectMaintenanceReport[] {
  ensureTable();
  const rows = getDatabase()
    .prepare(
      `SELECT payload FROM ${TABLE} WHERE delivered=0
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
  getDatabase()
    .prepare(
      `UPDATE ${TABLE} SET delivered=1
       WHERE project_id=? AND kind=? AND observed_ms=? AND payload=?`,
    )
    .run(
      report.project_id,
      report.kind,
      Date.parse(report.observed_at),
      JSON.stringify(report),
    );
}
