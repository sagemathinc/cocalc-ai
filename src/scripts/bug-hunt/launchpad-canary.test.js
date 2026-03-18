const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildFailureCleanupPlan,
  buildRunMatrix,
  buildWaitProfile,
  cleanupFailedSmokeRun,
  executeLaunchpadCanary,
  parseArgs,
  resolveApiUrl,
  summarizeRun,
} = require("./launchpad-canary.js");

test("parseArgs accepts repeated providers, scenarios, and runner controls", () => {
  const options = parseArgs([
    "--provider",
    "gcp,nebius",
    "--provider",
    "lambda",
    "--scenario",
    "persistence,move",
    "--failure-policy",
    "continue",
    "--execution-mode",
    "direct",
    "--host-ready-seconds",
    "240",
    "--project-ready-seconds",
    "30",
    "--dry-run",
    "--json",
  ]);
  assert.deepEqual(options.providers, ["gcp", "nebius", "lambda"]);
  assert.deepEqual(options.scenarios, ["persistence", "move"]);
  assert.equal(options.failurePolicy, "continue");
  assert.equal(options.executionMode, "direct");
  assert.equal(options.hostReadySeconds, 240);
  assert.equal(options.projectReadySeconds, 30);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("buildWaitProfile uses provider defaults and converts them to attempts", () => {
  const profile = buildWaitProfile("hyperstack", {
    hostStoppedSeconds: undefined,
    projectReadySeconds: undefined,
    backupReadySeconds: undefined,
    hostReadySeconds: undefined,
  });
  assert.equal(profile.host_ready_seconds, 900);
  assert.equal(profile.wait.host_running.intervalMs, 5000);
  assert.equal(profile.wait.host_running.attempts, 180);
  assert.equal(profile.wait.project_ready.intervalMs, 3000);
  assert.equal(profile.wait.project_ready.attempts, 100);
});

test("resolveApiUrl prefers an explicit CLI value", () => {
  const original = process.env.COCALC_API_URL;
  process.env.COCALC_API_URL = "http://stale.example";
  try {
    assert.equal(
      resolveApiUrl({ apiUrl: "http://127.0.0.1:9102" }),
      "http://127.0.0.1:9102",
    );
  } finally {
    if (original === undefined) {
      delete process.env.COCALC_API_URL;
    } else {
      process.env.COCALC_API_URL = original;
    }
  }
});

test("buildRunMatrix expands providers and scenarios with the selected preset", () => {
  const runs = buildRunMatrix(
    {
      providers: ["gcp", "lambda"],
      scenarios: ["persistence", "move"],
      preset: "",
    },
    {
      gcp: [{ id: "gcp-cpu", label: "GCP CPU" }],
      lambda: [{ id: "lambda-cpu", label: "Lambda CPU" }],
    },
  );
  assert.equal(runs.length, 4);
  assert.equal(runs[0].preset, "gcp-cpu");
  assert.equal(runs[3].preset, "lambda-cpu");
});

test("buildRunMatrix records a plan error when a provider has no preset", () => {
  const runs = buildRunMatrix(
    {
      providers: ["gcp", "nebius"],
      scenarios: ["persistence"],
      preset: "",
    },
    {
      gcp: [{ id: "gcp-cpu", label: "GCP CPU" }],
      nebius: [],
    },
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[1].preset, "");
  assert.match(runs[1].plan_error, /no smoke presets available for nebius/);
});

test("executeLaunchpadCanary writes a dry-run summary and ledger", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-launchpad-canary-"),
  );
  const payload = await executeLaunchpadCanary(
    {
      providers: ["gcp", "nebius"],
      scenarios: ["persistence"],
      preset: "",
      accountId: "",
      apiUrl: "http://127.0.0.1:9102",
      runRoot: tmp,
      failurePolicy: "stop",
      executionMode: "cli",
      cleanupOnSuccess: true,
      verifyBackup: true,
      verifyTerminal: true,
      verifyProxy: true,
      verifyProviderStatus: false,
      printDebugHints: true,
      listPresets: false,
      skipApiCheck: false,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 17, 18, 30, 0),
    {
      smokeRunner: {
        async listProjectHostSmokePresets({ provider }) {
          return [{ id: `${provider}-cpu`, label: `${provider} cpu` }];
        },
      },
      async checkApiReachable() {},
    },
  );
  assert.equal(payload.runs.length, 2);
  assert.equal(payload.runs[0].status, "planned");
  assert.equal(payload.stopped_early, false);
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-ledger.json")));
});

