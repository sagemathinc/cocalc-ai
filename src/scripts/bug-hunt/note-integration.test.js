const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createDefaultNoteOptions,
  createLedgerNote,
  noteRequested,
  parseNoteArg,
} = require("./note-integration.js");

function usageAndThrow(message) {
  throw new Error(message || "usage");
}

test("parseNoteArg records note fields and advances the argv index", () => {
  const note = createDefaultNoteOptions();
  let index = parseNoteArg(["--task-id", "task-1"], 0, note, usageAndThrow);
  assert.equal(index, 1);
  index = parseNoteArg(["--evidence", "reproduced"], 0, note, usageAndThrow);
  assert.equal(index, 1);
  assert.equal(note.taskId, "task-1");
  assert.deepEqual(note.evidence, ["reproduced"]);
});

test("noteRequested stays false until note fields are provided", () => {
  const note = createDefaultNoteOptions();
  assert.equal(noteRequested(note), false);
  note.taskId = "task-1";
  assert.equal(noteRequested(note), true);
});

test("createLedgerNote merges auto evidence and writes ledger files", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-note-int-"),
  );
  const note = createDefaultNoteOptions();
  note.taskId = "task-1";
  note.area = "jupyter";
  note.result = "bug_fixed";
  note.ledgerRoot = tmp;
  note.evidence.push("manual");
  const payload = createLedgerNote(
    note,
    { mode: "lite", project_id: "project-a" },
    {
      title: "session-smoke",
      artifacts: ["/tmp/artifact"],
      evidence: ["auto"],
      validation: ["harness"],
    },
    "2026-03-13T01:02:03.000Z",
  );
  assert.equal(payload.title, "session-smoke");
  assert.deepEqual(payload.evidence, ["manual", "auto"]);
  assert.ok(fs.existsSync(payload.ledger_json));
  assert.ok(fs.existsSync(payload.ledger_markdown));
});
