const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildWorkloadSpec,
  ensureProjectRunning,
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

test("parseArgs accepts restore benchmark options", () => {
  const options = parseArgs([
    "--workflow",
    "restore",
    "--workload",
    "apt-jupyter",
    "--src-host",
    "host-a",
    "--dest-host",
    "host-b",
    "--cache-mode",
    "warm",
  ]);
  assert.equal(options.workflow, "restore");
  assert.equal(options.srcHost, "host-a");
  assert.equal(options.destHost, "host-b");
  assert.equal(options.cacheMode, "warm");
});

test("buildWorkloadSpec describes the random workload", () => {
  const spec = buildWorkloadSpec("random-4g", Date.UTC(2026, 2, 19, 1, 0, 0));
  assert.match(spec.prepareBash, /dd if=\/dev\/urandom/);
  assert.match(spec.payloadPath, /random-4g\.bin/);
  assert.equal(spec.restoreSourcePath, spec.payloadPath);
  assert.match(
    spec.restoreTargetPath,
    /^bug-hunt-restore-target-.*\/random-4g\.bin$/,
  );
  assert.equal(spec.restoreTargetShellPath, spec.restoreTargetPath);
  assert.deepEqual(spec.restoreVerifyPaths, [spec.restoreTargetPath]);
  assert.equal(spec.verifyPaths.length, 2);
});

test("buildWorkloadSpec describes the apt workload", () => {
  const spec = buildWorkloadSpec("apt-jupyter", Date.UTC(2026, 2, 19, 1, 0, 0));
  assert.match(spec.prepareBash, /apt-get install -y jupyter/);
  assert.equal(spec.payloadPath, undefined);
  assert.equal(spec.restoreSourcePath, ".local");
  assert.match(spec.restoreTargetPath, /^bug-hunt-restore-target-.*\/\.local$/);
  assert.deepEqual(spec.restoreVerifyPaths, [spec.restoreTargetPath]);
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

test("executeLaunchpadBenchmark writes a restore dry-run summary", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-launchpad-restore-benchmark-"),
  );
  const payload = await executeLaunchpadBenchmark(
    {
      workflow: "restore",
      workload: "random-4g",
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
      cacheMode: "cold",
      runRoot: tmp,
      cleanupOnSuccess: true,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 20, 1, 20, 0),
    { skipLocalPostgresEnv: true },
  );
  assert.equal(payload.workflow, "restore");
  assert.equal(payload.cache_mode, "cold");
  assert.equal(payload.ok, true);
  assert.equal(payload.steps[1].name, "create_backup");
  assert.equal(payload.steps[2].name, "run_restore");
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
});

test("ensureProjectRunning skips redundant starts", async () => {
  const calls = [];
  const runner = (_cliBase, args) => {
    calls.push(args);
    if (args[0] === "project" && args[1] === "get") {
      return { project_id: "p", state: "running" };
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  };
  const result = await ensureProjectRunning({}, "p", runner);
  assert.equal(result.already_running, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["project", "get", "--project", "p"]);
});
