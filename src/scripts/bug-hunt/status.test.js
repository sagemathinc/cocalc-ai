const test = require("node:test");
const assert = require("node:assert/strict");

const { formatHumanStatus, summarizeLedger } = require("./status.js");

test("summarizeLedger groups results and limits recent entries", () => {
  const summary = summarizeLedger(
    [
      {
        iteration: 3,
        result: "bug_fixed",
        task_id: "a",
        area: "chat",
        timestamp: "2026-03-12T03:00:00.000Z",
        _file: "/tmp/a.json",
      },
      {
        iteration: 2,
        result: "already_fixed",
        task_id: "b",
        area: "chat",
        timestamp: "2026-03-12T02:00:00.000Z",
        _file: "/tmp/b.json",
      },
      {
        _file: "/tmp/bad.json",
        _parse_error: "bad json",
      },
    ],
    1,
  );
  assert.equal(summary.total_entries, 2);
  assert.equal(summary.parse_errors, 1);
  assert.deepEqual(summary.by_result, {
    already_fixed: 1,
    bug_fixed: 1,
  });
  assert.equal(summary.latest.length, 1);
  assert.equal(summary.latest[0].task_id, "a");
});

test("formatHumanStatus renders cleanly with context and recent entries", () => {
  const text = formatHumanStatus({
    preflight: {
      ok: true,
      repo: "/repo",
      tracked: [],
      untracked_blocking: [],
    },
    context: {
      mode: "lite",
      browser_mode: "live",
      browser_id: "browser-1",
      project_id: "project-1",
    },
    ledger: {
      total_entries: 2,
      parse_errors: 0,
      by_result: { bug_fixed: 1, already_fixed: 1 },
      latest: [
        {
          iteration: 2,
          result: "bug_fixed",
          task_id: "task-2",
          commit_sha: "abc123",
        },
      ],
    },
  });
  assert.match(text, /bug-hunt status: clean/);
  assert.match(text, /context:\s+lite \/ live \/ project-1/);
  assert.match(text, /#2 bug_fixed task-2 \(abc123\)/);
});
