#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  createDefaultNoteOptions,
  createLedgerNote,
  parseNoteArg,
} = require("./note-integration.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONTEXT_FILE = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "current-context.json",
);
const DEFAULT_ARTIFACT_ROOT = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "artifacts",
);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: capture.js [--context-file <path>] [--out-dir <path>] [--name <label>] [--logs-lines <n>] [--json] [--no-screenshot] [--no-logs] [--task-id <id> --area <area> --result <result> ...]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    contextFile: DEFAULT_CONTEXT_FILE,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    name: "",
    logsLines: 200,
    json: false,
    screenshot: true,
    logs: true,
    note: createDefaultNoteOptions(),
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--out-dir") {
      options.artifactRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--out-dir requires a path"),
      );
    } else if (arg === "--name") {
      options.name = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--logs-lines") {
      options.logsLines = Number(normalizedArgv[++i] || "");
      if (!Number.isFinite(options.logsLines) || options.logsLines <= 0) {
        usageAndExit("--logs-lines must be a positive integer");
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-screenshot") {
      options.screenshot = false;
    } else if (arg === "--no-logs") {
      options.logs = false;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      const nextIndex = parseNoteArg(
        normalizedArgv,
        i,
        options.note,
        usageAndExit,
      );
      if (nextIndex !== i) {
        i = nextIndex;
      } else {
        usageAndExit(`Unknown argument: ${arg}`);
      }
    }
  }
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

function createArtifactDirName(now, context, name) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const parts = [
    stamp,
    sanitizeSegment(context.mode || "unknown"),
    sanitizeSegment(context.browser_mode || "unknown"),
  ];
  const label = sanitizeSegment(name);
  if (label) parts.push(label);
  return parts.filter(Boolean).join("-");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to read ${label}: ${detail}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function unwrapCliJsonPayload(parsed) {
  if (
    parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "ok") &&
    Object.prototype.hasOwnProperty.call(parsed, "data")
  ) {
    return parsed.data;
  }
  return parsed;
}

function createCliEnv(context) {
  return { ...process.env, ...(context.exports ?? {}) };
}

function runCliJson(context, args) {
  const cliBin = `${context.cli_bin ?? ""}`.trim();
  if (!cliBin) {
    throw new Error("context does not include cli_bin");
  }
  const result = run(process.execPath, [cliBin, "--json", ...args], {
    env: createCliEnv(context),
  });
  if (result.status !== 0) {
    throw new Error(
      `cocalc ${args.join(" ")} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  try {
    return unwrapCliJsonPayload(JSON.parse(result.stdout || "null"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to parse cocalc ${args.join(" ")} JSON: ${detail}`);
  }
}

function captureStep(summary, name, fn) {
  try {
    const value = fn();
    summary.steps[name] = { ok: true };
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : `${err}`;
    summary.steps[name] = { ok: false, error: message };
    summary.errors.push({ step: name, error: message });
    return undefined;
  }
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const context = readJson(options.contextFile, "bug-hunt context");
  const artifactDir = path.join(
    options.artifactRoot,
    createArtifactDirName(Date.now(), context, options.name),
  );
  fs.mkdirSync(artifactDir, { recursive: true });

  const summary = {
    artifact_dir: artifactDir,
    context_file: options.contextFile,
    mode: context.mode ?? "",
    browser_mode: context.browser_mode ?? "",
    browser_id: context.browser_id ?? "",
    files: {},
    steps: {},
    errors: [],
  };

  const contextOut = path.join(artifactDir, "context.json");
  writeJson(contextOut, context);
  summary.files.context = contextOut;

  const sessionList = captureStep(summary, "browser_session_list", () =>
    runCliJson(context, [
      "browser",
      "session",
      "list",
      "--include-stale",
      "--project-id",
      context.project_id || context.exports?.COCALC_PROJECT_ID || "",
    ]),
  );
  if (sessionList !== undefined) {
    const file = path.join(artifactDir, "browser-session-list.json");
    writeJson(file, sessionList);
    summary.files.browser_session_list = file;
  }

  const spawned = captureStep(summary, "browser_session_spawned", () =>
    runCliJson(context, ["browser", "session", "spawned"]),
  );
  if (spawned !== undefined) {
    const file = path.join(artifactDir, "browser-session-spawned.json");
    writeJson(file, spawned);
    summary.files.browser_session_spawned = file;
  }

  if (context.browser_id && options.screenshot) {
    const screenshotPath = path.join(artifactDir, "screenshot.png");
    const screenshotMetaPath = path.join(artifactDir, "screenshot-meta.json");
    const screenshotResult = captureStep(summary, "browser_screenshot", () =>
      runCliJson(context, [
        "browser",
        "screenshot",
        "--out",
        screenshotPath,
        "--meta-out",
        screenshotMetaPath,
        "--selector",
        "body",
        "--wait-for-idle",
        "750ms",
      ]),
    );
    if (screenshotResult !== undefined) {
      const resultFile = path.join(artifactDir, "screenshot-result.json");
      writeJson(resultFile, screenshotResult);
      summary.files.screenshot = screenshotPath;
      summary.files.screenshot_meta = screenshotMetaPath;
      summary.files.screenshot_result = resultFile;
    }
  }

  if (context.browser_id && options.logs) {
    const consoleLogs = captureStep(summary, "browser_logs_tail", () =>
      runCliJson(context, [
        "browser",
        "logs",
        "tail",
        "--lines",
        `${options.logsLines}`,
      ]),
    );
    if (consoleLogs !== undefined) {
      const file = path.join(artifactDir, "browser-console.json");
      writeJson(file, consoleLogs);
      summary.files.browser_console = file;
    }

    const uncaughtLogs = captureStep(summary, "browser_logs_uncaught", () =>
      runCliJson(context, [
        "browser",
        "logs",
        "uncaught",
        "--lines",
        `${options.logsLines}`,
        "--no-follow",
      ]),
    );
    if (uncaughtLogs !== undefined) {
      const file = path.join(artifactDir, "browser-uncaught.json");
      writeJson(file, uncaughtLogs);
      summary.files.browser_uncaught = file;
    }
  }

  if (!context.browser_id) {
    summary.steps.browser_attach = {
      ok: false,
      skipped: true,
      error:
        "current context has no browser_id; screenshot and log capture skipped",
    };
  }

  const failedSteps = Object.entries(summary.steps)
    .filter(([, step]) => !step.ok)
    .map(([name]) => name);
  const ledgerNote = createLedgerNote(options.note, context, {
    title: options.name || "capture",
    artifacts: [artifactDir],
    evidence: [
      `capture ok steps: ${Object.values(summary.steps).filter((step) => step.ok).length}`,
      `capture failed steps: ${failedSteps.length}`,
      ...failedSteps.map((name) => `failed step: ${name}`),
    ],
  });
  if (ledgerNote) {
    summary.ledger_note = {
      iteration: ledgerNote.iteration,
      task_id: ledgerNote.task_id,
      result: ledgerNote.result,
      ledger_json: ledgerNote.ledger_json,
      ledger_markdown: ledgerNote.ledger_markdown,
    };
  }

  const summaryFile = path.join(artifactDir, "capture-summary.json");
  writeJson(summaryFile, summary);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  console.log(`bug-hunt capture: ${artifactDir}`);
  console.log(`files: ${Object.keys(summary.files).length}`);
  if (summary.errors.length > 0) {
    console.log(`errors: ${summary.errors.length}`);
  }
}

module.exports = {
  createArtifactDirName,
  createCliEnv,
  parseArgs,
  runCliJson,
  sanitizeSegment,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt capture error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
