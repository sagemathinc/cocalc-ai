/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { DatabaseSync } from "node:sqlite";

type Queue = "collaboration_progress_signals" | "census_report_queue";
type Source = "sources" | "census_runs";

/** Called inside schema installation. Earlier queue versions already adopted all rows. */
export function installProgressAdoption(
  db: DatabaseSync,
  queue: Queue,
  installed: boolean,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${queue}_adoption (
    id INTEGER PRIMARY KEY CHECK(id=1), after_project TEXT NOT NULL, complete INTEGER NOT NULL)`);
  db.prepare(`INSERT OR IGNORE INTO ${queue}_adoption VALUES(1,'',?)`).run(
    installed ? 1 : 0,
  );
}

/** Strictly bounded index seeks, including when one project has many source rows. */
export function adoptProgressPage(
  db: DatabaseSync,
  queue: Queue,
  source: Source,
  limit = 16,
): { examined: number; complete: boolean } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error("invalid progress adoption limit");
  const state = db.prepare(
    `SELECT after_project,complete FROM ${queue}_adoption WHERE id=1`,
  );
  if (state.get()!.complete) return { examined: 0, complete: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = state.get()!;
    let after = String(current.after_project);
    let complete = !!current.complete;
    let examined = 0;
    const next = db.prepare(
      `SELECT project_id FROM ${source} WHERE project_id>? ORDER BY project_id LIMIT 1`,
    );
    const insert = db.prepare(
      `INSERT INTO ${queue}(project_id,token) VALUES(?,lower(hex(randomblob(16)))) ON CONFLICT(project_id) DO NOTHING`,
    );
    while (!complete && examined < limit) {
      const row = next.get(after);
      if (!row) {
        complete = true;
        break;
      }
      after = String(row.project_id);
      insert.run(after);
      examined++;
    }
    db.prepare(
      `UPDATE ${queue}_adoption SET after_project=?,complete=? WHERE id=1`,
    ).run(after, complete ? 1 : 0);
    db.exec("COMMIT");
    return { examined, complete };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
