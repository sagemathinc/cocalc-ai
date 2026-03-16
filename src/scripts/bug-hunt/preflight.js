#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_ALLOWED_UNTRACKED_PREFIXES = [".agents/bug-hunt/"];
const DEFAULT_ALLOWED_EXACT_PATHS = ["../wstein.tasks"];

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: preflight.js [--repo <path>] [--json] [--fail-on-dirty] [--allow-untracked-prefix <prefix>] [--allow-path <path>]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    repo: ROOT,
    json: false,
    failOnDirty: false,
    allowedUntrackedPrefixes: [...DEFAULT_ALLOWED_UNTRACKED_PREFIXES],
    allowedExactPaths: [...DEFAULT_ALLOWED_EXACT_PATHS],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      options.repo = path.resolve(
        argv[++i] || usageAndExit("--repo requires a path"),
      );
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-dirty") {
      options.failOnDirty = true;
    } else if (arg === "--allow-untracked-prefix") {
      options.allowedUntrackedPrefixes.push(
        argv[++i] || usageAndExit("--allow-untracked-prefix requires a value"),
      );
    } else if (arg === "--allow-path") {
      options.allowedExactPaths.push(
        argv[++i] || usageAndExit("--allow-path requires a value"),
      );
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runGitStatus(repo) {
  const result = cp.spawnSync(
    "git",
    ["-C", repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `git status failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return result.stdout ?? "";
}

function runGitRevParse(repo, flag) {
  const result = cp.spawnSync("git", ["-C", repo, "rev-parse", flag], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git rev-parse ${flag} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

function parseGitStatusPorcelainZ(text) {
  const tokens = `${text ?? ""}`.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const filePath = token.slice(3);
    let originalPath;
    if (status.includes("R") || status.includes("C")) {
      originalPath = tokens[++i] || "";
    }
    entries.push({ status, path: filePath, originalPath });
  }
  return entries;
}

function normalizeEntryPaths(entries, repo, gitTopLevel) {
  return entries.map((entry) => {
    const normalized = { ...entry };
    normalized.path = path.relative(repo, path.join(gitTopLevel, entry.path));
    if (entry.originalPath) {
      normalized.originalPath = path.relative(
        repo,
        path.join(gitTopLevel, entry.originalPath),
      );
    }
    return normalized;
  });
}

function isAllowedUntracked(filePath, options = {}) {
  if ((options.allowedExactPaths ?? []).includes(filePath)) return true;
  return (options.allowedUntrackedPrefixes ?? []).some((prefix) =>
    filePath.startsWith(prefix),
  );
}

function classifyEntries(entries, options = {}) {
  const tracked = [];
  const untrackedBlocking = [];
  const untrackedAllowed = [];
  for (const entry of entries) {
    if (entry.status === "??") {
      if (isAllowedUntracked(entry.path, options)) {
        untrackedAllowed.push(entry);
      } else {
        untrackedBlocking.push(entry);
      }
      continue;
    }
    if (entry.status === "!!") continue;
    tracked.push(entry);
  }
  return {
    tracked,
    untrackedBlocking,
    untrackedAllowed,
    ok: tracked.length === 0 && untrackedBlocking.length === 0,
  };
}

function formatEntry(entry) {
  if (entry.originalPath) {
    return `${entry.status} ${entry.path} <- ${entry.originalPath}`;
  }
  return `${entry.status} ${entry.path}`;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const gitTopLevel = runGitRevParse(options.repo, "--show-toplevel");
  const entries = normalizeEntryPaths(
    parseGitStatusPorcelainZ(runGitStatus(options.repo)),
    options.repo,
    gitTopLevel,
  );
  const result = classifyEntries(entries, options);
  const payload = {
    repo: options.repo,
    git_top_level: gitTopLevel,
    ok: result.ok,
    tracked: result.tracked,
    untracked_blocking: result.untrackedBlocking,
    untracked_allowed: result.untrackedAllowed,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(
      `bug-hunt preflight: ${result.ok ? "clean" : "dirty"} (${options.repo})`,
    );
    if (result.tracked.length > 0) {
      console.log("tracked changes:");
      for (const entry of result.tracked) {
        console.log(`- ${formatEntry(entry)}`);
      }
    }
    if (result.untrackedBlocking.length > 0) {
      console.log("blocking untracked files:");
      for (const entry of result.untrackedBlocking) {
        console.log(`- ${formatEntry(entry)}`);
      }
    }
    if (result.untrackedAllowed.length > 0) {
      console.log("allowed untracked files:");
      for (const entry of result.untrackedAllowed) {
        console.log(`- ${formatEntry(entry)}`);
      }
    }
  }
  if (options.failOnDirty && !result.ok) {
    process.exit(2);
  }
}

module.exports = {
  classifyEntries,
  isAllowedUntracked,
  normalizeEntryPaths,
  parseArgs,
  parseGitStatusPorcelainZ,
};

if (require.main === module) {
  main();
}
