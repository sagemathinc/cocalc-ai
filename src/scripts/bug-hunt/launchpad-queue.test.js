const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildQueueJobs,
  executeLaunchpadQueue,
  jobSignature,
  parseArgs,
  summarizeQueue,
} = require("./launchpad-queue.js");

test("parseArgs accepts queue file and queue runner controls", () => {
  const options = parseArgs([
    "--queue-file",
    "/tmp/queue.json",
    "--queue-dir",
    "/tmp/runs",
    "--failure-policy",
    "continue",
    "--host-ready-seconds",
    "240",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.queueFile, "/tmp/queue.json");
  assert.equal(options.queueDir, "/tmp/runs");
  assert.equal(options.failurePolicy, "continue");
  assert.equal(options.hostReadySeconds, 240);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("parseArgs accepts copy-path workflow fields", () => {
  const options = parseArgs([
    "--workflow",
    "copy-path",
    "--src-host",
    "src-host",
    "--dest-host",
    "dest-host",
    "--timeout",
    "30m",
  ]);
  assert.equal(options.workflow, "copy-path");
  assert.equal(options.srcHost, "src-host");
  assert.equal(options.destHost, "dest-host");
  assert.equal(options.timeout, "30m");
});

test("buildQueueJobs deduplicates repeated canary jobs", () => {
  const jobs = buildQueueJobs({
    workflow: "canary",
    queueFile: "",
    providers: ["gcp", "gcp"],
    scenarios: ["persistence", "persistence", "move"],
    preset: "",
    accountId: "",
    apiUrl: "",
  });
  assert.equal(jobs.length, 2);
  assert.equal(
    jobSignature(jobs[0]),
    "gcp|persistence|(default)|(auto)|(auto)",
  );
});

test("buildQueueJobs supports copy-path workflow jobs", () => {
  const jobs = buildQueueJobs({
    workflow: "copy-path",
    queueFile: "",
    providers: [],
    scenarios: [],
    srcProject: "src-project",
    destProject: "dest-project",
    srcHost: "src-host",
    destHost: "dest-host",
    timeout: "20m",
    accountId: "",
    apiUrl: "",
  });
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0], {
    workflow: "copy-path",
    preset: "",
    accountId: "",
    apiUrl: "",
    timeout: "20m",
    srcProject: "src-project",
    destProject: "dest-project",
    srcHost: "src-host",
    destHost: "dest-host",
  });
});

test("executeLaunchpadQueue skips existing successful canary jobs on rerun", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-launchpad-queue-"));
  let calls = 0;
  const options = {
    workflow: "canary",
    queueFile: "",
    providers: ["gcp"],
    scenarios: ["persistence"],
    queueRoot: tmp,
    queueDir: path.join(tmp, "queue"),
    preset: "",
    accountId: "",
    apiUrl: "http://127.0.0.1:9102",
    failurePolicy: "stop",
    executionMode: "cli",
    cleanupOnSuccess: true,
    verifyBackup: true,
    verifyTerminal: true,
    verifyProxy: true,
    verifyProviderStatus: false,
    printDebugHints: true,
    skipApiCheck: false,
    skipLocalPostgresEnv: false,
    hostReadySeconds: undefined,
    hostStoppedSeconds: undefined,
    projectReadySeconds: undefined,
    backupReadySeconds: undefined,
    dryRun: false,
    json: true,
  };

  const deps = {
    async executeLaunchpadCanary(canaryOptions) {
      calls += 1;
      const runDir = path.join(
        canaryOptions.runRoot,
        `run-${String(calls).padStart(2, "0")}`,
      );
      return {
        run_dir: runDir,
        summary_file: path.join(runDir, "run-summary.json"),
        ledger_file: path.join(runDir, "run-ledger.json"),
        stopped_early: false,
        stop_reason: "",
        runs: [
          {
            provider: canaryOptions.providers[0],
            scenario: canaryOptions.scenarios[0],
            ok: true,
            status: "ok",
          },
        ],
      };
    },
  };

  const first = await executeLaunchpadQueue(
    options,
    Date.UTC(2026, 2, 18, 5, 0, 0),
    deps,
  );
  assert.equal(first.jobs[0].status, "ok");
  assert.equal(calls, 1);

  const second = await executeLaunchpadQueue(
    options,
    Date.UTC(2026, 2, 18, 5, 5, 0),
    deps,
  );
  assert.equal(second.jobs[0].status, "skipped");
  assert.equal(second.jobs[0].reason, "existing success");
  assert.equal(calls, 1);
});

