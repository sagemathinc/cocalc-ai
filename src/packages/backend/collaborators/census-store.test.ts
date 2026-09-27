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
  CensusQuotaError,
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

test("candidate outbox and completed directory survive restart and lost ACK", () => {
  const work = root();
  store.record(work, [{ name: "unnamed.chat", kind: "file" }], true);
  const candidates = store.candidates(0);
  expect(candidates).toEqual([
    {
      project_id: "project-1",
      run_id: "run-1",
      chat_path: "/home/user/unnamed.chat",
    },
  ]);
  expect(store.status("project-1")).toMatchObject({
    coverage: "indexing",
    traversal_complete: true,
    pending_candidates: 1,
  });
  restart();
  expect(store.next(0)).toBeUndefined();
  expect(store.candidates(0)).toEqual(candidates);
  expect(store.acknowledge(candidates[0])).toBe(true);
  expect(store.acknowledge(candidates[0])).toBe(true);
  expect(store.candidates(0)).toEqual([]);
  expect(store.status("project-1")?.coverage).toBe("complete");
});

test("a rejected batch cannot advance progress or publish its earlier candidates", () => {
  const work = root();
  expect(() =>
    store.record(
      work,
      [
        { name: "valid.chat", kind: "file" },
        { name: "../escape.chat", kind: "file" },
      ],
      true,
    ),
  ).toThrow(/invalid/);
  restart();
  expect(store.status("project-1")).toMatchObject({
    entries: 0,
    candidates: 0,
    completed_directories: 0,
  });
  expect(store.candidates(0)).toEqual([]);
  expect(store.next(0)?.path).toBe(request.root);
});

