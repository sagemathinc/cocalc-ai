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

test("signals coalesce atomically, fence stale ACKs, and survive reopen without reseeding", () => {
  const directory = mkdtempSync(join(tmpdir(), "progress-signals-"));
  const filename = join(directory, "journal.sqlite");
  const journal = new CollaborationJournal(filename);
  let db = new DatabaseSync(filename);
  const source = (id: string) =>
    db
      .prepare(
        "INSERT INTO sources(project_id,chat_path,registration_id) VALUES(?,'/home/user/a.chat','registration')",
      )
      .run(id);
  try {
    source("a");
    let signals = new CollaborationProgressSignals(db);
    const initial = signals.page()[0];
    expect(initial.project_id).toBe("a");
    db.exec("UPDATE sources SET dirty=dirty");
    expect(signals.page()).toEqual([initial]);
    db.exec("BEGIN; UPDATE sources SET dirty=0; ROLLBACK");
    expect(signals.page()).toEqual([initial]);
    db.exec("UPDATE sources SET dirty=0");
    const updated = signals.page()[0];
    expect(updated.token).not.toBe(initial.token);
    expect(signals.acknowledge(initial)).toBe(false);
    db.close();
    db = new DatabaseSync(filename);
    signals = new CollaborationProgressSignals(db);
    expect(signals.page()).toEqual([updated]);
    expect(signals.acknowledge(updated)).toBe(true);
    signals = new CollaborationProgressSignals(db);
    expect(signals.page()).toEqual([]);
    db.exec(
      "INSERT INTO deliveries VALUES('a','/home/user/a.chat','epoch',1,1,'{}')",
    );
    expect(signals.page()).toHaveLength(1);
    const delivery = signals.page()[0];
    db.exec("DELETE FROM deliveries");
    expect(signals.acknowledge(delivery)).toBe(false);
    expect(signals.acknowledge(signals.page()[0])).toBe(true);
    db.exec(
      "INSERT INTO source_redirects VALUES('a','/home/user/a.chat','/home/user/b.chat')",
    );
    expect(signals.page()).toHaveLength(1);
    const redirect = signals.page()[0];
    db.exec("DELETE FROM source_redirects; DELETE FROM sources");
    expect(signals.acknowledge(redirect)).toBe(false);
    expect(signals.page()[0].project_id).toBe("a");
    source("b");
    source("c");
    expect(signals.page("", 2).map((row) => row.project_id)).toEqual([
      "a",
      "b",
    ]);
    expect(signals.page("b", 2).map((row) => row.project_id)).toEqual(["c"]);
    expect(() => signals.page("", 101)).toThrow("invalid progress signal page");
  } finally {
    db.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
