const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  extractTags,
  filterCandidates,
  groupCandidatesByArea,
  inferSeverity,
  inferStatusHint,
  parseArgs,
  readTasksFile,
  resolveTasksFile,
} = require("./extract-open-bugs.js");

test("extractTags finds hashtags and lowercases them", () => {
  assert.deepEqual(extractTags("#Bug #Chat hi #TODAY"), [
    "bug",
    "chat",
    "today",
  ]);
});

test("inferStatusHint recognizes stale update notes", () => {
  assert.equal(
    inferStatusHint({
      desc: "task body\n\nUpdate 2026-03-10: could not reproduce this on current alpha2.",
    }),
    "stale",
  );
});

test("filterCandidates keeps fresh blockers ahead of stale reports", () => {
  const now = Date.UTC(2026, 2, 12);
  const candidates = filterCandidates(
    [
      {
        task_id: "stale",
        desc: "#bug old issue\n\nUpdate 2026-03-10: could not confirm this; may be stale.",
        last_edited: now - 2 * 24 * 60 * 60 * 1000,
      },
      {
        task_id: "fresh",
        desc: "#blocker #chat #today keyboard shortcut breaks send button",
        last_edited: now,
      },
      {
        task_id: "nonbug",
        desc: "#observed #chat informational note only",
        last_edited: now,
      },
    ],
    { now, freshOnly: true, limit: 10 },
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.task_id),
    ["fresh"],
  );
  assert.equal(candidates[0].area, "chat");
  assert.equal(candidates[0].status_hint, "fresh");
});

test("parseArgs accepts the pnpm standalone separator", () => {
  assert.deepEqual(parseArgs(["--", "--fresh", "--json"]), {
    tasksFile: "/home/wstein/cocalc.com/work/wstein.tasks",
    freshOnly: true,
    json: true,
    limit: 25,
    includeNonBugs: false,
    excludeStaleDays: 14,
    areas: [],
    environments: [],
    minSeverity: "",
    groupByArea: false,
    perArea: 0,
  });
});

test("inferSeverity distinguishes blocker, high, and medium bugs", () => {
  assert.equal(inferSeverity(["0"], "minor typo"), "blocker");
  assert.equal(inferSeverity(["1"], "minor typo"), "high");
  assert.equal(inferSeverity(["2"], "minor typo"), "medium");
  assert.equal(inferSeverity(["blocker"], "minor typo"), "blocker");
  assert.equal(inferSeverity([], "project cannot start after refresh"), "high");
  assert.equal(
    inferSeverity([], "unexpected duplicate toolbar item"),
    "medium",
  );
});

test("filterCandidates applies environment and severity filters", () => {
  const now = Date.UTC(2026, 2, 15);
  const candidates = filterCandidates(
    [
      {
        task_id: "hub-high",
        desc: "#bug #hub project cannot start after refresh",
        last_edited: now,
      },
      {
        task_id: "lite-low",
        desc: "#bug #lite cosmetic spacing mismatch",
        last_edited: now,
      },
    ],
    {
      now,
      environments: ["hub"],
      minSeverity: "high",
      limit: 10,
    },
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.task_id),
    ["hub-high"],
  );
});

test("groupCandidatesByArea builds a strict area plan after per-area filtering", () => {
  const now = Date.UTC(2026, 2, 15);
  const candidates = filterCandidates(
    [
      {
        task_id: "chat-1",
        desc: "#bug #chat #today send button breaks",
        last_edited: now,
      },
      {
        task_id: "chat-2",
        desc: "#bug #chat old secondary issue",
        last_edited: now - 1000,
      },
      {
        task_id: "jupyter-1",
        desc: "#bug #jupyter kernel warning",
        last_edited: now,
      },
    ],
    { now, perArea: 1, limit: 10 },
  );
  const groups = groupCandidatesByArea(candidates);
  assert.deepEqual(
    groups.map((group) => ({
      area: group.area,
      ids: group.candidates.map((candidate) => candidate.task_id),
    })),
    [
      { area: "chat", ids: ["chat-1"] },
      { area: "jupyter", ids: ["jupyter-1"] },
    ],
  );
});

test("readTasksFile returns an empty list for missing optional defaults", () => {
  const missing = path.join(
    os.tmpdir(),
    `cocalc-bug-hunt-missing-${process.pid}.tasks`,
  );
  assert.deepEqual(readTasksFile(missing, { allowMissing: true }), []);
});

test("resolveTasksFile falls back to the first existing candidate", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-resolve-tasks-"),
  );
  const fallback = path.join(tmp, "fallback.tasks");
  fs.writeFileSync(fallback, "");
  assert.equal(
    resolveTasksFile("/missing/default.tasks", {
      candidates: ["/missing/default.tasks", fallback],
    }),
    fallback,
  );
});

test("readTasksFile still throws for missing explicit task files", () => {
  const missing = path.join(
    os.tmpdir(),
    `cocalc-bug-hunt-missing-explicit-${process.pid}.tasks`,
  );
  assert.throws(() => readTasksFile(missing), /ENOENT/);
});

test("readTasksFile still parses newline-delimited json rows", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-extract-open-bugs-"),
  );
  const file = path.join(tmp, "tasks.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ task_id: "1", desc: "#bug hello" })}\n${JSON.stringify({ task_id: "2", desc: "#bug world" })}\n`,
  );
  assert.deepEqual(readTasksFile(file), [
    { task_id: "1", desc: "#bug hello" },
    { task_id: "2", desc: "#bug world" },
  ]);
});
