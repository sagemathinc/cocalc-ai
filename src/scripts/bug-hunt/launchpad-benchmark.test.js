const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildWorkloadSpec,
  executeLaunchpadBenchmark,
  parseArgs,
} = require("./launchpad-benchmark.js");

test("parseArgs accepts move benchmark options", () => {
  const options = parseArgs([
    "--workflow",
    "move",
    "--workload",
    "random-4g",
    "--dest-host",
    "host-b",
    "--seed-timeout",
    "1234",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.workflow, "move");
  assert.equal(options.workload, "random-4g");
  assert.equal(options.destHost, "host-b");
  assert.equal(options.seedTimeoutSeconds, 1234);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("buildWorkloadSpec describes the random workload", () => {
  const spec = buildWorkloadSpec("random-4g", Date.UTC(2026, 2, 19, 1, 0, 0));
  assert.match(spec.prepareBash, /dd if=\/dev\/urandom/);
  assert.match(spec.payloadPath, /bug-hunt-random-4g/);
  assert.equal(spec.verifyPaths.length, 2);
});

test("buildWorkloadSpec describes the apt workload", () => {
  const spec = buildWorkloadSpec(
    "apt-jupyter",
    Date.UTC(2026, 2, 19, 1, 0, 0),
  );
  assert.match(spec.prepareBash, /apt-get install -y jupyter/);
  assert.equal(spec.payloadPath, undefined);
  assert.equal(spec.verifyPaths.length, 1);
});

test("executeLaunchpadBenchmark writes a dry-run summary", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-launchpad-benchmark-"),
  );
  const payload = await executeLaunchpadBenchmark(
    {
      workflow: "copy-path",
      workload: "apt-jupyter",
      project: "",
      host: "",
      srcProject: "",
      destProject: "",
      srcHost: "host-a",
      destHost: "host-b",
      apiUrl: "http://127.0.0.1:9102",
      accountId: "",
      timeout: "90m",
      seedTimeoutSeconds: 7200,
      runRoot: tmp,
      cleanupOnSuccess: true,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 19, 1, 10, 0),
    { skipLocalPostgresEnv: true },
  );
  assert.equal(payload.workflow, "copy-path");
  assert.equal(payload.workload, "apt-jupyter");
  assert.equal(payload.ok, true);
  assert.equal(payload.steps[0].status, "planned");
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-ledger.json")));
});
