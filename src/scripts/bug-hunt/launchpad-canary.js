#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_RUN_ROOT = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "launchpad-runs",
);
const DEFAULT_HUB_DAEMON_ENV = path.join(ROOT, ".local", "hub-daemon.env");
const DEFAULT_LOCAL_POSTGRES_ENV = path.join(
  ROOT,
  "data",
  "app",
  "postgres",
  "local-postgres.env",
);
const SUPPORTED_PROVIDERS = new Set(["gcp", "lambda", "nebius", "hyperstack"]);
const SUPPORTED_SCENARIOS = new Set([
  "persistence",
  "drain",
  "move",
  "apps",
  "apps-static",
]);
const WAIT_INTERVAL_MS = {
  host_running: 5000,
  host_stopped: 5000,
  project_ready: 3000,
  backup_ready: 5000,
};
const DEFAULT_PROVIDER_BUDGETS = {
  gcp: { host_ready_seconds: 180 },
  lambda: { host_ready_seconds: 420 },
  nebius: { host_ready_seconds: 300 },
  hyperstack: { host_ready_seconds: 900 },
};
const DEFAULT_PROJECT_READY_SECONDS = 300;
const DEFAULT_HOST_STOPPED_SECONDS = 180;
const DEFAULT_BACKUP_READY_SECONDS = 900;
const DEFAULT_FAILURE_POLICY = "stop";
const DEFAULT_SCENARIOS = ["persistence"];

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: launchpad-canary.js [--provider <id>...] [--scenario <name>...] [--preset <id>] [--account-id <uuid>] [--api-url <url>] [--run-root <path>] [--failure-policy <stop|continue>] [--execution-mode <cli|direct>] [--host-ready-seconds <n>] [--project-ready-seconds <n>] [--backup-ready-seconds <n>] [--host-stopped-seconds <n>] [--list-presets] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parsePositiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    usageAndExit(`${flag} must be a positive integer`);
  }
  return value;
}

function pushCsvValues(target, raw) {
  for (const value of `${raw ?? ""}`.split(",")) {
    const trimmed = value.trim();
    if (trimmed) {
      target.push(trimmed);
    }
  }
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    providers: [],
    scenarios: [],
    preset: "",
    accountId: "",
    apiUrl: "",
    runRoot: DEFAULT_RUN_ROOT,
    failurePolicy: DEFAULT_FAILURE_POLICY,
    executionMode: "cli",
    cleanupOnSuccess: true,
    verifyBackup: true,
    verifyTerminal: true,
    verifyProxy: true,
    verifyProviderStatus: false,
    printDebugHints: true,
    listPresets: false,
    skipApiCheck: false,
    skipLocalPostgresEnv: false,
    dryRun: false,
    json: false,
    hostReadySeconds: undefined,
    hostStoppedSeconds: undefined,
    projectReadySeconds: undefined,
    backupReadySeconds: undefined,
  };

  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--provider") {
      pushCsvValues(
        options.providers,
        normalizedArgv[++i] || usageAndExit("--provider requires a value"),
      );
    } else if (arg === "--scenario") {
      pushCsvValues(
        options.scenarios,
        normalizedArgv[++i] || usageAndExit("--scenario requires a value"),
      );
    } else if (arg === "--preset") {
      options.preset =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--preset requires a value");
    } else if (arg === "--account-id") {
      options.accountId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--account-id requires a value");
    } else if (arg === "--api-url") {
      options.apiUrl =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--api-url requires a value");
    } else if (arg === "--run-root") {
      options.runRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--run-root requires a path"),
      );
    } else if (arg === "--failure-policy") {
      options.failurePolicy =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--failure-policy requires a value");
    } else if (arg === "--execution-mode") {
      options.executionMode =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--execution-mode requires a value");
    } else if (arg === "--host-ready-seconds") {
      options.hostReadySeconds = parsePositiveInteger(
        normalizedArgv[++i] || "",
        "--host-ready-seconds",
      );
    } else if (arg === "--host-stopped-seconds") {
      options.hostStoppedSeconds = parsePositiveInteger(
        normalizedArgv[++i] || "",
        "--host-stopped-seconds",
      );
    } else if (arg === "--project-ready-seconds") {
      options.projectReadySeconds = parsePositiveInteger(
        normalizedArgv[++i] || "",
        "--project-ready-seconds",
      );
    } else if (arg === "--backup-ready-seconds") {
      options.backupReadySeconds = parsePositiveInteger(
        normalizedArgv[++i] || "",
        "--backup-ready-seconds",
      );
    } else if (arg === "--cleanup-on-success") {
      options.cleanupOnSuccess = true;
    } else if (arg === "--no-cleanup-on-success") {
      options.cleanupOnSuccess = false;
    } else if (arg === "--verify-backup") {
      options.verifyBackup = true;
    } else if (arg === "--no-verify-backup") {
      options.verifyBackup = false;
    } else if (arg === "--verify-terminal") {
      options.verifyTerminal = true;
    } else if (arg === "--no-verify-terminal") {
      options.verifyTerminal = false;
    } else if (arg === "--verify-proxy") {
      options.verifyProxy = true;
    } else if (arg === "--no-verify-proxy") {
      options.verifyProxy = false;
    } else if (arg === "--verify-provider-status") {
      options.verifyProviderStatus = true;
    } else if (arg === "--no-verify-provider-status") {
      options.verifyProviderStatus = false;
    } else if (arg === "--print-debug-hints") {
      options.printDebugHints = true;
    } else if (arg === "--no-print-debug-hints") {
      options.printDebugHints = false;
    } else if (arg === "--list-presets") {
      options.listPresets = true;
    } else if (arg === "--skip-api-check") {
      options.skipApiCheck = true;
    } else if (arg === "--skip-local-postgres-env") {
      options.skipLocalPostgresEnv = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }

  if (!options.providers.length) {
    options.providers = ["gcp"];
  }
  if (!options.scenarios.length) {
    options.scenarios = [...DEFAULT_SCENARIOS];
  }
  options.providers = Array.from(
    new Set(options.providers.map((value) => `${value}`.trim().toLowerCase())),
  );
  options.scenarios = Array.from(
    new Set(options.scenarios.map((value) => `${value}`.trim().toLowerCase())),
  );

  for (const provider of options.providers) {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      usageAndExit(
        `unsupported provider '${provider}' (expected: ${Array.from(SUPPORTED_PROVIDERS).join(", ")})`,
      );
    }
  }
  for (const scenario of options.scenarios) {
    if (!SUPPORTED_SCENARIOS.has(scenario)) {
      usageAndExit(
        `unsupported scenario '${scenario}' (expected: ${Array.from(SUPPORTED_SCENARIOS).join(", ")})`,
      );
    }
  }
  if (!["stop", "continue"].includes(options.failurePolicy)) {
    usageAndExit("--failure-policy must be stop or continue");
  }
  if (!["cli", "direct"].includes(options.executionMode)) {
    usageAndExit("--execution-mode must be cli or direct");
  }
  return options;
}

