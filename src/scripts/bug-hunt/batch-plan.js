#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_TASKS_FILE,
  filterCandidates,
  parseArgs: parseExtractArgs,
  readTasksFile,
} = require("./extract-open-bugs.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BATCH_ROOT = path.join(ROOT, ".agents", "bug-hunt", "batches");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: batch-plan.js [extract-open-bugs flags] [--batch-size <n>] [--out <path>] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    extract: parseExtractArgs([]),
    batchSize: 3,
    out: "",
    json: false,
  };
  const extractArgv = [];
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--batch-size") {
      options.batchSize = Number(normalizedArgv[++i] || "");
      if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
        usageAndExit("--batch-size must be a positive integer");
      }
    } else if (arg === "--out") {
      options.out = path.resolve(
        normalizedArgv[++i] || usageAndExit("--out requires a path"),
      );
    } else if (arg === "--json") {
      options.json = true;
      extractArgv.push(arg);
    } else {
      extractArgv.push(arg);
      const next = normalizedArgv[i + 1];
      if (next && !next.startsWith("--")) {
        extractArgv.push(next);
        i += 1;
      }
    }
  }
  options.extract = parseExtractArgs(
    extractArgv.filter((value) => value !== "--group-by-area"),
  );
  options.extract.groupByArea = false;
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

function preferredMode(environment) {
  if (environment === "hub") return "hub";
  return "lite";
}

function recommendRunner(area) {
  if (area === "chat" || area === "codex") {
    return { kind: "run-plan", plan: "seeded-chat-smoke", seed: "chat" };
  }
  if (area === "jupyter") {
    return {
      kind: "run-plan",
      plan: "seeded-jupyter-smoke",
      seed: "jupyter",
    };
  }
  if (area === "tasks") {
    return { kind: "run-plan", plan: "seeded-tasks-smoke", seed: "tasks" };
  }
  if (area === "files" || area === "explorer") {
    return { kind: "run-plan", plan: "seeded-files-smoke", seed: "files" };
  }
  return { kind: "run-plan", plan: "session-smoke", seed: "" };
}

function createBatchId(area, environment, index) {
  return [
    "batch",
    sanitizeSegment(area),
    sanitizeSegment(environment),
    String(index).padStart(2, "0"),
  ].join("-");
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function buildBatches(candidates, options = {}) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.area}::${candidate.environment}`;
    const current = grouped.get(key) || [];
    current.push(candidate);
    grouped.set(key, current);
  }
  const groups = Array.from(grouped.entries())
    .map(([key, items]) => {
      const [area, environment] = key.split("::");
      return { area, environment, items };
    })
    .sort((left, right) => {
      const leftScore = left.items[0]?.score ?? 0;
      const rightScore = right.items[0]?.score ?? 0;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.area.localeCompare(right.area);
    });

  const batches = [];
  for (const group of groups) {
    const pieces = chunk(group.items, options.batchSize || 3);
    pieces.forEach((items, index) => {
      const batchId = createBatchId(group.area, group.environment, index + 1);
      batches.push({
        batch_id: batchId,
        area: group.area,
        environment: group.environment,
        preferred_mode: preferredMode(group.environment),
        default_runner: recommendRunner(group.area),
        attach_command: `pnpm -C src bug-hunt:attach -- --mode ${preferredMode(group.environment)}`,
        artifact_prefix: batchId,
        tasks: items.map((candidate, taskIndex) => ({
          order: taskIndex + 1,
          task_id: candidate.task_id,
          title: candidate.title,
          severity: candidate.severity,
          status_hint: candidate.status_hint,
          score: candidate.score,
          environment: candidate.environment,
          artifact_label: `${batchId}-${sanitizeSegment(candidate.task_id)}`,
          note_flags: [
            "--task-id",
            candidate.task_id,
            "--area",
            candidate.area,
          ],
        })),
      });
    });
  }
  return batches;
}

function createDefaultOutPath(now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_BATCH_ROOT, `${stamp}.json`);
}

function writePlan(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function formatBatch(batch) {
  return [
    `${batch.batch_id}`,
    `[${batch.environment}]`,
    `[${batch.area}]`,
    `${batch.tasks.length} task(s)`,
  ].join(" ");
}

function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const tasks = readTasksFile(options.extract.tasksFile || DEFAULT_TASKS_FILE);
  const candidates = filterCandidates(tasks, options.extract);
  const batches = buildBatches(candidates, options);
  const payload = {
    generated_at: new Date(now).toISOString(),
    tasks_file: options.extract.tasksFile,
    total_candidates: candidates.length,
    total_batches: batches.length,
    batch_size: options.batchSize,
    extract_options: {
      freshOnly: options.extract.freshOnly,
      areas: options.extract.areas,
      environments: options.extract.environments,
      minSeverity: options.extract.minSeverity,
      perArea: options.extract.perArea,
      limit: options.extract.limit,
    },
    batches,
  };
  const outFile = options.out || createDefaultOutPath(now);
  writePlan(outFile, payload);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ...payload, out_file: outFile }, null, 2)}\n`,
    );
    return { ...payload, out_file: outFile };
  }
  console.log(`bug-hunt batch plan: ${outFile}`);
  console.log(`candidates:          ${payload.total_candidates}`);
  console.log(`batches:             ${payload.total_batches}`);
  for (const batch of batches) {
    console.log(`- ${formatBatch(batch)}`);
  }
  return { ...payload, out_file: outFile };
}

module.exports = {
  buildBatches,
  createBatchId,
  createDefaultOutPath,
  main,
  parseArgs,
  recommendRunner,
  sanitizeSegment,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt batch-plan error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
