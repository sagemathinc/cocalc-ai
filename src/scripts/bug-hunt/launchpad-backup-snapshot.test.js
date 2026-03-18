const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildSentinel,
  executeBackupSnapshotWorkflow,
  parseArgs,
} = require("./launchpad-backup-snapshot.js");

test("parseArgs accepts backup/snapshot workflow options", () => {
  const options = parseArgs([
    "--host",
    "host-a",
    "--timeout",
    "25m",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.host, "host-a");
  assert.equal(options.timeout, "25m");
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("buildSentinel creates snapshot and restore paths", () => {
  const sentinel = buildSentinel(Date.UTC(2026, 2, 18, 6, 20, 0));
  assert.match(sentinel.snapshotName, /bug-hunt-snapshot/);
  assert.match(sentinel.restoredPath, /bug-hunt-backup-restored/);
});

test("executeBackupSnapshotWorkflow writes a dry-run summary", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-backup-snapshot-workflow-"),
  );
  const payload = await executeBackupSnapshotWorkflow(
    {
      project: "",
      host: "host-a",
      apiUrl: "http://127.0.0.1:9102",
      accountId: "",
      timeout: "15m",
      runRoot: tmp,
      cleanupOnSuccess: true,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 18, 6, 30, 0),
    { skipLocalPostgresEnv: true },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.steps[0].status, "planned");
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-ledger.json")));
});
