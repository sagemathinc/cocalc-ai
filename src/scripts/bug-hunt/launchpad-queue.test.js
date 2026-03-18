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

test("buildQueueJobs deduplicates repeated jobs", () => {
  const jobs = buildQueueJobs({
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

test("executeLaunchpadQueue skips existing successful jobs on rerun", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-launchpad-queue-"));
  let calls = 0;
  const options = {
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
