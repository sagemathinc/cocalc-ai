#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_CONTEXT_FILE,
  DEFAULT_LEDGER_ROOT,
} = require("./ledger-utils.js");
const { buildStatusPayload } = require("./status.js");

const ROOT = path.resolve(__dirname, "..", "..");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: split-suggestions.js [--repo <path>] [--context-file <path>] [--ledger-root <path>] [--limit <n>] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    repo: ROOT,
    contextFile: DEFAULT_CONTEXT_FILE,
    ledgerRoot: DEFAULT_LEDGER_ROOT,
    limit: 10,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--repo") {
      options.repo = path.resolve(
        normalizedArgv[++i] || usageAndExit("--repo requires a path"),
      );
    } else if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--ledger-root") {
      options.ledgerRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--ledger-root requires a path"),
      );
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
  return options;
}

function tokenizeArea(area) {
  return Array.from(
    new Set(
      `${area ?? ""}`
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 2),
    ),
  );
}

function scorePathForArea(filePath, area) {
  const pathText = `${filePath ?? ""}`.toLowerCase();
  const tokens = tokenizeArea(area);
  let matchedLength = 0;
  let matchedCount = 0;
  for (const token of tokens) {
    if (pathText.includes(token)) {
      matchedLength += token.length;
      matchedCount += 1;
    }
  }
  if (matchedCount === 0) return 0;
  return Math.round((matchedCount / tokens.length) * 100) + matchedLength;
}

function buildSplitSuggestions(changedPaths, ledgerEntries, limit = 10) {
  const pending = ledgerEntries
    .filter((entry) => !entry._parse_error && !entry.commit_sha)
    .slice(0, limit)
    .map((entry) => ({
      iteration: entry.iteration,
      task_id: entry.task_id,
      area: entry.area,
      result: entry.result,
      suggested_subject_prefix: entry.area,
      files: [],
    }));

  const unmatched = [];
  for (const filePath of changedPaths) {
    let best;
    for (const entry of pending) {
      const score = scorePathForArea(filePath, entry.area);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }
    if (!best || best.score <= 0) {
      unmatched.push(filePath);
      continue;
    }
    best.entry.files.push(filePath);
  }

  return {
    pending_entries: pending.length,
    suggestions: pending.filter((entry) => entry.files.length > 0),
    unmatched,
  };
}

function formatHumanSuggestions(payload) {
  const lines = [
    `bug-hunt split suggestions: ${payload.suggestions.length} group(s)`,
  ];
  for (const suggestion of payload.suggestions) {
    lines.push(
      `- #${suggestion.iteration} ${suggestion.task_id} ${suggestion.area}`,
    );
    lines.push(`  subject prefix: ${suggestion.suggested_subject_prefix}`);
    for (const file of suggestion.files) {
      lines.push(`  file: ${file}`);
    }
  }
  if (payload.unmatched.length > 0) {
    lines.push("- unmatched");
    for (const file of payload.unmatched) {
      lines.push(`  file: ${file}`);
    }
  }
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const status = buildStatusPayload(options);
  const changedPaths = [
    ...status.preflight.tracked.map((entry) => entry.path),
    ...status.preflight.untracked_blocking.map((entry) => entry.path),
  ];
  const payload = buildSplitSuggestions(
    changedPaths,
    status.ledger.latest,
    options.limit,
  );
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanSuggestions(payload));
  return payload;
}

module.exports = {
  buildSplitSuggestions,
  formatHumanSuggestions,
  main,
  parseArgs,
  scorePathForArea,
  tokenizeArea,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt split-suggestions error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
