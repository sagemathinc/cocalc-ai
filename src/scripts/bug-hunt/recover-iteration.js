#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { DEFAULT_LEDGER_ROOT, findLedgerEntry } = require("./ledger-utils.js");
const {
  DEFAULT_SNAPSHOT_ROOT,
  compareRepoContents,
  listSnapshots,
  selectSnapshotAfter,
  selectSnapshotBefore,
  summarizeChanges,
} = require("./snapshot-utils.js");

const ROOT = path.resolve(__dirname, "..", "..");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: recover-iteration.js (--task-id <id> | --iteration <n>) [--repo <path>] [--ledger-root <path>] [--snapshot-root <path>] [--compare-to current|after-snapshot] [--limit <n>] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    taskId: "",
    iteration: "",
    repo: ROOT,
    ledgerRoot: DEFAULT_LEDGER_ROOT,
    snapshotRoot: DEFAULT_SNAPSHOT_ROOT,
    compareTo: "after-snapshot",
    limit: 50,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--task-id") {
      options.taskId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--task-id requires a value");
    } else if (arg === "--iteration") {
      options.iteration =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--iteration requires a value");
    } else if (arg === "--repo") {
      options.repo = path.resolve(
        normalizedArgv[++i] || usageAndExit("--repo requires a path"),
      );
    } else if (arg === "--ledger-root") {
      options.ledgerRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--ledger-root requires a path"),
      );
    } else if (arg === "--snapshot-root") {
      options.snapshotRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--snapshot-root requires a path"),
      );
    } else if (arg === "--compare-to") {
      options.compareTo =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--compare-to requires a value");
      if (!["current", "after-snapshot"].includes(options.compareTo)) {
        usageAndExit("--compare-to must be current or after-snapshot");
      }
    } else if (arg === "--limit") {
      options.limit = Number(normalizedArgv[++i] || "");
      if (!Number.isInteger(options.limit) || options.limit <= 0) {
        usageAndExit("--limit must be a positive integer");
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  if (!options.taskId && !options.iteration) {
    usageAndExit("--task-id or --iteration is required");
  }
  return options;
}

function buildRecoverPayload(options) {
  const entry = findLedgerEntry(options.ledgerRoot, {
    taskId: options.taskId,
    iteration: options.iteration,
  });
  if (!entry) {
    throw new Error("matching ledger entry not found");
  }
  const timestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`invalid ledger timestamp: ${entry.timestamp}`);
  }
  const snapshots = listSnapshots(
    options.snapshotRoot,
    options.repo,
    options.homeDir,
  );
  const before = selectSnapshotBefore(snapshots, timestampMs);
  if (!before) {
    throw new Error("no snapshot found before the selected iteration");
  }
  const afterSnapshot =
    options.compareTo === "after-snapshot"
      ? selectSnapshotAfter(snapshots, timestampMs)
      : undefined;
  const target = afterSnapshot
    ? {
        kind: "snapshot",
        name: afterSnapshot.name,
        path: afterSnapshot.repo_path,
      }
    : {
        kind: "current",
        name: "current",
        path: options.repo,
      };
  const changes = compareRepoContents(before.repo_path, target.path);
  return {
    entry: {
      iteration: entry.iteration,
      task_id: entry.task_id,
      area: entry.area,
      result: entry.result,
      timestamp: entry.timestamp,
    },
    before: {
      name: before.name,
      dir: before.dir,
      repo_path: before.repo_path,
    },
    after: target,
    summary: summarizeChanges(changes),
    changes: changes.slice(0, options.limit),
    truncated: Math.max(changes.length - options.limit, 0),
  };
}

function formatHumanPayload(payload) {
  const lines = [
    `bug-hunt recover iteration: #${payload.entry.iteration} ${payload.entry.task_id}`,
    `area:      ${payload.entry.area}`,
    `before:    ${payload.before.name}`,
    `after:     ${payload.after.name}`,
    `summary:   total=${payload.summary.total} added=${payload.summary.added} modified=${payload.summary.modified} deleted=${payload.summary.deleted}`,
  ];
  for (const change of payload.changes) {
    lines.push(`- ${change.status} ${change.path}`);
  }
  if (payload.truncated > 0) {
    lines.push(`- ... ${payload.truncated} more`);
  }
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const payload = buildRecoverPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanPayload(payload));
  return payload;
}

module.exports = {
  buildRecoverPayload,
  formatHumanPayload,
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt recover-iteration error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
