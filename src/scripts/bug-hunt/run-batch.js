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
    "Usage: run-batch.js --plan <file> [--batch-id <id>] [--max-tasks <n>] [--run-root <path>] [--failure-policy <stop|continue>] [--max-errors <n>] [--dry-run] [--json]",
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
    failurePolicy: "stop",
    maxErrors: 1,
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
  if (!options.plan) usageAndExit("--plan is required");
  if (!["stop", "continue"].includes(options.failurePolicy)) {
    usageAndExit("--failure-policy must be stop or continue");
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

function createRunDir(now = Date.now()) {
  return path.join(
    DEFAULT_RUN_ROOT,
    new Date(now).toISOString().replace(/[:.]/g, "-"),
  );
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

function countFailures(batchResult) {
  let failures = 0;
  if (batchResult.attach && batchResult.attach.ok === false) {
    failures += 1;
  }
  failures += batchResult.iterations.filter(
    (iteration) => iteration.ok === false,
  ).length;
  return failures;
}

function shouldStopAfterFailure(result, options, reason) {
  if (options.failurePolicy === "stop") {
    result.stopped_early = true;
    result.stop_reason = reason;
    return true;
  }
  if (result.failure_count >= options.maxErrors) {
    result.stopped_early = true;
    result.stop_reason = `${reason} (max errors reached)`;
    return true;
  }
  return false;
}

function summarizeRun(result) {
  return {
    started_at: result.started_at,
    finished_at: result.finished_at,
    run_dir: result.run_dir,
    run_id: path.basename(result.run_dir),
    plan_file: result.plan_file,
    dry_run: result.dry_run,
    failure_policy: result.failure_policy,
    max_errors: result.max_errors,
    failure_count: result.failure_count,
    stopped_early: result.stopped_early,
    stop_reason: result.stop_reason,
    total_batches: result.batches.length,
    completed_batches: result.batches.filter((batch) => batch.completed).length,
    batch_ids: result.batches.map((batch) => batch.batch_id),
  };
}

function executeBatchPlan(options, now = Date.now(), deps = {}) {
  const runScript = deps.runNodeScript || runNodeScript;
  const normalizedOptions = {
    failurePolicy: "stop",
    maxErrors: 1,
    ...options,
  };
  const plan = readJson(normalizedOptions.plan, "batch plan");
  const selectedBatches = plan.batches.filter(
    (batch) =>
      !normalizedOptions.batchId ||
      batch.batch_id === normalizedOptions.batchId,
  );
  if (selectedBatches.length === 0) {
    throw new Error("no matching batches found");
  }
  const runDir =
    normalizedOptions.runRoot === DEFAULT_RUN_ROOT
      ? createRunDir(now)
      : path.resolve(normalizedOptions.runRoot);
  fs.mkdirSync(runDir, { recursive: true });
  const result = {
    started_at: new Date(now).toISOString(),
    run_dir: runDir,
    plan_file: path.resolve(normalizedOptions.plan),
    dry_run: normalizedOptions.dryRun,
    failure_policy: normalizedOptions.failurePolicy,
    max_errors: normalizedOptions.maxErrors,
    failure_count: 0,
    stopped_early: false,
    stop_reason: "",
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
      completed: false,
      failure_count: 0,
      stopped_early: false,
      stop_reason: "",
      iterations: [],
    };
    const contextFile = path.join(batchDir, "context.json");
    try {
      if (normalizedOptions.dryRun) {
        batchResult.attach = {
          ok: true,
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
        batchResult.attach = {
          ok: true,
          result: runScript(
            path.join(ROOT, "scripts", "bug-hunt", "attach.js"),
            [
              "--mode",
              batch.preferred_mode,
              "--context-file",
              contextFile,
              "--json",
            ],
          ),
        };
      }
    } catch (err) {
      batchResult.attach = {
        ok: false,
        error: err instanceof Error ? err.message : `${err}`,
      };
      result.failure_count += 1;
      batchResult.failure_count = countFailures(batchResult);
      if (
        shouldStopAfterFailure(
          result,
          options,
          `attach failed for ${batch.batch_id}`,
        )
      ) {
        batchResult.stopped_early = true;
        batchResult.stop_reason = result.stop_reason;
      }
      writeJson(path.join(batchDir, "batch-result.json"), batchResult);
      result.batches.push(batchResult);
      if (result.stopped_early) break;
      continue;
    }
    const tasks =
      normalizedOptions.maxTasks > 0
        ? batch.tasks.slice(0, normalizedOptions.maxTasks)
        : batch.tasks;
    for (const task of tasks) {
      const commandArgs = buildIterationCommand(
        batch,
        task,
        contextFile,
        batchDir,
        normalizedOptions.dryRun,
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
      if (normalizedOptions.dryRun) {
        iteration.ok = true;
      } else {
        try {
          iteration.result = runScript(
            path.join(ROOT, "scripts", "bug-hunt", "run-plan.js"),
            commandArgs,
          );
          iteration.ok = true;
        } catch (err) {
          iteration.ok = false;
          iteration.error = err instanceof Error ? err.message : `${err}`;
          result.failure_count += 1;
          batchResult.iterations.push(iteration);
          batchResult.failure_count = countFailures(batchResult);
          if (
            shouldStopAfterFailure(
              result,
              normalizedOptions,
              `iteration failed for ${task.task_id}`,
            )
          ) {
            batchResult.stopped_early = true;
            batchResult.stop_reason = result.stop_reason;
            break;
          }
          continue;
        }
      }
      batchResult.iterations.push(iteration);
    }
    batchResult.failure_count = countFailures(batchResult);
    batchResult.completed = !batchResult.stopped_early;
    writeJson(path.join(batchDir, "batch-result.json"), batchResult);
    result.batches.push(batchResult);
    if (result.stopped_early) break;
  }
  result.finished_at = new Date().toISOString();
  result.run_ledger = path.join(runDir, "run-ledger.json");
  writeJson(path.join(runDir, "run-summary.json"), result);
  writeJson(result.run_ledger, summarizeRun(result));
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
  console.log(`failure policy:     ${payload.failure_policy}`);
  console.log(`failures:           ${payload.failure_count}`);
  for (const batch of payload.batches) {
    console.log(
      `- ${batch.batch_id} ${batch.environment}/${batch.area} ${batch.iterations.length} iteration(s)`,
    );
  }
  if (payload.stopped_early) {
    console.log(`stopped early:      ${payload.stop_reason}`);
  }
  return payload;
}

module.exports = {
  buildIterationCommand,
  createRunDir,
  executeBatchPlan,
  main,
  parseArgs,
  summarizeRun,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt run-batch error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
