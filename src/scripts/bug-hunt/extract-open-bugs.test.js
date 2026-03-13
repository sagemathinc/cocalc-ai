const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTags,
  filterCandidates,
  inferStatusHint,
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
