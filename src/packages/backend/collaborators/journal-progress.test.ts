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
    // A filename scan counts only its own admitted current sources, rather than
    // inheriting failures from old known paths that were absent from its search.
    for (const path of ["dirty", "delivery", "retired"])
      db.prepare("INSERT INTO census_receipts VALUES(?,?,'current-run')").run(
        project,
        `/home/user/${path}.chat`,
      );
    db.prepare("INSERT INTO census_receipts VALUES(?,?,'previous-run')").run(
      project,
      "/home/user/error.chat",
    );
    expect(journal.censusProgress(project, "current-run")).toEqual({
      source_pending: 2,
      source_errors: 0,
    });
    expect(journal.censusProgress(project, "previous-run")).toEqual({
      source_pending: 0,
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

test("scan diagnostics retain only bounded error categories across restart and omit settled files", () => {
  const directory = mkdtempSync(join(tmpdir(), "journal-scan-issues-"));
  const filename = join(directory, "journal.sqlite");
  let journal = new CollaborationJournal(filename);
  const project_id = "11111111-1111-4111-8111-111111111111";
  const db = new DatabaseSync(filename);
  try {
    for (let i = 0; i < 7; i++) {
      const chat_path = `/home/user/${i}.chat`;
      db.prepare(
        "INSERT INTO sources(project_id,chat_path,registration_id,epoch) VALUES(?,?,'registration','epoch')",
      ).run(project_id, chat_path);
      db.prepare("INSERT INTO census_receipts VALUES(?,?,'run')").run(
        project_id,
        chat_path,
      );
      journal.defer(
        { project_id, chat_path, epoch: "epoch" },
        0,
        Error(
          "copied chat identity conflict; private raw error must not be retained",
        ),
      );
    }
    journal.close();
    journal = new CollaborationJournal(filename);
    expect(journal.censusIssues(project_id, "run")).toHaveLength(5);
    expect(journal.censusIssues(project_id, "run")[0]).toEqual({
      chat_path: "/home/user/0.chat",
      reason: "identity_conflict",
    });
    expect(journal.censusIssues(project_id, "another-run")).toEqual([]);
    db.prepare("UPDATE sources SET failures=0 WHERE project_id=?").run(
      project_id,
    );
    expect(journal.censusIssues(project_id, "run")).toEqual([]);
  } finally {
    db.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new manual admission retries immediately while same-run replay preserves its failure backoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "journal-new-scan-"));
  const filename = join(directory, "journal.sqlite");
  const journal = new CollaborationJournal(filename);
  const db = new DatabaseSync(filename);
  const source = {
    project_id: "11111111-1111-4111-8111-111111111111",
    chat_path: "/home/user/a.chat",
    epoch: "epoch",
  };
  try {
    db.prepare(
      "INSERT INTO sources(project_id,chat_path,registration_id,epoch,retry_at,failures,error_code) VALUES(?,?,'registration','epoch',60000,10,'identity_conflict')",
    ).run(source.project_id, source.chat_path);
    journal.acceptCensusCandidate({ ...source, run_id: "fresh" });
    expect(journal.scans(1, 0)).toHaveLength(1);
    expect(journal.censusIssues(source.project_id, "fresh")).toEqual([]);
    journal.defer(source, 0, Error("duplicate chat identity"));
    expect(journal.acceptCensusCandidate({ ...source, run_id: "fresh" })).toBe(
      false,
    );
    expect(journal.scans(1, 0)).toEqual([]);
    expect(journal.censusIssues(source.project_id, "fresh")[0]?.reason).toBe(
      "identity_conflict",
    );
  } finally {
    db.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("permanent file errors stop automatic parsing retries until a new write", () => {
  const directory = mkdtempSync(join(tmpdir(), "journal-file-failure-"));
  const journal = new CollaborationJournal(join(directory, "journal.sqlite"));
  const source = {
    project_id: "11111111-1111-4111-8111-111111111111",
    chat_path: "/home/user/a.chat",
  };
  try {
    journal.acceptCensusCandidate({ ...source, run_id: "run" });
    const registration = journal.registrations(1, 0)[0];
    journal.registered(registration, "epoch");
    journal.defer(
      { ...source, epoch: "epoch" },
      0,
      Error("invalid JSON"),
      true,
    );
    expect(journal.scans(1, 86400000)).toEqual([]);
    expect(journal.censusProgress(source.project_id, "run")).toMatchObject({
      source_file_errors: 1,
    });
    journal.touch(source);
    expect(journal.scans(1, 86400000)).toHaveLength(1);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
