/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CollaborationJournal,
  collaborationCensusProgressSql,
} from "./journal";

test("progress uses pending subsets and preserves exact counts among large clean catalogs", () => {
  const directory = mkdtempSync(join(tmpdir(), "journal-progress-"));
  const filename = join(directory, "journal.sqlite");
  const journal = new CollaborationJournal(filename);
  const db = new DatabaseSync(filename);
  const project = "11111111-1111-4111-8111-111111111111";
  try {
    const insert =
      db.prepare(`INSERT INTO sources(project_id,chat_path,registration_id,epoch,dirty,failures)
      VALUES(?,?,'registration',?,?,?)`);
    db.exec("BEGIN");
    for (const id of [project, "other-project"])
      for (let i = 0; i < 10000; i++)
        insert.run(id, `/home/user/${i}.chat`, "epoch", 0, 0);
    db.exec("COMMIT");
    expect(journal.censusProgress(project)).toEqual({
      source_pending: 0,
      source_errors: 0,
    });
    const details = db
      .prepare("EXPLAIN QUERY PLAN " + collaborationCensusProgressSql)
      .all(project, project, project, project)
      .map((row) => String(row.detail))
      .join("\n");
    expect(details).toContain("sources_census_pending");
    expect(details).toContain("sources_census_errors");
    expect(details).not.toMatch(/SCAN (?:sources|s|d)(?:\s|$)/m);

    insert.run(project, "/home/user/dirty.chat", "epoch", 1, 0);
    insert.run(project, "/home/user/unregistered.chat", "", 0, 0);
    insert.run(project, "/home/user/error.chat", "epoch", 0, 2);
    insert.run(project, "/home/user/delivery.chat", "epoch", 0, 0);
    insert.run(project, "/home/user/retired.chat", "", 1, 1);
    for (const path of ["dirty", "delivery", "retired", "orphan"])
      db.prepare("INSERT INTO deliveries VALUES(?,?,'epoch',1,1,'{}')").run(
        project,
        `/home/user/${path}.chat`,
      );
    db.prepare("INSERT INTO source_redirects VALUES(?,?,?)").run(
      project,
      "/home/user/retired.chat",
      "/home/user/current.chat",
    );
    expect(journal.censusProgress(project)).toEqual({
      source_pending: 3,
      source_errors: 1,
    });
    // Partial index membership follows the actual source transitions.
    db.prepare(
      "UPDATE sources SET dirty=0,epoch='epoch',failures=0 WHERE project_id=?",
    ).run(project);
    expect(journal.censusProgress(project)).toEqual({
      source_pending: 2,
      source_errors: 0,
    });
    db.prepare("DELETE FROM deliveries WHERE project_id=?").run(project);
    expect(journal.censusProgress(project)).toEqual({
      source_pending: 0,
      source_errors: 0,
    });
  } finally {
    db.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
