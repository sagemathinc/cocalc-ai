const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildSentinel,
  executeCopyPathWorkflow,
  parseArgs,
} = require("./launchpad-copy-path.js");

test("parseArgs accepts copy-path workflow options", () => {
  const options = parseArgs([
    "--src-host",
    "host-a",
    "--dest-host",
    "host-b",
    "--timeout",
    "20m",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.srcHost, "host-a");
  assert.equal(options.destHost, "host-b");
  assert.equal(options.timeout, "20m");
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("buildSentinel creates distinct copy paths", () => {
  const sentinel = buildSentinel(Date.UTC(2026, 2, 18, 6, 0, 0));
  assert.match(sentinel.srcPath, /bug-hunt-copy-path/);
  assert.match(sentinel.destPath, /bug-hunt-copy-path-dest/);
  assert.notEqual(sentinel.srcPath, sentinel.destPath);
});

test("executeCopyPathWorkflow writes a dry-run summary", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-copy-path-workflow-"),
  );
  const payload = await executeCopyPathWorkflow(
    {
      srcProject: "",
      destProject: "",
      srcHost: "host-a",
      destHost: "host-b",
      apiUrl: "http://127.0.0.1:9102",
      accountId: "",
      timeout: "15m",
      runRoot: tmp,
      cleanupOnSuccess: true,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 18, 6, 10, 0),
    { skipLocalPostgresEnv: true },
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.steps[0].status, "planned");
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-ledger.json")));
});
