#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_CONTEXT_FILE,
  DEFAULT_LEDGER_ROOT,
  buildEntry,
  formatTaskNote,
  readJsonIfExists,
  writeLedgerEntry,
} = require("./ledger-utils.js");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: note.js --task-id <id> --area <area> --result <result> [--title <text>] [--evidence <text>] [--artifact <path>] [--artifact-dir <path>] [--validation <text>] [--commit-sha <sha>] [--confidence <0..1>] [--iteration <n>] [--context-file <path>] [--ledger-root <path>] [--json] [--task-note-only]",
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
    title: "",
    area: "",
    result: "",
    evidence: [],
    artifacts: [],
    validation: [],
    commitSha: "",
    confidence: "",
    iteration: "",
    contextFile: DEFAULT_CONTEXT_FILE,
    ledgerRoot: DEFAULT_LEDGER_ROOT,
    json: false,
    taskNoteOnly: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--task-id") {
      options.taskId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--task-id requires a value");
    } else if (arg === "--title") {
      options.title = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--area") {
      options.area =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--area requires a value");
    } else if (arg === "--result") {
      options.result =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--result requires a value");
    } else if (arg === "--evidence") {
      options.evidence.push(
        `${normalizedArgv[++i] || ""}`.trim() ||
          usageAndExit("--evidence requires a value"),
      );
    } else if (arg === "--artifact" || arg === "--artifact-dir") {
      options.artifacts.push(
        path.resolve(
          normalizedArgv[++i] || usageAndExit(`${arg} requires a path`),
        ),
      );
    } else if (arg === "--validation") {
      options.validation.push(
        `${normalizedArgv[++i] || ""}`.trim() ||
          usageAndExit("--validation requires a value"),
      );
    } else if (arg === "--commit-sha") {
      options.commitSha =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--commit-sha requires a value");
    } else if (arg === "--confidence") {
      options.confidence =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--confidence requires a value");
    } else if (arg === "--iteration") {
      options.iteration =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--iteration requires a value");
    } else if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--ledger-root") {
      options.ledgerRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--ledger-root requires a path"),
      );
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--task-note-only") {
      options.taskNoteOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2), now = new Date()) {
  const options = parseArgs(argv);
  const context = readJsonIfExists(options.contextFile);
  const entry = buildEntry(options, context, now);
  const paths = writeLedgerEntry(options.ledgerRoot, entry);
  const taskNote = formatTaskNote(entry);
  const payload = {
    ...entry,
    ledger_json: paths.json,
    ledger_markdown: paths.markdown,
    task_note: taskNote,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  if (options.taskNoteOnly) {
    process.stdout.write(`${taskNote}\n`);
    return payload;
  }
  console.log(`bug-hunt note: iteration ${entry.iteration}`);
  console.log(`ledger:        ${paths.json}`);
  console.log(`result:        ${entry.result}`);
  console.log(`task:          ${entry.task_id}`);
  console.log("");
  console.log(taskNote);
  return payload;
}

module.exports = {
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt note error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
