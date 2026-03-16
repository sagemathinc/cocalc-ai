#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { executeBatchPlan } = require("./run-batch.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_QUEUE_ROOT = path.join(ROOT, ".agents", "bug-hunt", "queues");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: run-queue.js (--plan <file>... | --plan-dir <path>) [--queue-root <path>] [--queue-policy <stop|continue>] [--failure-policy <stop|continue>] [--max-errors <n>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    plans: [],
    planDir: "",
    queueRoot: DEFAULT_QUEUE_ROOT,
    queuePolicy: "stop",
    failurePolicy: "stop",
    maxErrors: 1,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--plan") {
      options.plans.push(
        path.resolve(
          normalizedArgv[++i] || usageAndExit("--plan requires a path"),
        ),
      );
    } else if (arg === "--plan-dir") {
      options.planDir = path.resolve(
        normalizedArgv[++i] || usageAndExit("--plan-dir requires a path"),
      );
    } else if (arg === "--queue-root") {
      options.queueRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--queue-root requires a path"),
      );
    } else if (arg === "--queue-policy") {
      options.queuePolicy =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--queue-policy requires a value");
    } else if (arg === "--failure-policy") {
      options.failurePolicy =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--failure-policy requires a value");
    } else if (arg === "--max-errors") {
      options.maxErrors = Number(normalizedArgv[++i] || "");
      if (!Number.isInteger(options.maxErrors) || options.maxErrors <= 0) {
        usageAndExit("--max-errors must be a positive integer");
      }
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
  if (!options.plans.length && !options.planDir) {
    usageAndExit("at least one --plan or --plan-dir is required");
  }
  if (!["stop", "continue"].includes(options.queuePolicy)) {
    usageAndExit("--queue-policy must be stop or continue");
  }
  if (!["stop", "continue"].includes(options.failurePolicy)) {
    usageAndExit("--failure-policy must be stop or continue");
  }
  return options;
}

function sanitizeSegment(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createQueueDir(now = Date.now()) {
  return path.join(
    DEFAULT_QUEUE_ROOT,
    new Date(now).toISOString().replace(/[:.]/g, "-"),
  );
}

function listPlanFiles(options) {
  const plans = [...options.plans];
  if (options.planDir) {
    if (!fs.existsSync(options.planDir)) {
      throw new Error(`plan directory not found: ${options.planDir}`);
    }
    for (const entry of fs.readdirSync(options.planDir, {
      withFileTypes: true,
    })) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        plans.push(path.join(options.planDir, entry.name));
      }
    }
  }
  const uniquePlans = Array.from(
    new Set(plans.map((plan) => path.resolve(plan))),
  );
  for (const plan of uniquePlans) {
    if (!fs.existsSync(plan)) {
      throw new Error(`plan file not found: ${plan}`);
    }
  }
  return uniquePlans.sort((left, right) => left.localeCompare(right));
}

function createPlanRunRoot(queueDir, index, planFile) {
  const name = path.basename(planFile, path.extname(planFile));
  return path.join(
    queueDir,
    "runs",
    `${String(index + 1).padStart(2, "0")}-${sanitizeSegment(name)}`,
  );
}

function summarizeQueue(result) {
  return {
    started_at: result.started_at,
    finished_at: result.finished_at,
    queue_dir: result.queue_dir,
    queue_id: path.basename(result.queue_dir),
    dry_run: result.dry_run,
    queue_policy: result.queue_policy,
    batch_failure_policy: result.batch_failure_policy,
    max_errors: result.max_errors,
    total_plan_failures: result.total_plan_failures,
    total_iteration_failures: result.total_iteration_failures,
    stopped_early: result.stopped_early,
    stop_reason: result.stop_reason,
    total_plans: result.plans.length,
    completed_plans: result.plans.filter((plan) => plan.completed).length,
    plan_files: result.plans.map((plan) => plan.plan_file),
  };
}

function shouldStopQueue(result, options, planEntry) {
  if (!planEntry.ok) {
    result.total_plan_failures += 1;
  }
  result.total_iteration_failures += planEntry.failure_count || 0;
  if (options.queuePolicy === "stop" && !planEntry.ok) {
    result.stopped_early = true;
    result.stop_reason = `queue stopped after ${planEntry.plan_file}`;
    return true;
  }
  return false;
}

function executeQueue(options, now = Date.now(), deps = {}) {
  const runBatch = deps.executeBatchPlan || executeBatchPlan;
  const planFiles = listPlanFiles(options);
  const queueDir =
    options.queueRoot === DEFAULT_QUEUE_ROOT
      ? createQueueDir(now)
      : path.resolve(options.queueRoot);
  fs.mkdirSync(queueDir, { recursive: true });
  const result = {
    started_at: new Date(now).toISOString(),
    queue_dir: queueDir,
    dry_run: options.dryRun,
    queue_policy: options.queuePolicy,
    batch_failure_policy: options.failurePolicy,
    max_errors: options.maxErrors,
    total_plan_failures: 0,
    total_iteration_failures: 0,
    stopped_early: false,
    stop_reason: "",
    plans: [],
  };

  for (const [index, planFile] of planFiles.entries()) {
    const planEntry = {
      plan_file: planFile,
      completed: false,
      ok: false,
      failure_count: 0,
      stopped_early: false,
      stop_reason: "",
      run_dir: "",
    };
    try {
      const payload = runBatch(
        {
          plan: planFile,
          batchId: "",
          maxTasks: 0,
          runRoot: createPlanRunRoot(queueDir, index, planFile),
          failurePolicy: options.failurePolicy,
          maxErrors: options.maxErrors,
          dryRun: options.dryRun,
          json: true,
        },
        now,
      );
      planEntry.run_dir = payload.run_dir;
      planEntry.failure_count = payload.failure_count || 0;
      planEntry.stopped_early = !!payload.stopped_early;
      planEntry.stop_reason = payload.stop_reason || "";
      planEntry.ok = !payload.stopped_early;
      planEntry.completed = !payload.stopped_early;
    } catch (err) {
      planEntry.error = err instanceof Error ? err.message : `${err}`;
    }
    result.plans.push(planEntry);
    if (shouldStopQueue(result, options, planEntry)) {
      break;
    }
  }

  result.finished_at = new Date().toISOString();
  result.queue_ledger = path.join(queueDir, "queue-ledger.json");
  writeJson(path.join(queueDir, "queue-summary.json"), result);
  writeJson(result.queue_ledger, summarizeQueue(result));
  return result;
}

function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = executeQueue(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`bug-hunt run-queue: ${payload.queue_dir}`);
  console.log(`queue policy:       ${payload.queue_policy}`);
  console.log(`plan failures:      ${payload.total_plan_failures}`);
  console.log(`iteration failures: ${payload.total_iteration_failures}`);
  for (const plan of payload.plans) {
    console.log(
      `- ${path.basename(plan.plan_file)} ${plan.ok ? "ok" : "stopped"}${plan.run_dir ? ` ${plan.run_dir}` : ""}`,
    );
  }
  if (payload.stopped_early) {
    console.log(`stopped early:      ${payload.stop_reason}`);
  }
  return payload;
}

module.exports = {
  createPlanRunRoot,
  createQueueDir,
  executeQueue,
  listPlanFiles,
  main,
  parseArgs,
  sanitizeSegment,
  summarizeQueue,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt run-queue error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