test("SQLite commit-path failure rolls back candidates and directory completion together", () => {
  const work = root();
  const db = new DatabaseSync(join(directory, "census.sqlite"));
  try {
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON census_candidates
      WHEN NEW.chat_path='/home/user/second.chat' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END`);
    expect(() =>
      store.record(
        work,
        [
          { name: "first.chat", kind: "file" },
          { name: "second.chat", kind: "file" },
        ],
        true,
      ),
    ).toThrow(/injected/);
    restart();
    expect(store.candidates(0)).toEqual([]);
    expect(store.status("project-1")).toMatchObject({
      entries: 0,
      candidates: 0,
      completed_directories: 0,
    });
    db.exec("DROP TRIGGER fail_second");
    store.record(
      work,
      [
        { name: "first.chat", kind: "file" },
        { name: "second.chat", kind: "file" },
      ],
      true,
    );
    expect(store.candidates(0)).toHaveLength(2);
    expect(store.status("project-1")?.traversal_complete).toBe(true);
  } finally {
    db.close();
  }
});

test("replaying unfinished directories deduplicates entries and preserves acknowledged candidates", () => {
  let work = root();
  const observations = [
    { name: "one.chat", kind: "file" as const },
    { name: "nested", kind: "directory" as const },
  ];
  store.record(work, observations, false);
  store.acknowledge(store.candidates(0)[0]);
  restart();
  work = { ...work, run: store.status("project-1")!.run };
  store.record(
    work,
    [...observations, { name: "two.sage-chat", kind: "file" }],
    true,
  );
  expect(store.status("project-1")).toMatchObject({
    directories: 2,
    entries: 3,
    candidates: 2,
    pending_candidates: 1,
  });
  expect(store.candidates(0).map((x) => x.chat_path)).toEqual([
    "/home/user/two.sage-chat",
  ]);
});

test("directory and candidate errors retry durably, without storing error text", () => {
  const work = root();
  store.fail(
    work,
    Object.assign(Error("private filename and contents"), { code: "EACCES" }),
    0,
  );
  const db = new DatabaseSync(join(directory, "census.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      db
        .prepare("SELECT error FROM census_directories WHERE project_id=?")
        .get("project-1")?.error,
    ).toBe("EACCES");
  } finally {
    db.close();
  }
  restart();
  expect(store.next(999)).toBeUndefined();
  expect(store.status("project-1")).toMatchObject({
    coverage: "partial",
    errors: 1,
  });
  expect(store.next(1000)?.path).toBe(request.root);
  store.record(work, [{ name: "a.chat", kind: "file" }], true);
  const candidate = store.candidates(1000)[0];
  store.deferCandidate(candidate, Error("owner unavailable"), 1000);
  restart();
  expect(store.candidates(1999)).toEqual([]);
  expect(store.candidates(2000)).toEqual([candidate]);
  expect(store.status("project-1")?.errors).toBe(1);
  store.acknowledge(candidate);
  expect(store.status("project-1")).toMatchObject({
    coverage: "complete",
    errors: 0,
  });
});

test("stale workers and ACKs cannot change a replacement run", () => {
  const work = root();
  store.record(work, [{ name: "old.chat", kind: "file" }], false);
  const candidate = store.candidates(0)[0];
  root({ ...request, project_id: "another-project" });
  store.begin(
    { ...request, run_id: "run-2", volume_id: "restored-volume" },
    request.run_id,
  );
  expect(store.record(work, [{ name: "late.chat", kind: "file" }], true)).toBe(
    false,
  );
  store.fail(work, Error("late failure"), 0);
  expect(store.acknowledge(candidate)).toBe(false);
  expect(store.deferCandidate(candidate, Error("late"), 0)).toBe(false);
  expect(store.status("project-1")).toMatchObject({
    entries: 0,
    errors: 0,
    coverage: "indexing",
  });
});

test.each([
  ["entries", { entries: 1 }, "entry_limit"],
  ["candidates", { candidates: 1 }, "candidate_limit"],
  ["directory entries", { entriesPerDirectory: 1 }, "directory_entry_limit"],
])(
  "%s quotas roll back the entire over-capacity batch and remain partial",
  (_label, limits, reason) => {
    const work = root({ ...request, limits });
    store.record(work, [{ name: "one.chat", kind: "file" }], false);
    let error: unknown;
    try {
      store.record(work, [{ name: "two.chat", kind: "file" }], true);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CensusQuotaError);
    expect((error as CensusQuotaError).reason).toBe(reason);
    store.fail(work, error, 0);
    restart();
    expect(store.status("project-1")).toMatchObject({
      coverage: "partial",
      entries: 1,
      candidates: 1,
      blocked_directories: 1,
      traversal_complete: false,
    });
    expect(store.next(1_000_000)).toBeUndefined();
  },
);

test("depth and explicit scope exclusions do not claim complete coverage", () => {
  const work = root({
    ...request,
    limits: { depth: 1 },
    excluded_paths: ["/home/user/private"],
  });
  store.record(
    work,
    [
      { name: "nested", kind: "directory" },
      { name: "private", kind: "directory" },
      { name: "link.chat", kind: "symlink" },
    ],
    true,
  );
  const nested = store.next(0)!;
  store.record(nested, [{ name: "too-deep", kind: "directory" }], true);
  expect(store.next(0)).toBeUndefined();
  expect(store.status("project-1")).toMatchObject({
    coverage: "partial",
    excluded_entries: 1,
    skipped_symlinks: 1,
    blocked_directories: 1,
    directories: 3,
  });
});

test("project, directory and metadata-byte capacities are enforced", () => {
  store.close();
  store = new CollaborationCensusStore(join(directory, "bounded.sqlite"), {
    projects: 1,
    bytes: 2 * 1024 * 1024,
  });
  const work = root({ ...request, limits: { directories: 1 } });
  const bytes = store.usage().bytes + 1024;
  store.close();
  store = new CollaborationCensusStore(join(directory, "bounded.sqlite"), {
    projects: 1,
    bytes,
  });
  expect(() => root({ ...request, project_id: "second" })).toThrow(
    /project_limit/,
  );
  expect(() =>
    store.record(work, [{ name: "child", kind: "directory" }], true),
  ).toThrow(/directory_limit/);
  expect(() =>
    store.record(
      work,
      Array.from({ length: 20 }, (_, i) => ({
        name: `${i}-${"a".repeat(200)}.chat`,
        kind: "file" as const,
      })),
      true,
    ),
  ).toThrow(/byte_limit/);
  expect(store.status("project-1")).toMatchObject({
    entries: 0,
    directories: 1,
    candidates: 0,
  });
});

test("completed frontiers compact without changing summaries, run fences or report retries", () => {
  const work = root({ ...request, excluded_paths: ["/home/user/private"] });
  store.record(
    work,
    [
      { name: "one.chat", kind: "file" },
      { name: "private", kind: "directory" },
      { name: "link", kind: "symlink" },
    ],
    true,
  );
  store.setReportCheckpoint(
    request.project_id,
    '{"acknowledged":false,"retry":"immutable"}',
  );
  expect(store.compactCompleted()).toBe(0);
  const candidate = store.candidates(0)[0];
  store.acknowledge(candidate);
  const status = store.status(request.project_id);
  const before = store.usage().bytes;
  expect(store.compactCompleted()).toBe(1);
  expect(store.usage().frontiers).toBe(0);
  expect(store.usage().bytes).toBeLessThan(before);
  expect(store.status(request.project_id)).toEqual(status);
  expect(store.status(request.project_id)?.coverage).toBe("partial");
  expect(store.isCurrent(work.run)).toBe(true);
  expect(store.canContinue(work)).toBe(false);
  expect(store.record(work, [{ name: "late.chat", kind: "file" }], true)).toBe(
    false,
  );
  restart();
  expect(store.status(request.project_id)).toEqual(status);
  expect(store.reportCheckpoint(request.project_id)).toBe(
    '{"acknowledged":false,"retry":"immutable"}',
  );
  expect(store.candidates(0)).toEqual([]);
  expect(store.compactCompleted()).toBe(0);
  store.begin(
    { ...request, run_id: "replacement", volume_id: "restored" },
    request.run_id,
  );
  expect(store.acknowledge(candidate)).toBe(false);
});

test("unfinished or failed frontiers and pending candidates never compact", () => {
  const unfinished = root();
  store.record(unfinished, [{ name: "known.chat", kind: "file" }], false);
  store.acknowledge(store.candidates(0)[0]);
  store.fail(unfinished, Object.assign(Error("denied"), { code: "EACCES" }), 0);
  const pending = root({ ...request, project_id: "pending" });
  store.record(pending, [{ name: "pending.chat", kind: "file" }], true);
  expect(store.compactCompleted()).toBe(0);
  restart();
  expect(store.status(request.project_id)).toMatchObject({
    errors: 1,
    entries: 1,
    coverage: "partial",
  });
  expect(store.status("pending")).toMatchObject({
    pending_candidates: 1,
    traversal_complete: true,
  });
  expect(store.usage().frontiers).toBe(2);
});

test("byte-pressure retry preserves unfinished progress; operator capacity increase unblocks it", () => {
  const work = root();
  store.record(work, [{ name: "known.chat", kind: "file" }], false);
  store.fail(work, new CensusQuotaError("byte_limit"), 0);
  const before = store.status(request.project_id)!;
  const bytes = store.usage().bytes;
  store.close();
  store = new CollaborationCensusStore(join(directory, "census.sqlite"), {
    projects: 4096,
    bytes,
  });
  store.retryCapacityBlocked(2000);
  expect(store.next(2000)).toBeUndefined();
  expect(store.status(request.project_id)).toEqual(before);
  restart();
  store.retryCapacityBlocked(2000);
  expect(store.next(2000)?.path).toBe(request.root);
  expect(store.status(request.project_id)).toMatchObject({
    entries: 1,
    candidates: 1,
    pending_candidates: 1,
  });
  expect(store.candidates(0)).toHaveLength(1);
});

test("upgrades legacy report checkpoints without losing an unacknowledged payload", () => {
  root();
  store.setCheckpoint(
    `report:${request.project_id}`,
    '{"acknowledged":false,"sequence":7}',
  );
  restart();
  expect(store.reportCheckpoint(request.project_id)).toBe(
    '{"acknowledged":false,"sequence":7}',
  );
  expect(store.checkpoint(`report:${request.project_id}`)).toBeUndefined();
  expect(store.usage().bytes).toBeLessThan(DEFAULT_CENSUS_CAPACITY.bytes);
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
  store.record(work, [{ name: "pending.chat", kind: "file" }], false);
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

test("candidate paging is bounded, deterministic and never interprets absence as deletion", () => {
  const work = root();
  store.record(
    work,
    Array.from({ length: 5 }, (_, i) => ({
      name: `${i}.chat`,
      kind: "file" as const,
    })),
    true,
  );
  expect(() => store.candidates(0, 101)).toThrow(/page limit/);
  const first = store.candidates(0, 2);
  expect(first.map((x) => x.chat_path)).toEqual([
    "/home/user/0.chat",
    "/home/user/1.chat",
  ]);
  for (const candidate of first) store.acknowledge(candidate);
  expect(store.candidates(0, 2).map((x) => x.chat_path)).toEqual([
    "/home/user/2.chat",
    "/home/user/3.chat",
  ]);
  expect(store.status("project-1")?.candidates).toBe(5);
});

test.each([
  { root: "relative" },
  { root: "/home/../home/user" },
  { excluded_paths: ["/outside"] },
  { excluded_paths: ["/home/user"] },
  { limits: { depth: 0 } },
  { limits: { entries: Infinity } },
])("rejects invalid scope %p before storing work", (change) => {
  expect(() => store.begin({ ...request, ...change })).toThrow();
  expect(store.status("project-1")).toBeUndefined();
});
