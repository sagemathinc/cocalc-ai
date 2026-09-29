/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import {
  adoptProgressPage,
  installProgressAdoption,
} from "./progress-adoption";

export interface CensusReportWork {
  project_id: string;
  token: string;
  due_at: number;
}

/** Optional host-private report admission. The census store owns the process lock.
 * Install only after its schema migration, outside another transaction.
 */
export class CensusReportQueue {
  constructor(private readonly db: DatabaseSync) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const installed = !!db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='census_report_queue'",
        )
        .get();
      db.exec(`CREATE TABLE IF NOT EXISTS census_report_queue (
        project_id TEXT PRIMARY KEY REFERENCES census_runs(project_id) ON DELETE CASCADE,
        token TEXT NOT NULL, due_at INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS census_report_queue_due ON census_report_queue(due_at,project_id)`);
      const mark = (
        row: "OLD" | "NEW",
        condition = "1",
      ) => `INSERT INTO census_report_queue(project_id,token)
        SELECT project_id,lower(hex(randomblob(16))) FROM census_runs WHERE project_id=${row}.project_id AND (${condition})
        ON CONFLICT(project_id) DO UPDATE SET token=excluded.token;`;
      const columns = {
        census_runs: [
          "run_id",
          "request",
          "started_at",
          "compact_status",
          "blocked_reason",
        ],
        census_directories: ["project_id", "state", "error"],
        census_entries: ["project_id", "excluded", "symlink"],
        census_candidates: ["project_id", "acknowledged", "error"],
      };
      for (const [table, fields] of Object.entries(columns)) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS report_queue_${table}_insert
          AFTER INSERT ON ${table} BEGIN ${mark("NEW")} END`);
        if (table !== "census_runs")
          db.exec(`CREATE TRIGGER IF NOT EXISTS report_queue_${table}_delete
            AFTER DELETE ON ${table} BEGIN ${mark("OLD")} END`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS report_queue_${table}_update
          AFTER UPDATE OF ${fields.join(",")} ON ${table}
          WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")}
          BEGIN ${fields.includes("project_id") ? mark("OLD", "OLD.project_id IS NOT NEW.project_id") : ""} ${mark("NEW")} END`);
      }
      installProgressAdoption(db, "census_report_queue", installed);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.adopt();
  }

  adopt(limit = 16) {
    return adoptProgressPage(
      this.db,
      "census_report_queue",
      "census_runs",
      limit,
    );
  }

  /** The caller acknowledges its journal signal only after this durable handoff.
   * No census means no report target; a future run insertion creates its own work.
   */
  enqueue(project_id: string): boolean {
    return (
      this.db
        .prepare(
          `INSERT INTO census_report_queue(project_id,token)
      SELECT project_id,lower(hex(randomblob(16))) FROM census_runs WHERE project_id=?
      ON CONFLICT(project_id) DO UPDATE SET token=excluded.token`,
        )
        .run(project_id).changes === 1
    );
  }

  due(now: number, limit = 16): CensusReportWork[] {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw Error("invalid report queue page");
    return this.db
      .prepare(
        "SELECT project_id,token,due_at FROM census_report_queue WHERE due_at<=? ORDER BY due_at,project_id LIMIT ?",
      )
      .all(now, limit) as unknown as CensusReportWork[];
  }

  settle(work: CensusReportWork, retryAt?: number): boolean {
    if (retryAt !== undefined) {
      if (!Number.isSafeInteger(retryAt) || retryAt < 0)
        throw Error("invalid report retry deadline");
      return (
        this.db
          .prepare(
            "UPDATE census_report_queue SET due_at=? WHERE project_id=? AND token=?",
          )
          .run(retryAt, work.project_id, work.token).changes === 1
      );
    }
    return (
      this.db
        .prepare(
          "DELETE FROM census_report_queue WHERE project_id=? AND token=?",
        )
        .run(work.project_id, work.token).changes === 1
    );
  }
}
