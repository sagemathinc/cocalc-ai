#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_SNAPSHOT_ROOT,
  compareRepoContents,
  resolveSnapshot,
  summarizeChanges,
} = require("./snapshot-utils.js");

const ROOT = path.resolve(__dirname, "..", "..");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: diff-since-snapshot.js --snapshot <name-or-path> [--repo <path>] [--snapshot-root <path>] [--limit <n>] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    snapshot: "",
    repo: ROOT,
    snapshotRoot: DEFAULT_SNAPSHOT_ROOT,
    limit: 50,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--snapshot") {
      options.snapshot =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--snapshot requires a value");
    } else if (arg === "--repo") {
      options.repo = path.resolve(
        normalizedArgv[++i] || usageAndExit("--repo requires a path"),
      );
    } else if (arg === "--snapshot-root") {
      options.snapshotRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--snapshot-root requires a path"),
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
  if (!options.snapshot) usageAndExit("--snapshot is required");
  return options;
}

function buildDiffPayload(options) {
  const snapshot = resolveSnapshot(
    options.snapshot,
    options.repo,
    options.snapshotRoot,
    options.homeDir,
  );
  const changes = compareRepoContents(snapshot.repo_path, options.repo);
  return {
    repo: options.repo,
    snapshot: {
      name: snapshot.name,
      dir: snapshot.dir,
      repo_path: snapshot.repo_path,
      timestamp: snapshot.timestamp,
    },
    summary: summarizeChanges(changes),
    changes: changes.slice(0, options.limit),
    truncated: Math.max(changes.length - options.limit, 0),
  };
}

function formatHumanPayload(payload) {
  const lines = [
    `bug-hunt diff since snapshot: ${payload.snapshot.name}`,
    `repo:      ${payload.repo}`,
    `snapshot:  ${payload.snapshot.repo_path}`,
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
  const payload = buildDiffPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanPayload(payload));
  return payload;
}

module.exports = {
  buildDiffPayload,
  formatHumanPayload,
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt diff-since-snapshot error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
