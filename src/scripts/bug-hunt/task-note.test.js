const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildEntry, writeLedgerEntry } = require("./ledger-utils.js");
const { main, parseArgs, resolveEntry, wantsJson } = require("./task-note.js");

test("parseArgs accepts task-note selectors", () => {
  const options = parseArgs([
    "--task-id",
    "task-1",
    "--ledger-root",
    "/tmp/ledger",
    "--json",
  ]);
  assert.equal(options.taskId, "task-1");
  assert.equal(options.ledgerRoot, "/tmp/ledger");
  assert.equal(options.json, true);
});

test("wantsJson ignores a leading pnpm separator", () => {
  assert.equal(wantsJson(["--", "--task-id", "task-1", "--json"]), true);
  assert.equal(wantsJson(["--task-id", "task-1"]), false);
});

test("resolveEntry falls back to the latest ledger entry", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-task-note-"),
  );
  writeLedgerEntry(
    tmp,
    buildEntry(
      {
        taskId: "task-1",
        area: "chat",
        result: "already_fixed",
        ledgerRoot: tmp,
      },
      undefined,
      "2026-03-13T01:00:00.000Z",
    ),
  );
  writeLedgerEntry(
    tmp,
    buildEntry(
      {
        taskId: "task-2",
        area: "jupyter",
        result: "bug_fixed",
        ledgerRoot: tmp,
      },
      undefined,
      "2026-03-13T02:00:00.000Z",
    ),
  );
  const entry = resolveEntry({ ledgerRoot: tmp });
  assert.equal(entry.task_id, "task-2");
});

test("main prints a task note from the selected ledger entry", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-task-note-"),
  );
  writeLedgerEntry(
    tmp,
    buildEntry(
      {
        taskId: "task-1",
        area: "frontend/chat",
        result: "bug_fixed",
        ledgerRoot: tmp,
        evidence: ["confirmed"],
      },
      undefined,
      "2026-03-13T03:00:00.000Z",
    ),
  );
  const payload = main(["--task-id", "task-1", "--ledger-root", tmp, "--json"]);
  assert.equal(payload.task_id, "task-1");
  assert.match(payload.task_note, /confirmed/);
});

test("cli keeps --json failures machine-readable", () => {
  const script = path.join(__dirname, "task-note.js");
  const result = cp.spawnSync(
    process.execPath,
    [script, "--task-id", "missing-task", "--json"],
    {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result.status, 1);
  assert.equal(`${result.stderr ?? ""}`.trim(), "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error.message, /no matching ledger entry found/);
});
