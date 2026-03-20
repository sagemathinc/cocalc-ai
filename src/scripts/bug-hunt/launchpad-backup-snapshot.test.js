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
  assert.match(sentinel.livePath, /^\.bug-hunt-backup-/);
  assert.match(sentinel.restoredPath, /bug-hunt-backup-restored/);
  assert.equal(sentinel.restoredPath.startsWith("/"), false);
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

test("executeBackupSnapshotWorkflow passes rpcTimeout to live cli calls", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-backup-snapshot-rpc-timeout-"),
  );
  const now = Date.UTC(2026, 2, 20, 7, 20, 0);
  const sentinel = buildSentinel(now);
  const cliCalls = [];
  const payload = await executeBackupSnapshotWorkflow(
    {
      project: "",
      host: "host-a",
      apiUrl: "http://127.0.0.1:9102",
      accountId: "",
      timeout: "9m",
      runRoot: tmp,
      cleanupOnSuccess: false,
      dryRun: false,
      json: true,
    },
    now,
    {
      skipLocalPostgresEnv: true,
      runCliJson(base, args) {
        cliCalls.push({ base, args });
        const command = args.slice(0, 3).join(" ");
        if (args[0] === "project" && args[1] === "create") {
          return { project_id: "project-id" };
        }
        if (command === "project file put") {
          return {};
        }
        if (command === "project snapshot create") {
          return {};
        }
        if (command === "project snapshot list") {
          return [
            {
              name: sentinel.snapshotName,
            },
          ];
        }
        if (command === "project backup create") {
          return { op_id: "backup-op" };
        }
        if (command === "project backup list") {
          return [{ backup_id: "backup-id", time: "2026-03-20T07:20:10.000Z" }];
        }
        if (command === "project file rm") {
          return {};
        }
        if (command === "project backup restore") {
          return {};
        }
        if (command === "project file cat") {
          return { content: sentinel.payload };
        }
        throw new Error(`unexpected cli call: ${args.join(" ")}`);
      },
    },
  );
  assert.equal(payload.ok, true);
  assert.ok(cliCalls.length > 0);
  for (const call of cliCalls) {
    assert.equal(call.base.rpcTimeout, "9m");
  }
});
