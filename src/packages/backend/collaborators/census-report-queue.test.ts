/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationCensusStore } from "./census-store";
import { CensusReportQueue } from "./census-report-queue";

test("durable report admission wakes changed progress and fences settlement", () => {
  const directory = mkdtempSync(join(tmpdir(), "census-report-queue-"));
  const filename = join(directory, "census.sqlite");
  let store = new CollaborationCensusStore(filename);
  let db = new DatabaseSync(filename);
  const begin = (id: string) =>
    store.begin({
      project_id: id,
      run_id: `run-${id}`,
      root: "/home/user",
      authority: "host",
      volume_id: "volume",
      policy_version: "v1",
    });
  try {
    begin("a");
    let queue = new CensusReportQueue(db);
    const first = queue.due(0)[0];
    expect(first.project_id).toBe("a");
    expect(queue.settle(first, 30000)).toBe(true);
    expect(queue.due(0)).toEqual([]);
    expect(queue.enqueue("a")).toBe(true);
    expect(queue.enqueue("no-census")).toBe(false);
    expect(queue.due(0)).toHaveLength(1);
    const next = queue.due(0)[0];
    expect(next.token).not.toBe(first.token);
    expect(queue.settle(first)).toBe(false);
    db.exec("BEGIN; UPDATE census_runs SET blocked_reason='test'; ROLLBACK");
    expect(queue.due(30000)).toEqual([next]);
    expect(queue.settle(next)).toBe(true);
    store.setReportCheckpoint("a", "{}");
    expect(queue.due(30000)).toEqual([]);
    db.exec("UPDATE census_runs SET turn=turn+1");
    expect(queue.due(30000)).toEqual([]);
    db.close();
    store.close();
    store = new CollaborationCensusStore(filename);
    db = new DatabaseSync(filename);
    queue = new CensusReportQueue(db);
    expect(queue.due(30000)).toEqual([]);
    const run = begin("b");
    const inserted = queue.due(30000)[0];
    store.recordDiscovery(run, [run.root + "/new.chat"]);
    expect(queue.settle(inserted)).toBe(false);
    expect(queue.due(30000)).toHaveLength(1);
    const recorded = queue.due(30000)[0];
    store.acknowledge(store.candidates(30000)[0]);
    expect(queue.settle(recorded)).toBe(false);
    expect(queue.settle(queue.due(30000)[0])).toBe(true);
    begin("c");
    begin("d");
    expect(queue.due(30000, 1).map((row) => row.project_id)).toEqual(["c"]);
    db.exec(
      "PRAGMA foreign_keys=ON; DELETE FROM census_runs WHERE project_id='c'",
    );
    expect(queue.due(30000).map((row) => row.project_id)).toEqual(["d"]);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT project_id FROM census_report_queue WHERE due_at<=? ORDER BY due_at,project_id LIMIT 16",
      )
      .all(30000);
    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "census_report_queue_due",
    );
    expect(() => queue.due(0, 101)).toThrow("invalid report queue page");
    expect(() => queue.settle(queue.due(30000)[0], NaN)).toThrow(
      "invalid report retry deadline",
    );
  } finally {
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