test("executeLaunchpadQueue dispatches copy-path jobs to the dedicated workflow", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-launchpad-copy-"));
  let calls = 0;
  const payload = await executeLaunchpadQueue(
    {
      workflow: "copy-path",
      queueFile: "",
      providers: [],
      scenarios: [],
      queueRoot: tmp,
      queueDir: path.join(tmp, "queue"),
      srcProject: "src-project",
      destProject: "dest-project",
      srcHost: "src-host",
      destHost: "dest-host",
      timeout: "25m",
      preset: "",
      accountId: "",
      apiUrl: "",
      failurePolicy: "stop",
      executionMode: "cli",
      cleanupOnSuccess: true,
      verifyBackup: true,
      verifyTerminal: true,
      verifyProxy: true,
      verifyProviderStatus: false,
      printDebugHints: true,
      skipApiCheck: false,
      skipLocalPostgresEnv: false,
      hostReadySeconds: undefined,
      hostStoppedSeconds: undefined,
      projectReadySeconds: undefined,
      backupReadySeconds: undefined,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 18, 5, 10, 0),
    {
      async executeCopyPathWorkflow(options) {
        calls += 1;
        assert.equal(options.srcProject, "src-project");
        assert.equal(options.destProject, "dest-project");
        return {
          run_dir: path.join(tmp, "copy-run"),
          summary_file: path.join(tmp, "copy-summary.json"),
          ledger_file: path.join(tmp, "copy-ledger.json"),
          ok: true,
          steps: [{ name: "copy_path", status: "ok" }],
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(payload.jobs[0].workflow, "copy-path");
  assert.equal(payload.jobs[0].status, "ok");
  assert.equal(payload.jobs[0].run_dir, path.join(tmp, "copy-run"));
});

test("executeLaunchpadQueue dispatches backup-snapshot jobs to the dedicated workflow", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-launchpad-backup-"),
  );
  let calls = 0;
  const payload = await executeLaunchpadQueue(
    {
      workflow: "backup-snapshot",
      queueFile: "",
      providers: [],
      scenarios: [],
      queueRoot: tmp,
      queueDir: path.join(tmp, "queue"),
      project: "project-id",
      host: "host-a",
      timeout: "10m",
      preset: "",
      accountId: "",
      apiUrl: "",
      failurePolicy: "stop",
      executionMode: "cli",
      cleanupOnSuccess: true,
      verifyBackup: true,
      verifyTerminal: true,
      verifyProxy: true,
      verifyProviderStatus: false,
      printDebugHints: true,
      skipApiCheck: false,
      skipLocalPostgresEnv: false,
      hostReadySeconds: undefined,
      hostStoppedSeconds: undefined,
      projectReadySeconds: undefined,
      backupReadySeconds: undefined,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 18, 5, 15, 0),
    {
      async executeBackupSnapshotWorkflow(options) {
        calls += 1;
        assert.equal(options.project, "project-id");
        assert.equal(options.host, "host-a");
        return {
          run_dir: path.join(tmp, "backup-run"),
          summary_file: path.join(tmp, "backup-summary.json"),
          ledger_file: path.join(tmp, "backup-ledger.json"),
          ok: true,
          steps: [{ name: "create_backup", status: "ok" }],
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(payload.jobs[0].workflow, "backup-snapshot");
  assert.equal(payload.jobs[0].status, "ok");
  assert.equal(payload.jobs[0].run_dir, path.join(tmp, "backup-run"));
});

test("summarizeQueue reports queue counts", () => {
  const summary = summarizeQueue({
    queue_dir: "/tmp/queue",
    started_at: "2026-03-18T00:00:00.000Z",
    finished_at: "2026-03-18T00:10:00.000Z",
    failure_policy: "stop",
    dry_run: false,
    stopped_early: true,
    stop_reason: "gcp/persistence failed",
    jobs: [{ status: "ok" }, { status: "failed" }, { status: "skipped" }],
  });
  assert.equal(summary.ok_jobs, 1);
  assert.equal(summary.failed_jobs, 1);
  assert.equal(summary.skipped_jobs, 1);
  assert.equal(summary.stopped_early, true);
});
