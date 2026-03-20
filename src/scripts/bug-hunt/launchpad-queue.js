#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  applyLocalPostgresEnv,
  runCliJson,
} = require("./launchpad-cli-helpers.js");
const { executeLaunchpadCanary } = require("./launchpad-canary.js");
const { executeCopyPathWorkflow } = require("./launchpad-copy-path.js");
const {
  executeBackupSnapshotWorkflow,
} = require("./launchpad-backup-snapshot.js");

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
const SUPPORTED_WORKFLOWS = new Set([
  "canary",
  "move",
  "copy-path",
  "backup-snapshot",
]);
const DEFAULT_WORKFLOW_TIMEOUT = "15m";
const PROVIDER_BASELINE_DISK_GB = 100;

function pickPreferredProviderRegion(provider, regions) {
  if (!Array.isArray(regions) || !regions.length) return undefined;
  if (provider === "nebius") {
    return (
      regions.find((entry) => `${entry?.name ?? ""}` === "us-central1")?.name ??
      regions[0]?.name
    );
  }
  return regions[0]?.name;
}

function chooseBaselineProviderHostSpec(provider, catalog) {
  if (provider !== "nebius") {
    return undefined;
  }
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const regions =
    entries.find(
      (entry) => entry?.kind === "regions" && entry?.scope === "global",
    )?.payload ?? [];
  const instanceTypes =
    entries.find(
      (entry) => entry?.kind === "instance_types" && entry?.scope === "global",
    )?.payload ?? [];
  const region = pickPreferredProviderRegion(provider, regions);
  const cpuTypes = instanceTypes.filter((entry) => (entry?.gpus ?? 0) === 0);
  const preferredCpuTypes = cpuTypes.filter(
    (entry) => `${entry?.platform ?? ""}` === "cpu-d3",
  );
  const sortedTypes = [
    ...(preferredCpuTypes.length ? preferredCpuTypes : cpuTypes),
  ].sort((left, right) => {
    const vcpuDiff =
      (left?.vcpus ?? Number.POSITIVE_INFINITY) -
      (right?.vcpus ?? Number.POSITIVE_INFINITY);
    if (vcpuDiff !== 0) return vcpuDiff;
    return (
      (left?.memory_gib ?? Number.POSITIVE_INFINITY) -
      (right?.memory_gib ?? Number.POSITIVE_INFINITY)
    );
  });
  const selectedType = sortedTypes[0];
  const type = selectedType?.name;
  if (!region || !type) {
    return undefined;
  }
  return {
    provider,
    region,
    size: type,
    machineType: type,
    diskGb: PROVIDER_BASELINE_DISK_GB,
    diskType: "ssd_io_m3",
    machineJson: `${selectedType?.platform ?? ""}`.trim()
      ? { metadata: { platform: selectedType.platform } }
      : undefined,
  };
}

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    "Usage: launchpad-queue.js [--queue-file <path> | --provider <id>...] [--workflow <canary|move|copy-path|backup-snapshot>] [--scenario <name>...] [--project <id>] [--host <host>] [--src-project <id>] [--dest-project <id>] [--src-host <host>] [--dest-host <host>] [--timeout <duration>] [--queue-dir <path> | --queue-root <path>] [--failure-policy <stop|continue>] [--dry-run] [--json]",
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
    workflow: "canary",
    queueFile: "",
    providers: [],
    scenarios: [],
    project: "",
    host: "",
    srcProject: "",
    destProject: "",
    srcHost: "",
    destHost: "",
    timeout: DEFAULT_WORKFLOW_TIMEOUT,
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
    } else if (arg === "--workflow") {
      options.workflow =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--workflow requires a value");
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
    } else if (arg === "--project") {
      options.project =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--project requires a value");
    } else if (arg === "--host") {
      options.host =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--host requires a value");
    } else if (arg === "--src-project") {
      options.srcProject =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--src-project requires a value");
    } else if (arg === "--dest-project") {
      options.destProject =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--dest-project requires a value");
    } else if (arg === "--src-host") {
      options.srcHost =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--src-host requires a value");
    } else if (arg === "--dest-host") {
      options.destHost =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--dest-host requires a value");
    } else if (arg === "--timeout") {
      options.timeout =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--timeout requires a value");
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

  options.workflow = `${options.workflow}`.trim().toLowerCase();
  options.providers = Array.from(
    new Set(options.providers.map((value) => `${value}`.trim().toLowerCase())),
  );
  options.scenarios = Array.from(
    new Set(options.scenarios.map((value) => `${value}`.trim().toLowerCase())),
  );
  if (!SUPPORTED_WORKFLOWS.has(options.workflow)) {
    usageAndExit(
      `--workflow must be one of ${Array.from(SUPPORTED_WORKFLOWS).join(", ")}`,
    );
  }
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

function normalizeWorkflow(value) {
  return `${value ?? "canary"}`.trim().toLowerCase() || "canary";
}

function normalizeJob(job, defaults = {}) {
  const workflow = normalizeWorkflow(job.workflow ?? defaults.workflow);
  if (!SUPPORTED_WORKFLOWS.has(workflow)) {
    throw new Error(
      `unsupported workflow '${workflow}' (expected: ${Array.from(SUPPORTED_WORKFLOWS).join(", ")})`,
    );
  }

  const base = {
    workflow,
    preset: `${job.preset ?? defaults.preset ?? ""}`.trim(),
    accountId:
      `${job.account_id ?? job.accountId ?? defaults.account_id ?? defaults.accountId ?? ""}`.trim(),
    apiUrl:
      `${job.api_url ?? job.apiUrl ?? defaults.api_url ?? defaults.apiUrl ?? ""}`.trim(),
  };

  if (workflow === "canary" || workflow === "move") {
    const provider = `${job.provider ?? defaults.provider ?? ""}`
      .trim()
      .toLowerCase();
    const scenario = (
      workflow === "move"
        ? "move"
        : `${job.scenario ?? defaults.scenario ?? "persistence"}`
    )
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
      ...base,
      provider,
      scenario,
    };
  }

  if (workflow === "copy-path") {
    return {
      ...base,
      provider: `${job.provider ?? defaults.provider ?? ""}`
        .trim()
        .toLowerCase(),
      timeout:
        `${job.timeout ?? defaults.timeout ?? DEFAULT_WORKFLOW_TIMEOUT}`.trim(),
      srcProject:
        `${job.src_project ?? job.srcProject ?? defaults.src_project ?? defaults.srcProject ?? ""}`.trim(),
      destProject:
        `${job.dest_project ?? job.destProject ?? defaults.dest_project ?? defaults.destProject ?? ""}`.trim(),
      srcHost:
        `${job.src_host ?? job.srcHost ?? defaults.src_host ?? defaults.srcHost ?? ""}`.trim(),
      destHost:
        `${job.dest_host ?? job.destHost ?? defaults.dest_host ?? defaults.destHost ?? ""}`.trim(),
    };
  }

  return {
    ...base,
    provider: `${job.provider ?? defaults.provider ?? ""}`.trim().toLowerCase(),
    timeout:
      `${job.timeout ?? defaults.timeout ?? DEFAULT_WORKFLOW_TIMEOUT}`.trim(),
    project: `${job.project ?? defaults.project ?? ""}`.trim(),
    host: `${job.host ?? defaults.host ?? ""}`.trim(),
  };
}

