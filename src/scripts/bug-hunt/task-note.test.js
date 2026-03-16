const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildEntry, writeLedgerEntry } = require("./ledger-utils.js");
const { main, parseArgs, resolveEntry } = require("./task-note.js");

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
