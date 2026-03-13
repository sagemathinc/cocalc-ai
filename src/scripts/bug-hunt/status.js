#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const path = require("node:path");
const {
  classifyEntries,
  normalizeEntryPaths,
  parseGitStatusPorcelainZ,
} = require("./preflight.js");
const {
  DEFAULT_CONTEXT_FILE,
  DEFAULT_LEDGER_ROOT,
  listLedgerEntries,
  readJsonIfExists,
} = require("./ledger-utils.js");

const ROOT = path.resolve(__dirname, "..", "..");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: status.js [--repo <path>] [--context-file <path>] [--ledger-root <path>] [--limit <n>] [--json]",
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
    limit: 5,
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

function runGit(repo, args) {
  const result = cp.spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

function loadPreflight(repo) {
  const gitTopLevel = runGit(repo, ["rev-parse", "--show-toplevel"]);
  const statusText = runGit(repo, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = normalizeEntryPaths(
    parseGitStatusPorcelainZ(statusText),
    repo,
    gitTopLevel,
  );
  const classified = classifyEntries(entries, {
    allowedUntrackedPrefixes: [".agents/bug-hunt/"],
    allowedExactPaths: ["../wstein.tasks"],
  });
  return {
    repo,
    git_top_level: gitTopLevel,
    ok: classified.ok,
    tracked: classified.tracked,
    untracked_blocking: classified.untrackedBlocking,
    untracked_allowed: classified.untrackedAllowed,
  };
}

function summarizeLedger(entries, limit) {
  const valid = entries.filter((entry) => !entry._parse_error);
  const byResult = {};
  for (const entry of valid) {
    byResult[entry.result] = (byResult[entry.result] || 0) + 1;
  }
  return {
    total_entries: valid.length,
    parse_errors: entries.filter((entry) => entry._parse_error).length,
    by_result: byResult,
    latest: valid.slice(0, limit).map((entry) => ({
      iteration: entry.iteration,
      task_id: entry.task_id,
      area: entry.area,
      result: entry.result,
      timestamp: entry.timestamp,
      commit_sha: entry.commit_sha,
      confidence: entry.confidence,
      file: entry._file,
    })),
  };
}

function buildStatusPayload(options) {
  const preflight = loadPreflight(options.repo);
  const context = readJsonIfExists(options.contextFile);
  const ledgerEntries = listLedgerEntries(options.ledgerRoot);
  return {
    preflight,
    context: context
      ? {
          mode: context.mode ?? "",
          browser_mode: context.browser_mode ?? "",
          browser_id: context.browser_id ?? "",
          project_id: context.project_id ?? "",
          api_url: context.api_url ?? "",
          session_url: context.session_url ?? "",
        }
      : undefined,
    ledger: summarizeLedger(ledgerEntries, options.limit),
  };
}

function formatHumanStatus(payload) {
  const lines = [
    `bug-hunt status: ${payload.preflight.ok ? "clean" : "dirty"}`,
    `repo:            ${payload.preflight.repo}`,
  ];
  if (payload.context) {
    lines.push(
      `context:         ${payload.context.mode || "unknown"} / ${payload.context.browser_mode || "unknown"} / ${payload.context.project_id || "unknown-project"}`,
    );
    if (payload.context.browser_id) {
      lines.push(`browser:         ${payload.context.browser_id}`);
    }
  } else {
    lines.push("context:         missing");
  }
  lines.push(`ledger entries:  ${payload.ledger.total_entries}`);
  if (payload.ledger.parse_errors > 0) {
    lines.push(`ledger errors:   ${payload.ledger.parse_errors}`);
  }
  const results = Object.entries(payload.ledger.by_result)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([result, count]) => `${result}=${count}`);
  if (results.length > 0) {
    lines.push(`by result:       ${results.join(", ")}`);
  }
  if (payload.ledger.latest.length > 0) {
    lines.push("recent:");
    for (const entry of payload.ledger.latest) {
      lines.push(
        `- #${entry.iteration} ${entry.result} ${entry.task_id} ${entry.commit_sha ? `(${entry.commit_sha})` : ""}`.trim(),
      );
    }
  }
  if (!payload.preflight.ok) {
    if (payload.preflight.tracked.length > 0) {
      lines.push("tracked:");
      for (const entry of payload.preflight.tracked) {
        lines.push(`- ${entry.status} ${entry.path}`);
      }
    }
    if (payload.preflight.untracked_blocking.length > 0) {
      lines.push("blocking untracked:");
      for (const entry of payload.preflight.untracked_blocking) {
        lines.push(`- ${entry.status} ${entry.path}`);
      }
    }
  }
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const payload = buildStatusPayload(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(formatHumanStatus(payload));
  return payload;
}

module.exports = {
  buildStatusPayload,
  formatHumanStatus,
  parseArgs,
  summarizeLedger,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt status error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
