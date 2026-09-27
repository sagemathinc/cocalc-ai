/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationCensusStore } from "./census-store";
import { CollaborationJournal } from "./journal";
import type { CensusRequest } from "./census-types";
import { CensusQuotaError } from "./census-types";

let directory: string,
  store: CollaborationCensusStore,
  journal: CollaborationJournal;
const request: CensusRequest = {
  project_id: "11111111-1111-4111-8111-111111111111",
  run_id: "first",
  authority: "host:owner",
  volume_id: "volume",
  root: "/home/user",
  policy_version: "policy-1",
  limits: { candidates: 1 },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "census-rescan-"));
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
});
afterEach(() => {
  store.close();
  journal.close();
  rmSync(directory, { recursive: true, force: true });
});
function restart() {
  store.close();
  journal.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
  journal = new CollaborationJournal(join(directory, "journal.sqlite"));
}

test("explicit reset drains old handoff and exact report retry, preserving snapshots/intents on restart", () => {
  const run = store.begin(request, undefined, 0);
  const work = { run, path: run.root, depth: 0 };
  store.record(work, [{ name: "first.chat", kind: "file" }], false);
  const candidate = store.candidates(0)[0];
  expect(() =>
    store.record(work, [{ name: "unknown.chat", kind: "file" }], true),
  ).toThrow(/candidate_limit/);
  store.fail(work, new CensusQuotaError("candidate_limit"), 0);
  const next = {
    ...request,
    run_id: "second",
    policy_version: "policy-2",
    limits: { candidates: 2 },
  };
  const report = {
    acknowledged: false,
    retry_at: 30000,
    write: { retained: "exact lost ACK payload" },
  };
  const checkpoint = JSON.stringify(report);
  store.setReportCheckpoint(request.project_id, checkpoint);
  expect(store.rescan(next, "first", 1)).toBeUndefined();
  expect(journal.acceptCensusCandidate(candidate)).toBe(true);
  // Crash between journal commit and census ACK: replay retains both intents.
  restart();
  expect(store.rescan(next, "first", 1)).toBeUndefined();
  expect(journal.acceptCensusCandidate(candidate)).toBe(false);
  expect(store.acknowledge(candidate)).toBe(true);
  expect(store.rescan(next, "first", 1)).toBeUndefined();
  expect(store.reportCheckpoint(request.project_id)).toBe(checkpoint);
  store.setReportCheckpoint(
    request.project_id,
    JSON.stringify({ ...report, acknowledged: true }),
  );
  const previous = store.status(request.project_id)!;
  const replacement = store.rescan(next, "first", 1)!;
  expect(replacement.run_id).toBe("second");
  expect(journal.acceptCensusCandidate(candidate)).toBe(false);
  expect(journal.sources()).toHaveLength(1);
  expect(store.status(request.project_id)?.previous).toMatchObject({
    run_id: "first",
    policy_version: "policy-1",
    coverage: "partial",
    blocked_reason: "candidate_limit",
    candidates: previous.candidates,
  });
  expect(store.record(work, [{ name: "late.chat", kind: "file" }], true)).toBe(
    false,
  );
  expect(store.acknowledge(candidate)).toBe(false);
  restart();
  expect(store.status(request.project_id)?.previous?.run_id).toBe("first");
  store.record(
    { run: replacement, path: replacement.root, depth: 0 },
    [
      { name: "first.chat", kind: "file" },
      { name: "unknown.chat", kind: "file" },
    ],
    true,
  );
  for (const pending of store.candidates(1)) {
    journal.acceptCensusCandidate(pending);
    store.acknowledge(pending);
  }
  store.compactCompleted();
  expect(store.status(request.project_id)).toMatchObject({
    coverage: "complete",
    candidates: 2,
    previous: { run_id: "first" },
  });
  expect(journal.sources()).toHaveLength(2);
  store.rescan(
    { ...next, run_id: "third", policy_version: "policy-3" },
    "second",
    2,
  );
  expect(store.status(request.project_id)?.previous).toMatchObject({
    run_id: "second",
    coverage: "complete",
  });
  expect(store.status(request.project_id)?.previous).not.toHaveProperty(
    "previous",
  );
});

test.each(["authority", "volume_id", "root"] as const)(
  "rescan cannot cross the %s scope fence",
  (key) => {
    store.begin(request);
    expect(() =>
      store.rescan(
        {
          ...request,
          run_id: "second",
          [key]: key === "root" ? "/other" : "other",
        },
        "first",
      ),
    ).toThrow(/scope changed/);
    expect(store.status(request.project_id)?.run.run_id).toBe("first");
  },
);
test("stale reset and failed capacity replacement retain unfinished progress", () => {
  store.begin(request);
  const before = store.status(request.project_id);
  expect(() =>
    store.rescan({ ...request, run_id: "second" }, "obsolete"),
  ).toThrow(/current run/);
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"), {
    projects: 1,
    bytes: 1,
  });
  expect(() => store.rescan({ ...request, run_id: "second" }, "first")).toThrow(
    /byte_limit/,
  );
  expect(store.status(request.project_id)).toEqual(before);
});
