#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_LEDGER_ROOT,
  findLedgerEntry,
  updateLedgerCommit,
} = require("./ledger-utils.js");

const ROOT = path.resolve(__dirname, "..", "..");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: commit.js --task-id <id> --subject <text> [--body <text>] [--iteration <n>] [--repo <path>] [--ledger-root <path>] [--path <path>] [--stage-all] [--allow-empty] [--json]",
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
    subject: "",
    body: [],
    iteration: "",
    repo: ROOT,
    ledgerRoot: DEFAULT_LEDGER_ROOT,
    rawPaths: [],
    paths: [],
    stageAll: false,
    allowEmpty: false,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--task-id") {
      options.taskId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--task-id requires a value");
    } else if (arg === "--subject") {
      options.subject =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--subject requires a value");
    } else if (arg === "--body") {
      options.body.push(
        `${normalizedArgv[++i] || ""}`.trim() ||
          usageAndExit("--body requires a value"),
      );
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
    } else if (arg === "--path") {
      options.rawPaths.push(
        path.resolve(
          normalizedArgv[++i] || usageAndExit("--path requires a value"),
        ),
      );
    } else if (arg === "--stage-all") {
      options.stageAll = true;
    } else if (arg === "--allow-empty") {
      options.allowEmpty = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  if (!options.taskId) usageAndExit("--task-id is required");
  if (!options.subject) usageAndExit("--subject is required");
  options.paths = options.rawPaths.map((file) =>
    path.relative(options.repo, file),
  );
  return options;
}

function runGit(repo, args, opts = {}) {
  const result = cp.spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

function ensureLedgerEntry(options) {
  const entry = findLedgerEntry(options.ledgerRoot, {
    taskId: options.taskId,
    iteration: options.iteration,
  });
  if (!entry) {
    throw new Error(
      `no matching ledger entry found for task ${options.taskId}${options.iteration ? ` iteration ${options.iteration}` : ""}`,
    );
  }
  return entry;
}

function stageRequestedChanges(options) {
  if (options.stageAll) {
    runGit(options.repo, ["add", "-A"]);
    return;
  }
  if (options.paths.length > 0) {
    runGit(options.repo, ["add", "--", ...options.paths]);
  }
}

function ensureStagedChanges(options) {
  const result = cp.spawnSync(
    "git",
    ["-C", options.repo, "diff", "--cached", "--quiet", "--exit-code"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0 && !options.allowEmpty) {
    throw new Error("no staged changes to commit");
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git diff --cached failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
}

function createCommitMessageFile(options) {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-commit-"),
  );
  const messageFile = path.join(tmpDir, "message.txt");
  const lines = [options.subject];
  if (options.body.length > 0) {
    lines.push("", ...options.body);
  }
  fs.writeFileSync(messageFile, `${lines.join("\n")}\n`);
  return { tmpDir, messageFile };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const entry = ensureLedgerEntry(options);
  stageRequestedChanges(options);
  ensureStagedChanges(options);
  const { tmpDir, messageFile } = createCommitMessageFile(options);
  try {
    runGit(options.repo, ["commit", "-F", messageFile]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const commitSha = runGit(options.repo, ["rev-parse", "HEAD"]);
  const updated = updateLedgerCommit(options.ledgerRoot, {
    taskId: options.taskId,
    iteration: options.iteration,
    commitSha,
  });
  const payload = {
    task_id: entry.task_id,
    iteration: updated.entry.iteration,
    commit_sha: commitSha,
    ledger_json: updated.paths.json,
    ledger_markdown: updated.paths.markdown,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`bug-hunt commit: ${commitSha}`);
  console.log(`task:            ${payload.task_id}`);
  console.log(`iteration:       ${payload.iteration}`);
  console.log(`ledger:          ${payload.ledger_json}`);
  return payload;
}

module.exports = {
  createCommitMessageFile,
  main,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt commit error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
