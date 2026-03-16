#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_LEDGER_ROOT,
  findLedgerEntry,
  formatTaskNote,
  listLedgerEntries,
} = require("./ledger-utils.js");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: task-note.js [--task-id <id> | --iteration <n> | --latest] [--ledger-root <path>] [--json]",
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
    latest: false,
    ledgerRoot: DEFAULT_LEDGER_ROOT,
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
    } else if (arg === "--latest") {
      options.latest = true;
    } else if (arg === "--ledger-root") {
      options.ledgerRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--ledger-root requires a path"),
      );
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveEntry(options) {
  if (options.taskId || options.iteration) {
    return findLedgerEntry(options.ledgerRoot, {
      taskId: options.taskId,
      iteration: options.iteration,
    });
  }
  const entries = listLedgerEntries(options.ledgerRoot).filter(
    (entry) => !entry._parse_error,
  );
  return entries[0];
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const entry = resolveEntry(options);
  if (!entry) {
    throw new Error("no matching ledger entry found");
  }
  const payload = {
    iteration: entry.iteration,
    task_id: entry.task_id,
    area: entry.area,
    result: entry.result,
    commit_sha: entry.commit_sha,
    ledger_json: entry._file,
    task_note: formatTaskNote(entry),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  process.stdout.write(`${payload.task_note}\n`);
  return payload;
}

module.exports = {
  main,
  parseArgs,
  resolveEntry,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt task-note error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
