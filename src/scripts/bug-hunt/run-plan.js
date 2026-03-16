#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  refreshLiveContextTarget,
  writeContextFileIfChanged,
} = require("./context-target.js");
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
const DEFAULT_PLAN_DIR = path.join(ROOT, ".agents", "bug-hunt", "plans");

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: run-plan.js (--plan <name-or-path> | --list-plans) [--context-file <path>] [--artifact-root <path>] [--report-dir <path>] [--name <label>] [--seed <csv>] [--json] [--dry-run] [--default-retries <n>] [--default-timeout <duration>] [--default-recovery <mode>] [--max-failures <n>] [--logs-on-fail <n>] [--network-on-fail <n>] [--no-screenshot-on-fail] [--no-pin-target] [--allow-raw-exec] [--task-id <id> --area <area> --result <result> ...]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    plan: "",
    listPlans: false,
    contextFile: DEFAULT_CONTEXT_FILE,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    reportDir: "",
    name: "",
    json: false,
    dryRun: false,
    seedTypes: [],
    defaultRetries: "",
    defaultTimeout: "",
    defaultRecovery: "",
    maxFailures: "",
    logsOnFail: "",
    networkOnFail: "",
    screenshotOnFail: true,
    pinTarget: true,
    allowRawExec: false,
    note: createDefaultNoteOptions(),
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--plan") {
      options.plan =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--plan requires a value");
    } else if (arg === "--list-plans") {
      options.listPlans = true;
    } else if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--artifact-root") {
      options.artifactRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--artifact-root requires a path"),
      );
    } else if (arg === "--report-dir") {
      options.reportDir = path.resolve(
        normalizedArgv[++i] || usageAndExit("--report-dir requires a path"),
      );
    } else if (arg === "--name") {
      options.name = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--seed") {
      options.seedTypes = resolveSeedTypes(normalizedArgv[++i] || "");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--default-retries") {
      options.defaultRetries =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--default-retries requires a value");
    } else if (arg === "--default-timeout") {
      options.defaultTimeout =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--default-timeout requires a value");
    } else if (arg === "--default-recovery") {
      options.defaultRecovery =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--default-recovery requires a value");
    } else if (arg === "--max-failures") {
      options.maxFailures =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--max-failures requires a value");
    } else if (arg === "--logs-on-fail") {
      options.logsOnFail =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--logs-on-fail requires a value");
    } else if (arg === "--network-on-fail") {
      options.networkOnFail =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--network-on-fail requires a value");
    } else if (arg === "--no-screenshot-on-fail") {
      options.screenshotOnFail = false;
    } else if (arg === "--no-pin-target") {
      options.pinTarget = false;
    } else if (arg === "--allow-raw-exec") {
      options.allowRawExec = true;
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
  if (!options.listPlans && !options.plan) {
    usageAndExit("--plan is required unless --list-plans is used");
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

function createArtifactDirName(now, context, planName, name) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const parts = [
    stamp,
    sanitizeSegment(context.mode || "unknown"),
    sanitizeSegment(context.browser_mode || "unknown"),
    "plan",
    sanitizeSegment(planName || "run"),
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

function createCliEnv(context) {
  return { ...process.env, ...(context.exports ?? {}) };
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

function resolveSeedTypes(value) {
  const raw = `${value ?? ""}`.trim().toLowerCase();
  if (!raw) return [];
  if (raw === "all") {
    return ["chat", "jupyter", "tasks", "files", "whiteboard"];
  }
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const allowed = new Set(["chat", "jupyter", "tasks", "files", "whiteboard"]);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new Error(
        `invalid --seed value '${value}'; expected chat,jupyter,tasks,files,whiteboard or all`,
      );
    }
  }
  return Array.from(new Set(values));
}

function resolvePlanFile(value) {
  const raw = `${value ?? ""}`.trim();
  if (!raw) {
    throw new Error("plan name/path is required");
  }
  if (
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.endsWith(".json") ||
    fs.existsSync(raw)
  ) {
    return path.resolve(raw);
  }
  return path.join(DEFAULT_PLAN_DIR, `${raw}.json`);
}

function listAvailablePlans(planDir = DEFAULT_PLAN_DIR) {
  if (!fs.existsSync(planDir)) return [];
  return fs
    .readdirSync(planDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const file = path.join(planDir, entry.name);
      return {
        name: planNameFromPath(entry.name),
        path: file,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function planNameFromPath(planFile) {
  return path.basename(planFile).replace(/\.json$/i, "");
}

function buildHarnessArgs(options, context, planFile, reportDir) {
  const args = [
    "browser",
    "harness",
    "run",
    "--plan",
    planFile,
    "--browser",
    context.browser_id,
    "--project-id",
    context.project_id,
    "--report-dir",
    reportDir,
    "--active-only",
  ];
  if (options.dryRun) args.push("--dry-run");
  if (options.defaultRetries) {
    args.push("--default-retries", options.defaultRetries);
  }
  if (options.defaultTimeout) {
    args.push("--default-timeout", options.defaultTimeout);
  }
  if (options.defaultRecovery) {
    args.push("--default-recovery", options.defaultRecovery);
  }
  if (options.maxFailures) {
    args.push("--max-failures", options.maxFailures);
  }
  if (options.logsOnFail) {
    args.push("--logs-on-fail", options.logsOnFail);
  }
  if (options.networkOnFail) {
    args.push("--network-on-fail", options.networkOnFail);
  }
  if (!options.screenshotOnFail) {
    args.push("--no-screenshot-on-fail");
  }
  if (!options.pinTarget) {
    args.push("--no-pin-target");
  }
  if (options.allowRawExec) {
    args.push("--allow-raw-exec");
  }
  return args;
}

function runSeedIfRequested(context, options, artifactDir) {
  if (!options.seedTypes.length) return undefined;
  const seedArgs = [
    process.execPath,
    path.join(ROOT, "scripts", "bug-hunt", "seed.js"),
    "--context-file",
    options.contextFile,
    "--json",
    "--name",
    options.name || "plan-seed",
    ...options.seedTypes.map((type) => `--${type}`),
  ];
  const result = run(seedArgs[0], seedArgs.slice(1), {
    env: createCliEnv(context),
  });
  if (result.status !== 0) {
    throw new Error(
      `bug-hunt seed failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  const parsed = JSON.parse(result.stdout || "null");
  const out = path.join(artifactDir, "seed-result.json");
  writeJson(out, parsed);
  return parsed;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.listPlans) {
    const plans = listAvailablePlans();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ plans }, null, 2)}\n`);
      return;
    }
    for (const plan of plans) {
      console.log(`${plan.name}  ${plan.path}`);
    }
    return;
  }
  const originalContext = readJson(options.contextFile, "bug-hunt context");
  const context = refreshLiveContextTarget(originalContext);
  writeContextFileIfChanged(options.contextFile, originalContext, context);
  if (!`${context.browser_id ?? ""}`.trim()) {
    throw new Error(
      "current context does not include a browser_id; attach first with bug-hunt:attach",
    );
  }
  if (!`${context.project_id ?? ""}`.trim()) {
    throw new Error("current context does not include a project_id");
  }
  const planFile = resolvePlanFile(options.plan);
  if (!fs.existsSync(planFile)) {
    throw new Error(`plan file not found: ${planFile}`);
  }
  const planName = planNameFromPath(planFile);
  const artifactDir =
    options.reportDir ||
    path.join(
      options.artifactRoot,
      createArtifactDirName(Date.now(), context, planName, options.name),
    );
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, "context.json"), context);

  const seedResult = runSeedIfRequested(context, options, artifactDir);
  const harnessArgs = buildHarnessArgs(options, context, planFile, artifactDir);
  const harnessResult = runCliJson(context, harnessArgs);
  writeJson(path.join(artifactDir, "harness-result.json"), harnessResult);

  const summary = {
    ok: !!harnessResult?.ok,
    plan: planName,
    plan_path: planFile,
    artifact_dir: artifactDir,
    context_file: options.contextFile,
    seed_types: options.seedTypes,
    ...(seedResult ? { seed_result: seedResult } : {}),
    harness_result: harnessResult,
  };
  const ledgerNote = createLedgerNote(options.note, context, {
    title: options.name || planName,
    artifacts: [artifactDir],
    evidence: [
      `plan: ${planName}`,
      `harness ok: ${summary.ok}`,
      ...(options.seedTypes.length > 0
        ? [`seed: ${options.seedTypes.join(", ")}`]
        : []),
    ],
    validation: [`cocalc browser harness run --plan ${planName}`],
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
  writeJson(path.join(artifactDir, "run-plan-summary.json"), summary);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  console.log(`bug-hunt plan: ${planName}`);
  console.log(`artifact dir:  ${artifactDir}`);
  console.log(`ok:            ${summary.ok}`);
  if (options.seedTypes.length) {
    console.log(`seed:          ${options.seedTypes.join(", ")}`);
  }
}

module.exports = {
  buildHarnessArgs,
  createArtifactDirName,
  listAvailablePlans,
  parseArgs,
  planNameFromPath,
  resolvePlanFile,
  resolveSeedTypes,
  sanitizeSegment,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt run-plan error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
