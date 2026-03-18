#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { executeLaunchpadCanary } = require("./launchpad-canary.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_QUEUE_ROOT = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "launchpad-queues",
);
const SUPPORTED_PROVIDERS = new Set(["gcp", "lambda", "nebius", "hyperstack"]);
const SUPPORTED_SCENARIOS = new Set([
  "persistence",
  "drain",
  "move",
  "apps",
  "apps-static",
]);

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: launchpad-queue.js [--queue-file <path> | --provider <id>...] [--scenario <name>...] [--queue-dir <path> | --queue-root <path>] [--failure-policy <stop|continue>] [--dry-run] [--json]",
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
    queueFile: "",
    providers: [],
    scenarios: [],
    queueRoot: DEFAULT_QUEUE_ROOT,
    queueDir: "",
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
    json: false,
  };

  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--queue-file") {
      options.queueFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--queue-file requires a path"),
      );
    } else if (arg === "--provider") {
      pushCsvValues(
        options.providers,
        normalizedArgv[++i] || usageAndExit("--provider requires a value"),
      );
    } else if (arg === "--scenario") {
      pushCsvValues(
        options.scenarios,
        normalizedArgv[++i] || usageAndExit("--scenario requires a value"),
      );
    } else if (arg === "--queue-root") {
      options.queueRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--queue-root requires a path"),
      );
    } else if (arg === "--queue-dir") {
      options.queueDir = path.resolve(
        normalizedArgv[++i] || usageAndExit("--queue-dir requires a path"),
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

  options.providers = Array.from(
    new Set(options.providers.map((value) => `${value}`.trim().toLowerCase())),
  );
  options.scenarios = Array.from(
    new Set(options.scenarios.map((value) => `${value}`.trim().toLowerCase())),
  );
  if (!["stop", "continue"].includes(options.failurePolicy)) {
    usageAndExit("--failure-policy must be stop or continue");
  }
  if (!["cli", "direct"].includes(options.executionMode)) {
    usageAndExit("--execution-mode must be cli or direct");
  }
  return options;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to read ${label}: ${detail}`);
  }
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  return readJson(file, file);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeSegment(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function createQueueDir(now = Date.now(), queueRoot = DEFAULT_QUEUE_ROOT) {
  return path.join(
    queueRoot,
    new Date(now).toISOString().replace(/[:.]/g, "-"),
  );
}

function normalizeJob(job, defaults = {}) {
  const provider = `${job.provider ?? defaults.provider ?? ""}`
    .trim()
    .toLowerCase();
  const scenario = `${job.scenario ?? defaults.scenario ?? "persistence"}`
    .trim()
    .toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `unsupported provider '${provider}' (expected: ${Array.from(SUPPORTED_PROVIDERS).join(", ")})`,
    );
  }
  if (!SUPPORTED_SCENARIOS.has(scenario)) {
    throw new Error(
      `unsupported scenario '${scenario}' (expected: ${Array.from(SUPPORTED_SCENARIOS).join(", ")})`,
    );
  }
  return {
    provider,
    scenario,
    preset: `${job.preset ?? defaults.preset ?? ""}`.trim(),
    accountId: `${job.account_id ?? defaults.account_id ?? ""}`.trim(),
    apiUrl: `${job.api_url ?? defaults.api_url ?? ""}`.trim(),
  };
}

function jobSignature(job) {
  return [
    job.provider,
    job.scenario,
    job.preset || "(default)",
    job.accountId || "(auto)",
    job.apiUrl || "(auto)",
  ].join("|");
}

function buildQueueJobs(options) {
  const jobs = [];
  if (options.queueFile) {
    const queue = readJson(options.queueFile, "queue file");
    const defaults = queue.defaults ?? {};
    for (const job of queue.jobs ?? []) {
      jobs.push(normalizeJob(job, defaults));
    }
  } else {
    const providers = options.providers.length ? options.providers : ["gcp"];
    const scenarios = options.scenarios.length
      ? options.scenarios
      : ["persistence"];
    for (const provider of providers) {
      for (const scenario of scenarios) {
        jobs.push(
          normalizeJob({
            provider,
            scenario,
            preset: options.preset,
            account_id: options.accountId,
            api_url: options.apiUrl,
          }),
        );
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const job of jobs) {
    const signature = jobSignature(job);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(job);
  }
  return deduped;
}

function summarizeQueue(payload) {
  return {
    queue_dir: payload.queue_dir,
    started_at: payload.started_at,
    finished_at: payload.finished_at,
    failure_policy: payload.failure_policy,
    dry_run: payload.dry_run,
    total_jobs: payload.jobs.length,
    ok_jobs: payload.jobs.filter((job) => job.status === "ok").length,
    failed_jobs: payload.jobs.filter((job) => job.status === "failed").length,
    skipped_jobs: payload.jobs.filter((job) => job.status === "skipped").length,
    stopped_early: payload.stopped_early,
    stop_reason: payload.stop_reason,
  };
}

function shouldSkipCompletedJob(job, previousSummary) {
  const existing = previousSummary?.jobs?.find(
    (entry) => entry.signature === jobSignature(job),
  );
  if (!existing) return undefined;
  if (existing.status === "ok") {
    return existing;
  }
  return undefined;
}

async function executeLaunchpadQueue(options, now = Date.now(), deps = {}) {
  const executeCanary = deps.executeLaunchpadCanary || executeLaunchpadCanary;
  const queueDir = options.queueDir || createQueueDir(now, options.queueRoot);
  fs.mkdirSync(queueDir, { recursive: true });
  const previousSummary = readJsonIfExists(
    path.join(queueDir, "queue-summary.json"),
  );
  const jobs = buildQueueJobs(options);
  const payload = {
    started_at: new Date(now).toISOString(),
    finished_at: new Date(now).toISOString(),
    queue_dir: queueDir,
    failure_policy: options.failurePolicy,
    dry_run: options.dryRun,
    jobs: [],
    stopped_early: false,
    stop_reason: "",
  };

  writeJson(path.join(queueDir, "queue-plan.json"), {
    generated_at: payload.started_at,
    jobs,
  });

  for (const [index, job] of jobs.entries()) {
    const signature = jobSignature(job);
    const jobDir = path.join(
      queueDir,
      "jobs",
      `${String(index + 1).padStart(2, "0")}-${sanitizeSegment(job.provider)}-${sanitizeSegment(job.scenario)}`,
    );
    const skipped = shouldSkipCompletedJob(job, previousSummary);
    const entry = {
      signature,
      provider: job.provider,
      scenario: job.scenario,
      preset: job.preset,
      status: "",
      job_dir: jobDir,
    };

    if (skipped) {
      entry.status = "skipped";
      entry.reason = "existing success";
      entry.previous_run_dir = skipped.canary_run_dir;
      payload.jobs.push(entry);
      writeJson(path.join(jobDir, "job-result.json"), entry);
      continue;
    }

    const canaryPayload = await executeCanary(
      {
        providers: [job.provider],
        scenarios: [job.scenario],
        preset: job.preset,
        accountId: job.accountId,
        apiUrl: job.apiUrl,
        runRoot: path.join(jobDir, "runs"),
        failurePolicy: "stop",
        executionMode: options.executionMode,
        cleanupOnSuccess: options.cleanupOnSuccess,
        verifyBackup: options.verifyBackup,
        verifyTerminal: options.verifyTerminal,
        verifyProxy: options.verifyProxy,
        verifyProviderStatus: options.verifyProviderStatus,
        printDebugHints: options.printDebugHints,
        skipApiCheck: options.skipApiCheck,
        skipLocalPostgresEnv: options.skipLocalPostgresEnv,
        hostReadySeconds: options.hostReadySeconds,
        hostStoppedSeconds: options.hostStoppedSeconds,
        projectReadySeconds: options.projectReadySeconds,
        backupReadySeconds: options.backupReadySeconds,
        dryRun: options.dryRun,
        json: true,
      },
      now + index,
    );

    entry.canary_run_dir = canaryPayload.run_dir;
    entry.canary_summary_file = canaryPayload.summary_file;
    entry.canary_ledger_file = canaryPayload.ledger_file;
    entry.status = canaryPayload.runs.every((run) => run.ok) ? "ok" : "failed";
    entry.result = {
      stopped_early: canaryPayload.stopped_early,
      stop_reason: canaryPayload.stop_reason,
      runs: canaryPayload.runs.map((run) => ({
        provider: run.provider,
        scenario: run.scenario,
        status: run.status,
        error: run.error,
      })),
    };
    payload.jobs.push(entry);
    writeJson(path.join(jobDir, "job-result.json"), entry);

    if (entry.status === "failed" && options.failurePolicy === "stop") {
      payload.stopped_early = true;
      payload.stop_reason = `${job.provider}/${job.scenario} failed`;
      break;
    }
  }

  payload.finished_at = new Date().toISOString();
  payload.summary_file = path.join(queueDir, "queue-summary.json");
  payload.ledger_file = path.join(queueDir, "queue-ledger.json");
  writeJson(payload.summary_file, payload);
  writeJson(payload.ledger_file, summarizeQueue(payload));
  return payload;
}

function formatHumanResult(payload) {
  const lines = [
    `launchpad queue: ${payload.queue_dir}`,
    `failure policy:  ${payload.failure_policy}`,
    `dry run:         ${payload.dry_run}`,
  ];
  for (const job of payload.jobs) {
    lines.push(
      `- ${job.provider}/${job.scenario} ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
    );
  }
  if (payload.stopped_early) {
    lines.push(`stopped early:    ${payload.stop_reason}`);
  }
  return lines.join("\n");
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeLaunchpadQueue(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanResult(payload));
  return payload;
}

module.exports = {
  buildQueueJobs,
  executeLaunchpadQueue,
  formatHumanResult,
  jobSignature,
  parseArgs,
  summarizeQueue,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-queue error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