function readShellEnvFile(file) {
  if (!file || !fs.existsSync(file)) {
    return {};
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function normalizeApiUrl(raw) {
  const value = `${raw ?? ""}`.trim();
  if (!value) {
    throw new Error("empty api url");
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `http://${value.replace(/\/+$/, "")}`;
}

function resolveApiUrl(options) {
  if (`${options.apiUrl ?? ""}`.trim()) {
    return normalizeApiUrl(options.apiUrl);
  }
  const daemonEnv = readShellEnvFile(DEFAULT_HUB_DAEMON_ENV);
  if (`${daemonEnv.HUB_PORT ?? ""}`.trim()) {
    return `http://127.0.0.1:${`${daemonEnv.HUB_PORT}`.trim()}`;
  }
  const ambient =
    process.env.COCALC_API_URL ||
    process.env.SMOKE_API_URL ||
    process.env.BASE_URL;
  if (ambient) {
    return normalizeApiUrl(ambient);
  }
  return "http://127.0.0.1:9100";
}

function applyLocalPostgresEnv(envFile = DEFAULT_LOCAL_POSTGRES_ENV) {
  const values = readShellEnvFile(envFile);
  for (const key of [
    "DATA",
    "COCALC_DATA_DIR",
    "SECRETS",
    "COCALC_SECRET_SETTINGS_KEY_PATH",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
  ]) {
    if (`${values[key] ?? ""}`.trim()) {
      process.env[key] = `${values[key]}`.trim();
    }
  }
  return values;
}

function toWaitOptions(seconds, intervalMs) {
  return {
    intervalMs,
    attempts: Math.max(1, Math.ceil((seconds * 1000) / intervalMs)),
  };
}

function buildWaitProfile(provider, options) {
  const providerBudget = DEFAULT_PROVIDER_BUDGETS[provider];
  if (!providerBudget) {
    throw new Error(`missing default budget for provider ${provider}`);
  }
  const hostReadySeconds =
    options.hostReadySeconds ?? providerBudget.host_ready_seconds;
  const hostStoppedSeconds =
    options.hostStoppedSeconds ?? DEFAULT_HOST_STOPPED_SECONDS;
  const projectReadySeconds =
    options.projectReadySeconds ?? DEFAULT_PROJECT_READY_SECONDS;
  const backupReadySeconds =
    options.backupReadySeconds ?? DEFAULT_BACKUP_READY_SECONDS;
  return {
    host_ready_seconds: hostReadySeconds,
    host_stopped_seconds: hostStoppedSeconds,
    project_ready_seconds: projectReadySeconds,
    backup_ready_seconds: backupReadySeconds,
    wait: {
      host_running: toWaitOptions(
        hostReadySeconds,
        WAIT_INTERVAL_MS.host_running,
      ),
      host_stopped: toWaitOptions(
        hostStoppedSeconds,
        WAIT_INTERVAL_MS.host_stopped,
      ),
      project_ready: toWaitOptions(
        projectReadySeconds,
        WAIT_INTERVAL_MS.project_ready,
      ),
      backup_ready: toWaitOptions(
        backupReadySeconds,
        WAIT_INTERVAL_MS.backup_ready,
      ),
    },
  };
}

function sanitizeSegment(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function createRunDir(now = Date.now(), runRoot = DEFAULT_RUN_ROOT) {
  return path.join(runRoot, new Date(now).toISOString().replace(/[:.]/g, "-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function summarizeRun(result) {
  return {
    run_dir: result.run_dir,
    started_at: result.started_at,
    finished_at: result.finished_at,
    api_url: result.api_url,
    dry_run: result.dry_run,
    failure_policy: result.failure_policy,
    total_runs: result.runs.length,
    ok_runs: result.runs.filter((run) => run.ok).length,
    failed_runs: result.runs.filter((run) => run.ok === false).length,
    stopped_early: result.stopped_early,
    stop_reason: result.stop_reason,
    providers: Array.from(new Set(result.runs.map((run) => run.provider))),
    scenarios: Array.from(new Set(result.runs.map((run) => run.scenario))),
  };
}

function resolveSmokeRunner() {
  const file = path.join(
    ROOT,
    "packages",
    "server",
    "dist",
    "cloud",
    "smoke-runner",
    "project-host.js",
  );
  if (!fs.existsSync(file)) {
    throw new Error(
      "server smoke-runner build output is missing; run 'cd src/packages/server && pnpm build'",
    );
  }
  return require(file);
}

function buildRunMatrix(options, presetsByProvider) {
  const runs = [];
  for (const provider of options.providers) {
    const presets = presetsByProvider[provider] ?? [];
    const preset = options.preset
      ? presets.find((entry) => entry.id === options.preset)
      : undefined;
    const planError = !presets.length
      ? `no smoke presets available for ${provider}`
      : options.preset && !preset
        ? `preset ${options.preset} not found for ${provider}; available: ${presets.map((entry) => entry.id).join(", ")}`
        : "";
    const selectedPreset = preset ?? presets[0];
    for (const scenario of options.scenarios) {
      runs.push({
        provider,
        scenario,
        preset: selectedPreset?.id ?? "",
        budget: buildWaitProfile(provider, options),
        plan_error: planError || undefined,
      });
    }
  }
  return runs;
}

function withSmokeEnv(apiUrl, fn) {
  const keys = ["COCALC_API_URL", "SMOKE_API_URL", "BASE_URL"];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  process.env.COCALC_API_URL = apiUrl;
  process.env.SMOKE_API_URL = apiUrl;
  process.env.BASE_URL = apiUrl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previous[key];
        }
      }
    });
}

async function checkApiReachable(apiUrl) {
  const target = new URL(apiUrl);
  const transport = target.protocol === "https:" ? https : http;
  await new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        timeout: 3000,
      },
      (res) => {
        res.resume();
        resolve();
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout reaching ${apiUrl}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function loadPresets(smokeRunner, providers) {
  const byProvider = {};
  for (const provider of providers) {
    byProvider[provider] = await smokeRunner.listProjectHostSmokePresets({
      provider,
    });
  }
  return byProvider;
}

async function executeLaunchpadCanary(options, now = Date.now(), deps = {}) {
  if (!options.skipLocalPostgresEnv) {
    applyLocalPostgresEnv();
  }
  const smokeRunner = deps.smokeRunner || resolveSmokeRunner();
  const apiUrl = resolveApiUrl(options);
  if (!options.skipApiCheck) {
    const apiCheck = deps.checkApiReachable || checkApiReachable;
    await apiCheck(apiUrl);
  }
  const presetsByProvider = await loadPresets(smokeRunner, options.providers);

  if (options.listPresets) {
    return {
      api_url: apiUrl,
      providers: options.providers.map((provider) => ({
        provider,
        presets: presetsByProvider[provider] ?? [],
      })),
    };
  }

  const runDir = createRunDir(now, options.runRoot);
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = new Date(now).toISOString();
  const matrix = buildRunMatrix(options, presetsByProvider);
  const result = {
    started_at: startedAt,
    finished_at: startedAt,
    api_url: apiUrl,
    run_dir: runDir,
    dry_run: options.dryRun,
    failure_policy: options.failurePolicy,
    execution_mode: options.executionMode,
    cleanup_on_success: options.cleanupOnSuccess,
    verify_backup: options.verifyBackup,
    verify_terminal: options.verifyTerminal,
    verify_proxy: options.verifyProxy,
    verify_provider_status: options.verifyProviderStatus,
    account_id: options.accountId || undefined,
    stopped_early: false,
    stop_reason: "",
    runs: [],
  };

  for (const [index, planned] of matrix.entries()) {
    const runTag = `${path.basename(runDir)}-${planned.provider}-${planned.scenario}`;
    const artifactFile = path.join(
      runDir,
      `${String(index + 1).padStart(2, "0")}-${sanitizeSegment(planned.provider)}-${sanitizeSegment(planned.scenario)}.json`,
    );
    const entry = {
      provider: planned.provider,
      scenario: planned.scenario,
      preset: planned.preset,
      run_tag: runTag,
      budget: planned.budget,
      ok: undefined,
      artifact_file: artifactFile,
      dry_run: options.dryRun,
    };

    if (planned.plan_error) {
      entry.ok = false;
      entry.status = "failed";
      entry.error = planned.plan_error;
      result.runs.push(entry);
      writeJson(artifactFile, entry);
      if (options.failurePolicy === "stop") {
        result.stopped_early = true;
        result.stop_reason = planned.plan_error;
        break;
      }
      continue;
    }

    if (options.dryRun) {
      entry.ok = true;
      entry.status = "planned";
      result.runs.push(entry);
      writeJson(artifactFile, entry);
      continue;
    }

    try {
      const smokeResult = await withSmokeEnv(apiUrl, () =>
        smokeRunner.runProjectHostPersistenceSmokePreset({
          account_id: options.accountId || undefined,
          provider: planned.provider,
          scenario: planned.scenario,
          preset: planned.preset,
          run_tag: runTag,
          cleanup_on_success: options.cleanupOnSuccess,
          verify_backup: options.verifyBackup,
          verify_terminal: options.verifyTerminal,
          verify_proxy: options.verifyProxy,
          verify_provider_status: options.verifyProviderStatus,
          execution_mode: options.executionMode,
          print_debug_hints: options.printDebugHints,
          wait: planned.budget.wait,
        }),
      );
      entry.ok = !!smokeResult.ok;
      entry.status = smokeResult.ok ? "ok" : "failed";
      entry.result = smokeResult;
    } catch (err) {
      entry.ok = false;
      entry.status = "failed";
      entry.error = err instanceof Error ? err.message : `${err}`;
    }

    result.runs.push(entry);
    writeJson(artifactFile, entry);
    if (entry.ok === false && options.failurePolicy === "stop") {
      result.stopped_early = true;
      result.stop_reason = `${planned.provider}/${planned.scenario} failed`;
      break;
    }
  }

  result.finished_at = new Date().toISOString();
  result.summary_file = path.join(runDir, "run-summary.json");
  result.ledger_file = path.join(runDir, "run-ledger.json");
  writeJson(result.summary_file, result);
  writeJson(result.ledger_file, summarizeRun(result));
  return result;
}

function formatHumanResult(payload) {
  if (payload.providers && !payload.run_dir) {
    const lines = [`launchpad canary presets: ${payload.api_url}`];
    for (const provider of payload.providers) {
      lines.push(`${provider.provider}:`);
      for (const preset of provider.presets) {
        lines.push(`- ${preset.id} ${preset.label}`);
      }
    }
    return lines.join("\n");
  }

  const lines = [
    `launchpad canary: ${payload.run_dir}`,
    `api url:           ${payload.api_url}`,
    `execution mode:    ${payload.execution_mode}`,
    `failure policy:    ${payload.failure_policy}`,
    `cleanup success:   ${payload.cleanup_on_success}`,
  ];
  for (const run of payload.runs) {
    lines.push(
      `- ${run.provider}/${run.scenario} preset=${run.preset} ${run.status || (run.ok ? "ok" : "failed")}`,
    );
  }
  if (payload.stopped_early) {
    lines.push(`stopped early:     ${payload.stop_reason}`);
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeLaunchpadCanary(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanResult(payload));
  return payload;
}

module.exports = {
  buildRunMatrix,
  buildWaitProfile,
  checkApiReachable,
  createRunDir,
  executeLaunchpadCanary,
  formatHumanResult,
  parseArgs,
  readShellEnvFile,
  resolveApiUrl,
  summarizeRun,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-canary error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
