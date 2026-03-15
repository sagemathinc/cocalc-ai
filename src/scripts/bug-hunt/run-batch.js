#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_RUN_ROOT = path.join(ROOT, ".agents", "bug-hunt", "runs");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: run-batch.js --plan <file> [--batch-id <id>] [--max-tasks <n>] [--run-root <path>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    plan: "",
    batchId: "",
    maxTasks: 0,
    runRoot: DEFAULT_RUN_ROOT,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--plan") {
      options.plan =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--plan requires a value");
    } else if (arg === "--batch-id") {
      options.batchId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--batch-id requires a value");
    } else if (arg === "--max-tasks") {
      options.maxTasks = Number(normalizedArgv[++i] || "");
      if (!Number.isInteger(options.maxTasks) || options.maxTasks < 0) {
        usageAndExit("--max-tasks must be a non-negative integer");
      }
    } else if (arg === "--run-root") {
      options.runRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--run-root requires a path"),
      );
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
  if (!options.plan) usageAndExit("--plan is required");
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

function createRunDir(now = Date.now()) {
  return path.join(
    DEFAULT_RUN_ROOT,
    new Date(now).toISOString().replace(/[:.]/g, "-"),
  );
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

function buildIterationCommand(batch, task, contextFile, batchDir, dryRun) {
  const runner = batch.default_runner || {
    kind: "run-plan",
    plan: "session-smoke",
    seed: "",
  };
  if (runner.kind !== "run-plan") {
    throw new Error(`unsupported runner kind: ${runner.kind}`);
  }
  const args = [
    "--plan",
    runner.plan,
    "--context-file",
    contextFile,
    "--artifact-root",
    path.join(batchDir, task.artifact_label, "artifacts"),
    "--name",
    task.task_id,
    "--json",
  ];
  if (runner.seed) {
    args.push("--seed", runner.seed);
  }
  if (dryRun) {
    args.push("--dry-run");
  }
  return args;
}

function executeBatchPlan(options, now = Date.now()) {
  const plan = readJson(options.plan, "batch plan");
  const selectedBatches = plan.batches.filter(
    (batch) => !options.batchId || batch.batch_id === options.batchId,
  );
  if (selectedBatches.length === 0) {
    throw new Error("no matching batches found");
  }
  const runDir =
    options.runRoot === DEFAULT_RUN_ROOT
      ? createRunDir(now)
      : path.resolve(options.runRoot);
  fs.mkdirSync(runDir, { recursive: true });
  const result = {
    run_dir: runDir,
    plan_file: path.resolve(options.plan),
    dry_run: options.dryRun,
    batches: [],
  };
  for (const batch of selectedBatches) {
    const batchDir = path.join(runDir, batch.batch_id);
    fs.mkdirSync(batchDir, { recursive: true });
    const batchResult = {
      batch_id: batch.batch_id,
      area: batch.area,
      environment: batch.environment,
      preferred_mode: batch.preferred_mode,
      default_runner: batch.default_runner || {
        kind: "run-plan",
        plan: "session-smoke",
        seed: "",
      },
      iterations: [],
    };
    const contextFile = path.join(batchDir, "context.json");
    if (options.dryRun) {
      batchResult.attach = {
        dry_run: true,
        command: [
          process.execPath,
          path.join(ROOT, "scripts", "bug-hunt", "attach.js"),
          "--mode",
          batch.preferred_mode,
          "--context-file",
          contextFile,
          "--json",
        ],
      };
    } else {
      batchResult.attach = runNodeScript(
        path.join(ROOT, "scripts", "bug-hunt", "attach.js"),
        [
          "--mode",
          batch.preferred_mode,
          "--context-file",
          contextFile,
          "--json",
        ],
      );
    }
    const tasks =
      options.maxTasks > 0
        ? batch.tasks.slice(0, options.maxTasks)
        : batch.tasks;
    for (const task of tasks) {
      const commandArgs = buildIterationCommand(
        batch,
        task,
        contextFile,
        batchDir,
        options.dryRun,
      );
      const iteration = {
        task_id: task.task_id,
        artifact_label: task.artifact_label,
        note_flags: Array.isArray(task.note_flags) ? task.note_flags : [],
        command: [
          process.execPath,
          path.join(ROOT, "scripts", "bug-hunt", "run-plan.js"),
          ...commandArgs,
        ],
      };
      if (!options.dryRun) {
        iteration.result = runNodeScript(
          path.join(ROOT, "scripts", "bug-hunt", "run-plan.js"),
          commandArgs,
        );
      }
      batchResult.iterations.push(iteration);
    }
    fs.writeFileSync(
      path.join(batchDir, "batch-result.json"),
      `${JSON.stringify(batchResult, null, 2)}\n`,
    );
    result.batches.push(batchResult);
  }
  fs.writeFileSync(
    path.join(runDir, "run-summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = executeBatchPlan(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`bug-hunt run-batch: ${payload.run_dir}`);
  for (const batch of payload.batches) {
    console.log(
      `- ${batch.batch_id} ${batch.environment}/${batch.area} ${batch.iterations.length} iteration(s)`,
    );
  }
  return payload;
}

module.exports = {
  buildIterationCommand,
  createRunDir,
  executeBatchPlan,
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt run-batch error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
