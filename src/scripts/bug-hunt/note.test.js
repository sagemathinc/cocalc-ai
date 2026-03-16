const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { main, parseArgs } = require("./note.js");

test("parseArgs records repeated evidence and validation flags", () => {
  const options = parseArgs([
    "--task-id",
    "task-1",
    "--area",
    "chat",
    "--result",
    "bug_fixed",
    "--evidence",
    "one",
    "--evidence",
    "two",
    "--validation",
    "jest",
  ]);
  assert.deepEqual(options.evidence, ["one", "two"]);
  assert.deepEqual(options.validation, ["jest"]);
});

test("main writes a ledger entry and returns a task note", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-note-"));
  const contextFile = path.join(tmp, "context.json");
  fs.writeFileSync(
    contextFile,
    `${JSON.stringify({ mode: "lite", browser_mode: "live", project_id: "project-a" })}\n`,
  );
  const payload = main(
    [
      "--task-id",
      "task-abc",
      "--area",
      "jupyter",
      "--result",
      "already_fixed",
      "--ledger-root",
      tmp,
      "--context-file",
      contextFile,
      "--confidence",
      "0.8",
      "--evidence",
      "reviewed current test",
      "--validation",
      "pnpm exec jest",
      "--commit-sha",
      "abc123",
      "--json",
    ],
    "2026-03-12T10:00:00.000Z",
  );

  assert.equal(payload.iteration, 1);
  assert.equal(payload.context.mode, "lite");
  assert.match(payload.task_note, /reviewed current test/);
  assert.ok(fs.existsSync(payload.ledger_json));
  assert.ok(fs.existsSync(payload.ledger_markdown));
});
