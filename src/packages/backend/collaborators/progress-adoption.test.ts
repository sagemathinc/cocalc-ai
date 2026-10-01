/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationJournal } from "./journal";
import { CollaborationProgressSignals } from "./progress-signals";

test("adoption is bounded, resumes without reseeding, and preserves newer signals", () => {
  const directory = mkdtempSync(join(tmpdir(), "progress-adoption-"));
  const filename = join(directory, "journal.sqlite");
  const journal = new CollaborationJournal(filename);
  let db = new DatabaseSync(filename);
  try {
    const insert = db.prepare(
      "INSERT INTO sources(project_id,chat_path,registration_id) VALUES(?,?,'registration')",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 50; i++)
      insert.run(String(i).padStart(3, "0"), "a.chat");
    for (let i = 0; i < 1000; i++) insert.run("000", `extra-${i}.chat`);
    db.exec("COMMIT");
    let signals = new CollaborationProgressSignals(db);
    expect(signals.page("", 100)).toHaveLength(16);
    for (const signal of signals.page()) signals.acknowledge(signal);
    db.exec("UPDATE sources SET dirty=0 WHERE project_id='049'");
    const newer = signals.page()[0];
    expect(newer.project_id).toBe("049");
    expect(signals.adopt(3)).toEqual({ examined: 3, complete: false });
    db.close();
    db = new DatabaseSync(filename);
    signals = new CollaborationProgressSignals(db);
    expect(signals.page("", 100).some((row) => row.project_id < "016")).toBe(
      false,
    );
    while (!signals.adopt(3).complete) {}
    expect(signals.page("048")).toEqual([newer]);
    expect(signals.adopt()).toEqual({ examined: 0, complete: true });
    db.prepare(
      "INSERT INTO sources(project_id,chat_path,registration_id) VALUES('!','a.chat','registration')",
    ).run();
    expect(signals.page()[0].project_id).toBe("!");
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT project_id FROM sources WHERE project_id>? ORDER BY project_id LIMIT 1",
      )
      .all("");
    expect(plan.map((row) => row.detail).join(" ")).toMatch(/SEARCH.*INDEX/);
    expect(() => signals.adopt(101)).toThrow("invalid progress adoption limit");
    // The prior schema already adopted all rows; upgrading must not replay them.
    db.exec(
      "DELETE FROM collaboration_progress_signals; DROP TABLE collaboration_progress_signals_adoption",
    );
    signals = new CollaborationProgressSignals(db);
    expect(signals.page()).toEqual([]);
    expect(signals.adopt()).toEqual({ examined: 0, complete: true });
  } finally {
    db.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