test("buildFailureCleanupPlan deduplicates cleanup ids from failure payloads", () => {
  const plan = buildFailureCleanupPlan({
    project_id: "project-1",
    project_ids: ["project-1", "project-2"],
    host_id: "host-1",
    host_ids: ["host-1"],
    cleanup: {
      host_ids: ["host-2", "host-1"],
      workspaces: [
        { workspace_id: "project-2" },
        { workspace_id: "project-3" },
      ],
    },
  });
  assert.deepEqual(plan.projectIds, ["project-1", "project-2", "project-3"]);
  assert.deepEqual(plan.hostIds, ["host-1", "host-2"]);
});

test("cleanupFailedSmokeRun deletes projects before hosts", async () => {
  const calls = [];
  const cleanup = await cleanupFailedSmokeRun({
    smokeResult: {
      project_id: "project-1",
      host_ids: ["host-1", "host-2"],
    },
    apiUrl: "http://127.0.0.1:9102",
    accountId: "00000000-1000-4000-8000-000000000001",
    cliRunner: async (_ctx, args) => {
      calls.push(args);
      return { ok: true };
    },
  });
  assert.equal(cleanup.ok, true);
  assert.deepEqual(calls, [
    [
      "project",
      "delete",
      "--project",
      "project-1",
      "--hard",
      "--purge-backups-now",
      "--wait",
      "-y",
    ],
    ["host", "delete", "--skip-backups", "--wait", "host-1"],
    ["host", "delete", "--skip-backups", "--wait", "host-2"],
  ]);
});

test("executeLaunchpadCanary runs failure cleanup when a smoke run returns cleanup metadata", async () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-launchpad-canary-cleanup-"),
  );
  const cleanupCalls = [];
  const payload = await executeLaunchpadCanary(
    {
      providers: ["gcp"],
      scenarios: ["move"],
      preset: "",
      accountId: "00000000-1000-4000-8000-000000000001",
      apiUrl: "http://127.0.0.1:9102",
      runRoot: tmp,
      failurePolicy: "stop",
      executionMode: "cli",
      cleanupOnSuccess: true,
      verifyBackup: true,
      verifyTerminal: true,
      verifyProxy: true,
      verifyProviderStatus: false,
      printDebugHints: true,
      listPresets: false,
      skipApiCheck: false,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 18, 8, 30, 0),
    {
      smokeRunner: {
        async listProjectHostSmokePresets({ provider }) {
          return [{ id: `${provider}-cpu`, label: `${provider} cpu` }];
        },
        async runProjectHostPersistenceSmokePreset() {
          return {
            ok: false,
            project_id: "project-1",
            host_ids: ["host-1", "host-2"],
            cleanup: {
              host_ids: ["host-2"],
              workspaces: [{ workspace_id: "project-1" }],
            },
          };
        },
      },
      async checkApiReachable() {},
      async runCliJson(_ctx, args) {
        cleanupCalls.push(args);
        return { ok: true };
      },
    },
  );
  assert.equal(payload.runs[0].status, "failed");
  assert.equal(payload.runs[0].failure_cleanup.ok, true);
  assert.deepEqual(cleanupCalls, [
    [
      "project",
      "delete",
      "--project",
      "project-1",
      "--hard",
      "--purge-backups-now",
      "--wait",
      "-y",
    ],
    ["host", "delete", "--skip-backups", "--wait", "host-1"],
    ["host", "delete", "--skip-backups", "--wait", "host-2"],
  ]);
});

test("summarizeRun reports ok and failed counts", () => {
  const summary = summarizeRun({
    run_dir: "/tmp/run",
    started_at: "2026-03-17T00:00:00.000Z",
    finished_at: "2026-03-17T00:10:00.000Z",
    api_url: "http://127.0.0.1:9102",
    dry_run: false,
    failure_policy: "stop",
    stopped_early: true,
    stop_reason: "gcp/persistence failed",
    runs: [
      { provider: "gcp", scenario: "persistence", ok: false },
      { provider: "nebius", scenario: "persistence", ok: true },
    ],
  });
  assert.equal(summary.failed_runs, 1);
  assert.equal(summary.ok_runs, 1);
  assert.equal(summary.stopped_early, true);
});
