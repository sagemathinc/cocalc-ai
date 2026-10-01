/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";
import {
  adoptProgressPage,
  installProgressAdoption,
} from "./progress-adoption";

export interface CollaborationProgressSignal {
  project_id: string;
  token: string;
}

/** Optional durable handoff to census reporting, not an authority or freshness claim.
 * Installation retains capture across restart; removing a consumer does not
 * remove triggers. One row coalesces all pending changes for a project.
 */
export class CollaborationProgressSignals {
  constructor(private readonly db: DatabaseSync) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const installed = !!db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_progress_signals'",
        )
        .get();
      db.exec(`CREATE TABLE IF NOT EXISTS collaboration_progress_signals (
        project_id TEXT PRIMARY KEY, token TEXT NOT NULL)`);
      const mark = (
        row: "NEW" | "OLD",
        condition = "1",
      ) => `INSERT INTO collaboration_progress_signals(project_id,token)
        SELECT ${row}.project_id,lower(hex(randomblob(16))) WHERE ${condition}
        ON CONFLICT(project_id) DO UPDATE SET token=excluded.token;`;
      for (const table of ["sources", "deliveries", "source_redirects"]) {
        for (const [event, row] of [
          ["INSERT", "NEW"],
          ["DELETE", "OLD"],
        ] as const)
          db.exec(`CREATE TRIGGER IF NOT EXISTS progress_${table}_${event.toLowerCase()}
            AFTER ${event} ON ${table} BEGIN ${mark(row)} END`);
        const columns =
          table === "sources"
            ? ["project_id", "chat_path", "dirty", "epoch", "failures"]
            : ["project_id", "chat_path"];
        db.exec(`CREATE TRIGGER IF NOT EXISTS progress_${table}_update
          AFTER UPDATE OF ${columns.join(",")} ON ${table}
          WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
          BEGIN ${mark("OLD", "OLD.project_id IS NOT NEW.project_id")} ${mark("NEW")} END`);
      }
      installProgressAdoption(db, "collaboration_progress_signals", installed);
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
      "collaboration_progress_signals",
      "sources",
      limit,
    );
  }

  page(after = "", limit = 16): CollaborationProgressSignal[] {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      typeof after !== "string" ||
      after.length > 200
    )
      throw Error("invalid progress signal page");
    return this.db
      .prepare(
        `SELECT project_id,token FROM collaboration_progress_signals
      WHERE project_id>? ORDER BY project_id LIMIT ?`,
      )
      .all(after, limit) as unknown as CollaborationProgressSignal[];
  }

  acknowledge(signal: CollaborationProgressSignal): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM collaboration_progress_signals WHERE project_id=? AND token=?",
        )
        .run(signal.project_id, signal.token).changes === 1
    );
  }
}
