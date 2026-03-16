#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { createQueueDir, executeQueue } = require("./run-queue.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_QUEUE_ROOT = path.join(ROOT, ".agents", "bug-hunt", "queues");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: queue-from-tasks.js [batch-plan/extract flags] [--queue-root <path>] [--queue-policy <stop|continue>] [--failure-policy <stop|continue>] [--max-errors <n>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    batchPlanArgs: [],
    queueRoot: DEFAULT_QUEUE_ROOT,
    queuePolicy: "stop",
    failurePolicy: "stop",
    maxErrors: 1,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--queue-root") {
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
      options.batchPlanArgs.push(arg);
      const next = normalizedArgv[i + 1];
      if (next && !next.startsWith("--")) {
        options.batchPlanArgs.push(next);
        i += 1;
      }
    }
  }
  if (!["stop", "continue"].includes(options.queuePolicy)) {
    usageAndExit("--queue-policy must be stop or continue");
  }
  if (!["stop", "continue"].includes(options.failurePolicy)) {
    usageAndExit("--failure-policy must be stop or continue");
  }
  return options;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runNodeScript(script, args) {
  const result = cp.spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(script)} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout || "null");
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(
      `failed to parse ${path.basename(script)} output: ${detail}`,
    );
  }
}

function executeQueueFromTasks(options, now = Date.now(), deps = {}) {
  const runScript = deps.runNodeScript || runNodeScript;
  const runQueue = deps.executeQueue || executeQueue;
  const queueDir =
    options.queueRoot === DEFAULT_QUEUE_ROOT
      ? createQueueDir(now)
      : path.resolve(options.queueRoot);
  fs.mkdirSync(queueDir, { recursive: true });
  const planFile = path.join(queueDir, "generated-batch-plan.json");
  const batchPlan = runScript(
    path.join(ROOT, "scripts", "bug-hunt", "batch-plan.js"),
    [...options.batchPlanArgs, "--out", planFile, "--json"],
  );
  const queue = runQueue(
    {
      plans: [planFile],
      planDir: "",
      queueRoot: queueDir,
      queuePolicy: options.queuePolicy,
      failurePolicy: options.failurePolicy,
      maxErrors: options.maxErrors,
      dryRun: options.dryRun,
      json: true,
    },
    now,
  );
  const payload = {
    started_at: new Date(now).toISOString(),
    finished_at: new Date().toISOString(),
    queue_dir: queueDir,
    generated_plan: planFile,
    batch_plan: {
      total_candidates: batchPlan.total_candidates,
      total_batches: batchPlan.total_batches,
      out_file: batchPlan.out_file,
    },
    queue,
  };
  writeJson(path.join(queueDir, "queue-from-tasks.json"), payload);
  return payload;
}

function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = executeQueueFromTasks(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`bug-hunt queue-from-tasks: ${payload.queue_dir}`);
  console.log(`generated plan:            ${payload.generated_plan}`);
  console.log(
    `batch candidates:          ${payload.batch_plan.total_candidates}`,
  );
  console.log(`batches:                   ${payload.batch_plan.total_batches}`);
  console.log(`queue stopped early:       ${payload.queue.stopped_early}`);
  return payload;
}

module.exports = {
  executeQueueFromTasks,
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt queue-from-tasks error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