function jobSignature(job) {
  if (job.workflow === "copy-path") {
    return [
      "copy-path",
      job.srcProject || "(auto-src-project)",
      job.destProject || "(auto-dest-project)",
      job.srcHost || "(auto-src-host)",
      job.destHost || "(auto-dest-host)",
      job.timeout || DEFAULT_WORKFLOW_TIMEOUT,
      job.accountId || "(auto)",
      job.apiUrl || "(auto)",
    ].join("|");
  }
  if (job.workflow === "backup-snapshot") {
    return [
      "backup-snapshot",
      job.project || "(auto-project)",
      job.host || "(auto-host)",
      job.timeout || DEFAULT_WORKFLOW_TIMEOUT,
      job.accountId || "(auto)",
      job.apiUrl || "(auto)",
    ].join("|");
  }
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
  } else if (options.workflow === "copy-path") {
    const autoHost =
      `${options.providers[0] ?? ""}`.trim() || `${options.host ?? ""}`.trim();
    jobs.push(
      normalizeJob({
        workflow: "copy-path",
        provider: `${options.providers[0] ?? ""}`.trim().toLowerCase(),
        srcProject: options.srcProject,
        destProject: options.destProject,
        srcHost: `${options.srcHost ?? ""}`.trim() || autoHost,
        destHost: `${options.destHost ?? ""}`.trim() || autoHost,
        timeout: options.timeout,
        account_id: options.accountId,
        api_url: options.apiUrl,
      }),
    );
  } else if (options.workflow === "backup-snapshot") {
    const autoHost =
      `${options.host ?? ""}`.trim() || `${options.providers[0] ?? ""}`.trim();
    jobs.push(
      normalizeJob({
        workflow: "backup-snapshot",
        provider: `${options.providers[0] ?? ""}`.trim().toLowerCase(),
        project: options.project,
        host: autoHost,
        timeout: options.timeout,
        account_id: options.accountId,
        api_url: options.apiUrl,
      }),
    );
  } else {
    const providers = options.providers.length ? options.providers : ["gcp"];
    const scenarios =
      options.workflow === "move"
        ? ["move"]
        : options.scenarios.length
          ? options.scenarios
          : ["persistence"];
    for (const provider of providers) {
      for (const scenario of scenarios) {
        jobs.push(
          normalizeJob({
            workflow: options.workflow,
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

function describeJob(job) {
  if (job.workflow === "copy-path") {
    return "copy-path";
  }
  if (job.workflow === "backup-snapshot") {
    return "backup-snapshot";
  }
  return `${job.provider}/${job.scenario}`;
}

function createJobDir(queueDir, index, job) {
  const label =
    job.workflow === "copy-path"
      ? `${sanitizeSegment(job.workflow)}-${sanitizeSegment(job.srcProject || job.srcHost || "src")}-${sanitizeSegment(job.destProject || job.destHost || "dest")}`
      : job.workflow === "backup-snapshot"
        ? `${sanitizeSegment(job.workflow)}-${sanitizeSegment(job.project || job.host || "project")}`
        : `${sanitizeSegment(job.provider)}-${sanitizeSegment(job.scenario)}`;
  return path.join(
    queueDir,
    "jobs",
    `${String(index + 1).padStart(2, "0")}-${label}`,
  );
}

function populateJobEntry(entry, job) {
  entry.workflow = job.workflow;
  if (job.workflow === "copy-path") {
    entry.provider = job.provider;
    entry.src_project_id = job.srcProject;
    entry.dest_project_id = job.destProject;
    entry.src_host = job.srcHost;
    entry.dest_host = job.destHost;
    entry.timeout = job.timeout;
    return;
  }
  if (job.workflow === "backup-snapshot") {
    entry.provider = job.provider;
    entry.project_id = job.project;
    entry.host = job.host;
    entry.timeout = job.timeout;
    return;
  }
  entry.provider = job.provider;
  entry.scenario = job.scenario;
  entry.preset = job.preset;
}

async function ensureProviderWorkflowHost(
  provider,
  requestedHost,
  cliBase,
  cache,
  deps = {},
) {
  const runCli = deps.runCliJson || runCliJson;
  const desired = `${requestedHost ?? ""}`.trim() || provider;
  const cacheKey = `${provider}|${desired}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const host = runCli(cliBase, ["host", "get", desired]);
    const status = `${host.status ?? ""}`.trim().toLowerCase();
    const canReuse =
      status === "running" ||
      (desired !== provider &&
        status !== "deprovisioned" &&
        status !== "deleted");
    if (!canReuse) {
      throw new Error(
        `host '${desired}' exists but is not reusable (${status})`,
      );
    }
    const resolved = {
      hostId: `${host.host_id ?? ""}`.trim() || desired,
      hostName: `${host.name ?? ""}`.trim() || desired,
      created: false,
    };
    cache.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    if (!/not found/i.test(message) && !/not reusable/i.test(message)) {
      throw err;
    }
  }

  const catalog = runCli(cliBase, ["host", "catalog", "--provider", provider]);
  const spec = chooseBaselineProviderHostSpec(provider, catalog);
  if (!spec) {
    throw new Error(
      `no automatic baseline host spec is available for provider '${provider}'`,
    );
  }
  const createdName = `bug-hunt-${provider}-${Date.now()}`;
  const args = [
    "host",
    "create",
    createdName,
    "--provider",
    spec.provider,
    "--region",
    spec.region,
    "--size",
    spec.size,
    "--machine-type",
    spec.machineType,
    "--disk-gb",
    `${spec.diskGb}`,
    "--wait",
  ];
  if (`${spec.diskType ?? ""}`.trim()) {
    args.push("--disk-type", spec.diskType);
  }
  if (spec.machineJson) {
    args.push("--machine-json", JSON.stringify(spec.machineJson));
  }
  const created = runCli(cliBase, args);
  const resolved = {
    hostId: `${created.host_id ?? ""}`.trim() || createdName,
    hostName: `${created.name ?? ""}`.trim() || createdName,
    created: true,
  };
  cache.set(cacheKey, resolved);
  return resolved;
}

async function executeLaunchpadQueue(options, now = Date.now(), deps = {}) {
  const executeCanary = deps.executeLaunchpadCanary || executeLaunchpadCanary;
  const executeCopyPath =
    deps.executeCopyPathWorkflow || executeCopyPathWorkflow;
  const executeBackupSnapshot =
    deps.executeBackupSnapshotWorkflow || executeBackupSnapshotWorkflow;
  const runCli = deps.runCliJson || runCliJson;
  if (!options.skipLocalPostgresEnv) {
    applyLocalPostgresEnv();
  }
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
    const jobDir = createJobDir(queueDir, index, job);
    const skipped = shouldSkipCompletedJob(job, previousSummary);
    const entry = {
      signature,
      status: "",
      job_dir: jobDir,
    };
    populateJobEntry(entry, job);

    if (skipped) {
      entry.status = "skipped";
      entry.reason = "existing success";
      entry.previous_run_dir =
        skipped.run_dir ||
        skipped.workflow_run_dir ||
        skipped.canary_run_dir ||
        "";
      payload.jobs.push(entry);
      writeJson(path.join(jobDir, "job-result.json"), entry);
      continue;
    }

    const cliBase = {
      apiUrl: job.apiUrl,
      accountId: job.accountId,
      timeout: job.timeout,
      rpcTimeout: job.timeout,
    };
    const createdHosts = [];
    const hostCache = new Map();

    try {
      if (job.workflow === "copy-path") {
        let srcHost = job.srcHost;
        let destHost = job.destHost;
        if (job.provider) {
          const srcResolved = await ensureProviderWorkflowHost(
            job.provider,
            srcHost,
            cliBase,
            hostCache,
            { runCliJson: runCli },
          );
          srcHost = srcResolved.hostId;
          if (srcResolved.created) {
            createdHosts.push(srcResolved.hostId);
          }
          const destResolved = await ensureProviderWorkflowHost(
            job.provider,
            destHost,
            cliBase,
            hostCache,
            { runCliJson: runCli },
          );
          destHost = destResolved.hostId;
          if (destResolved.created) {
            createdHosts.push(destResolved.hostId);
          }
        }
        const workflowPayload = await executeCopyPath(
          {
            srcProject: job.srcProject,
            destProject: job.destProject,
            srcHost,
            destHost,
            apiUrl: job.apiUrl,
            accountId: job.accountId,
            timeout: job.timeout,
            runRoot: path.join(jobDir, "runs"),
            cleanupOnSuccess: options.cleanupOnSuccess,
            dryRun: options.dryRun,
            json: true,
          },
          now + index,
          {
            skipLocalPostgresEnv: options.skipLocalPostgresEnv,
          },
        );
        entry.run_dir = workflowPayload.run_dir;
        entry.workflow_run_dir = workflowPayload.run_dir;
        entry.summary_file = workflowPayload.summary_file;
        entry.ledger_file = workflowPayload.ledger_file;
        entry.status = workflowPayload.ok ? "ok" : "failed";
        entry.result = {
          ok: workflowPayload.ok,
          error: workflowPayload.error,
          step_count: Array.isArray(workflowPayload.steps)
            ? workflowPayload.steps.length
            : 0,
        };
      } else if (job.workflow === "backup-snapshot") {
        let host = job.host;
        if (job.provider) {
          const resolved = await ensureProviderWorkflowHost(
            job.provider,
            host,
            cliBase,
            hostCache,
            { runCliJson: runCli },
          );
          host = resolved.hostId;
          if (resolved.created) {
            createdHosts.push(resolved.hostId);
          }
        }
        const workflowPayload = await executeBackupSnapshot(
          {
            project: job.project,
            host,
            apiUrl: job.apiUrl,
            accountId: job.accountId,
            timeout: job.timeout,
            runRoot: path.join(jobDir, "runs"),
            cleanupOnSuccess: options.cleanupOnSuccess,
            dryRun: options.dryRun,
            json: true,
          },
          now + index,
          {
            skipLocalPostgresEnv: options.skipLocalPostgresEnv,
          },
        );
        entry.run_dir = workflowPayload.run_dir;
        entry.workflow_run_dir = workflowPayload.run_dir;
        entry.summary_file = workflowPayload.summary_file;
        entry.ledger_file = workflowPayload.ledger_file;
        entry.status = workflowPayload.ok ? "ok" : "failed";
        entry.result = {
          ok: workflowPayload.ok,
          error: workflowPayload.error,
          step_count: Array.isArray(workflowPayload.steps)
            ? workflowPayload.steps.length
            : 0,
        };
      } else {
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

        entry.run_dir = canaryPayload.run_dir;
        entry.canary_run_dir = canaryPayload.run_dir;
        entry.summary_file = canaryPayload.summary_file;
        entry.canary_summary_file = canaryPayload.summary_file;
        entry.ledger_file = canaryPayload.ledger_file;
        entry.canary_ledger_file = canaryPayload.ledger_file;
        entry.status = canaryPayload.runs.every((run) => run.ok)
          ? "ok"
          : "failed";
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
      }
    } finally {
      if (options.cleanupOnSuccess && entry.status === "ok") {
        for (const hostId of Array.from(new Set(createdHosts))) {
          try {
            runCli(cliBase, [
              "host",
              "delete",
              "--skip-backups",
              "--wait",
              hostId,
            ]);
          } catch {
            // Keep the primary workflow result authoritative; cleanup is best-effort.
          }
        }
      }
    }

    payload.jobs.push(entry);
    writeJson(path.join(jobDir, "job-result.json"), entry);

    if (entry.status === "failed" && options.failurePolicy === "stop") {
      payload.stopped_early = true;
      payload.stop_reason = `${describeJob(job)} failed`;
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
      `- ${describeJob(job)} ${job.status}${job.reason ? ` (${job.reason})` : ""}`,
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
  chooseBaselineProviderHostSpec,
  executeLaunchpadQueue,
  formatHumanResult,
  jobSignature,
  parseArgs,
  pickPreferredProviderRegion,
  summarizeQueue,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-queue error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
