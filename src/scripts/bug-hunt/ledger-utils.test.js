const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildEntry,
  formatTaskNote,
  listLedgerEntries,
  nextIteration,
  writeLedgerEntry,
} = require("./ledger-utils.js");

test("buildEntry validates result and carries summarized context", () => {
  const entry = buildEntry(
    {
      taskId: "task-123",
      area: "chat",
      result: "bug_fixed",
      evidence: ["reproduced"],
      validation: ["jest test"],
      artifacts: ["/tmp/artifact"],
      commitSha: "abc123",
      confidence: "0.9",
      ledgerRoot: "/tmp/unused",
    },
    {
      mode: "lite",
      browser_mode: "live",
      browser_id: "browser-1",
      project_id: "project-1",
      api_url: "http://localhost:7002",
    },
    "2026-03-12T12:00:00.000Z",
  );
  assert.equal(entry.result, "bug_fixed");
  assert.equal(entry.context.browser_id, "browser-1");
  assert.equal(entry.confidence, 0.9);
});

test("writeLedgerEntry stores json and markdown and nextIteration advances", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-ledger-"));
  const entry1 = buildEntry(
    {
      taskId: "task-1",
      area: "tasks",
      result: "already_fixed",
      ledgerRoot: tmp,
    },
    undefined,
    "2026-03-12T01:02:03.000Z",
  );
  const paths1 = writeLedgerEntry(tmp, entry1);
  assert.ok(fs.existsSync(paths1.json));
  assert.ok(fs.existsSync(paths1.markdown));
  assert.equal(nextIteration(tmp), 2);

  const entry2 = buildEntry(
    {
      taskId: "task-2",
      area: "chat",
      result: "bug_fixed",
      ledgerRoot: tmp,
    },
    undefined,
    "2026-03-12T02:02:03.000Z",
  );
  writeLedgerEntry(tmp, entry2);
  const entries = listLedgerEntries(tmp);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].task_id, "task-2");
  assert.equal(entries[1].task_id, "task-1");
});

test("formatTaskNote includes commit and validation fields when present", () => {
  const note = formatTaskNote({
    date: "2026-03-12",
    result: "bug_fixed",
    area: "frontend/chat",
    evidence: ["confirmed in lite"],
    validation: ["pnpm exec jest chat.test.ts"],
    commit_sha: "deadbeef",
    confidence: 0.95,
  });
  assert.match(note, /bug-hunt: bug_fixed/);
  assert.match(note, /commit: deadbeef/);
  assert.match(note, /validation: pnpm exec jest chat.test.ts/);
});
