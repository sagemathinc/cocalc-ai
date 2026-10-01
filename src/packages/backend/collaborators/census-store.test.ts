/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CollaborationCensusStore } from "./census-store";
import {
  censusCapacityFromEnvironment,
  DEFAULT_CENSUS_CAPACITY,
} from "./census-types";
import type { CensusRequest, CensusWork } from "./census-types";

const request: CensusRequest = {
  project_id: "project-1",
  run_id: "run-1",
  authority: "owner-host-epoch-1",
  volume_id: "persistent-volume-1",
  policy_version: "home-v1",
  root: "/home/user",
};
let directory: string;
let store: CollaborationCensusStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "collaborators-census-store-"));
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function root(input: CensusRequest = request): CensusWork {
  const run = store.begin(input);
  return { run, path: run.root, depth: 0 };
}
function restart() {
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"));
}

test("enqueue is idempotent, persists scope, and replacement requires a CAS", () => {
  const run = store.begin(request);
  expect(store.begin(request)).toEqual(run);
  expect(() => store.begin({ ...request, volume_id: "other" })).toThrow(
    /reused/,
  );
  expect(() => store.begin({ ...request, run_id: "run-2" })).toThrow(
    /current run/,
  );
  restart();
  expect(store.status(request.project_id)?.run).toEqual(run);
  expect(store.begin({ ...request, run_id: "run-2" }, "run-1").run_id).toBe(
    "run-2",
  );
  expect(store.isCurrent(run)).toBe(false);
});

test("filename snapshot, pending handoff and lost ACK survive restart", () => {
  const { run } = root();
  store.recordDiscovery(run, ["/home/user/a.chat", "/home/user/a.chat"]);
  const candidate = store.candidates(0)[0];
  expect(store.status(run.project_id)).toMatchObject({
    candidates: 1,
    traversal_complete: true,
    pending_candidates: 1,
  });
  restart();
  expect(store.next(0)).toBeUndefined();
  expect(store.candidates(0)).toEqual([candidate]);
  store.acknowledge(candidate);
  expect(store.compactCompleted()).toBe(1);
  expect(store.recordDiscovery(run, ["/home/user/late.chat"])).toBe(false);
  restart();
  expect(store.status(run.project_id)?.coverage).toBe("complete");
});

test.each([
  "/elsewhere/a.chat",
  "/home/user/../a.chat",
  "/home/user/.snapshots/a.chat",
  "/home/user/nested/.snapshots/a.chat",
  "/home/user/a.sage-chat",
])("invalid discovery %s cannot partially commit", (path) => {
  const { run } = root();
  expect(() =>
    store.recordDiscovery(run, ["/home/user/valid.chat", path]),
  ).toThrow();
  restart();
  expect(store.candidates(0)).toEqual([]);
  expect(store.status(run.project_id)?.traversal_complete).toBe(false);
});

test("failed SQLite candidate insertion rolls back the entire snapshot", () => {
  const { run } = root();
  const db = new DatabaseSync(join(directory, "census.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON census_candidates WHEN NEW.chat_path='/home/user/b.chat' BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    expect(() =>
      store.recordDiscovery(run, ["/home/user/a.chat", "/home/user/b.chat"]),
    ).toThrow(/injected/);
    restart();
    expect(store.candidates(0)).toEqual([]);
    expect(store.status(run.project_id)?.traversal_complete).toBe(false);
  } finally {
    db.close();
  }
});

test("candidate limit failure preserves the run and accepts no partial list", () => {
  const { run } = root({ ...request, limits: { candidates: 1 } });
  expect(() =>
    store.recordDiscovery(run, ["/home/user/a.chat", "/home/user/b.chat"]),
  ).toThrow(/candidate_limit/);
  restart();
  expect(store.status(run.project_id)?.run.run_id).toBe(run.run_id);
  expect(store.candidates(0)).toEqual([]);
});

test("stale discovery and ACK cannot change a replacement run", () => {
  const { run } = root();
  store.recordDiscovery(run, ["/home/user/a.chat"]);
  const old = store.candidates(0)[0];
  store.begin({ ...request, run_id: "second" }, run.run_id);
  expect(store.recordDiscovery(run, ["/home/user/late.chat"])).toBe(false);
  expect(store.acknowledge(old)).toBe(false);
  restart();
  expect(store.candidates(0)).toEqual([]);
});

test("cancellation fences late discovery and retains successful baseline", () => {
  const { run } = root();
  store.finishScan(run, true);
  const successful = store.scanTimes(run.project_id).last_success;
  const next = store.begin(
    { ...request, run_id: "second" },
    run.run_id,
    Date.now() + 1,
  );
  store.cancel(next);
  store.finishScan(next, false);
  restart();
  expect(store.recordDiscovery(next, ["/home/user/late.chat"])).toBe(false);
  expect(store.scanTimes(run.project_id)).toMatchObject({
    last_success: successful,
    last_fail: expect.any(Number),
  });
});

test("compaction retains pending handoff and exact report retries", () => {
  const { run } = root();
  store.recordDiscovery(run, ["/home/user/a.chat"]);
  store.setReportCheckpoint(run.project_id, '{"acknowledged":false}');
  expect(store.compactCompleted()).toBe(0);
  store.acknowledge(store.candidates(0)[0]);
  expect(store.compactCompleted()).toBe(1);
  restart();
  expect(store.reportCheckpoint(run.project_id)).toBe('{"acknowledged":false}');
});

test("operator limits are explicit, bounded, and reject malformed configuration", () => {
  expect(censusCapacityFromEnvironment({})).toEqual(DEFAULT_CENSUS_CAPACITY);
  expect(
    censusCapacityFromEnvironment({
      COCALC_COLLABORATORS_CENSUS_PROJECTS: "8000",
      COCALC_COLLABORATORS_CENSUS_BYTES: "134217728",
    }),
  ).toEqual({ projects: 8000, bytes: 134217728 });
  for (const value of ["", "0", "-1", "1.5", "100001", " 2000", "NaN"])
    expect(() =>
      censusCapacityFromEnvironment({
        COCALC_COLLABORATORS_CENSUS_PROJECTS: value,
      }),
    ).toThrow();
});

test("configured project capacity increase admits a new project without evicting pinned work", () => {
  store.close();
  const filename = join(directory, "admission.sqlite");
  store = new CollaborationCensusStore(filename, {
    projects: 1,
    bytes: DEFAULT_CENSUS_CAPACITY.bytes,
  });
  const work = root();
  store.recordDiscovery(work.run, [work.run.root + "/pending.chat"]);
  const pinned = store.status(request.project_id);
  expect(() => root({ ...request, project_id: "later" })).toThrow(
    /project_limit/,
  );
  store.close();
  store = new CollaborationCensusStore(filename, {
    projects: 1000,
    bytes: DEFAULT_CENSUS_CAPACITY.bytes,
  });
  root({ ...request, project_id: "later" });
  expect(store.status(request.project_id)).toEqual(pinned);
  expect(store.candidates(0)).toHaveLength(1);
  expect(store.usage().projects).toBe(2);
});

test("a second store process lease is rejected and released on close", () => {
  expect(
    () => new CollaborationCensusStore(join(directory, "census.sqlite")),
  ).toThrow();
  restart();
  expect(store.begin(request).run_id).toBe(request.run_id);
});
