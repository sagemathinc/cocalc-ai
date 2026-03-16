#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  refreshLiveContextTarget,
  writeContextFileIfChanged,
} = require("./context-target.js");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CONTEXT_FILE = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "current-context.json",
);
const DEFAULT_PROJECT_BASE_DIR = ".bug-hunt/fixtures";
const DEFAULT_LITE_BASE_DIR = path.join(
  os.homedir(),
  "scratch",
  "cocalc-bug-hunt",
  "fixtures",
);
const FIXTURE_TYPES = ["chat", "jupyter", "tasks", "files", "whiteboard"];

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: seed.js [--context-file <path>] [--base-dir <path>] [--name <label>] [--json] [--no-open] [--all] [--chat] [--jupyter] [--tasks] [--files] [--whiteboard]",
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
    baseDir: "",
    baseDirProvided: false,
    name: "",
    json: false,
    open: true,
    all: false,
    fixtures: new Set(),
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--context-file") {
      options.contextFile = path.resolve(
        normalizedArgv[++i] || usageAndExit("--context-file requires a path"),
      );
    } else if (arg === "--base-dir") {
      options.baseDir =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--base-dir requires a path");
      options.baseDirProvided = true;
    } else if (arg === "--name") {
      options.name = `${normalizedArgv[++i] || ""}`.trim();
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--chat") {
      options.fixtures.add("chat");
    } else if (arg === "--jupyter") {
      options.fixtures.add("jupyter");
    } else if (arg === "--tasks") {
      options.fixtures.add("tasks");
    } else if (arg === "--files") {
      options.fixtures.add("files");
    } else if (arg === "--whiteboard") {
      options.fixtures.add("whiteboard");
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }
  return {
    ...options,
    fixtures: resolveFixtureTypes(options),
  };
}

function resolveFixtureTypes(options) {
  const values = options.all
    ? FIXTURE_TYPES
    : Array.from(options.fixtures ?? []).sort();
  if (!values.length) {
    usageAndExit(
      "select at least one fixture type via --all, --chat, --jupyter, --tasks, --files, or --whiteboard",
    );
  }
  return values;
}

function sanitizeSegment(value) {
  return `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createSeedDirName(now, name) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const label = sanitizeSegment(name);
  return label ? `${stamp}-${label}` : stamp;
}

function normalizeProjectPath(value) {
  const raw = `${value ?? ""}`.trim();
  if (!raw) {
    usageAndExit("--base-dir must not be empty");
  }
  if (raw.startsWith("/")) {
    usageAndExit("--base-dir must be project-relative, not absolute");
  }
  const normalized = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (normalized === "." || normalized === "") {
    usageAndExit("--base-dir must not resolve to the project root");
  }
  if (normalized.startsWith("../") || normalized === "..") {
    usageAndExit("--base-dir must stay inside the project");
  }
  return normalized.replace(/^\.\/+/, "");
}

function resolveSeedBaseDir(mode, baseDir, baseDirProvided) {
  const rawBaseDir = `${baseDir ?? ""}`.trim();
  if (mode === "lite") {
    const effective = rawBaseDir || DEFAULT_LITE_BASE_DIR;
    if (path.isAbsolute(effective)) {
      return path.resolve(effective);
    }
    if (!baseDirProvided) {
      return path.resolve(DEFAULT_LITE_BASE_DIR);
    }
  }
  return normalizeProjectPath(rawBaseDir || DEFAULT_PROJECT_BASE_DIR);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to read ${label}: ${detail}`);
  }
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

function buildFixturePlan(seedRoot, now, fixtureTypes) {
  const taskId = crypto.randomUUID();
  const taskId2 = crypto.randomUUID();
  const boardPageId = `page-${crypto.randomUUID().slice(0, 8)}`;
  const boardNoteId = `note-${crypto.randomUUID().slice(0, 8)}`;
  const fixtures = [];
  if (fixtureTypes.includes("chat")) {
    fixtures.push({
      type: "chat",
      upload: [
        {
          dest: joinSeedPath(seedRoot, "scratch.chat"),
          content: "",
        },
      ],
      open_paths: [joinSeedPath(seedRoot, "scratch.chat")],
    });
  }
  if (fixtureTypes.includes("jupyter")) {
    fixtures.push({
      type: "jupyter",
      upload: [
        {
          dest: joinSeedPath(seedRoot, "scratch.ipynb"),
          content: JSON.stringify(
            {
              cells: [
                {
                  cell_type: "code",
                  execution_count: null,
                  metadata: {},
                  outputs: [],
                  source: ["# bug-hunt fixture\n", "2 + 3\n"],
                },
              ],
              metadata: {
                kernelspec: {
                  name: "python3",
                  display_name: "Python 3 (ipykernel)",
                  language: "python",
                },
                language_info: {
                  name: "python",
                },
              },
              nbformat: 4,
              nbformat_minor: 5,
            },
            null,
            2,
          ),
        },
      ],
      open_paths: [joinSeedPath(seedRoot, "scratch.ipynb")],
    });
  }
  if (fixtureTypes.includes("tasks")) {
    fixtures.push({
      type: "tasks",
      upload: [
        {
          dest: joinSeedPath(seedRoot, "scratch.tasks"),
          content:
            `${JSON.stringify({
              desc: "Investigate this bug-hunt task",
              position: 0,
              last_edited: now,
              task_id: taskId,
            })}\n` +
            `${JSON.stringify({
              desc: "Compare sort, filter, and edit behavior",
              position: 1,
              last_edited: now + 1,
              task_id: taskId2,
            })}\n`,
        },
      ],
      open_paths: [joinSeedPath(seedRoot, "scratch.tasks")],
    });
  }
  if (fixtureTypes.includes("files")) {
    fixtures.push({
      type: "files",
      upload: [
        {
          dest: joinSeedPath(seedRoot, "files", "README.md"),
          content:
            "# Bug-hunt file fixture\n\nUse this directory for explorer and editor repros.\n",
        },
        {
          dest: joinSeedPath(seedRoot, "files", "alpha.txt"),
          content: "alpha\n",
        },
        {
          dest: joinSeedPath(seedRoot, "files", "nested", "beta.py"),
          content: "print('beta')\n",
        },
      ],
      open_paths: [joinSeedPath(seedRoot, "files", "README.md")],
      directory_path: joinSeedPath(seedRoot, "files"),
    });
  }
  if (fixtureTypes.includes("whiteboard")) {
    fixtures.push({
      type: "whiteboard",
      upload: [
        {
          dest: joinSeedPath(seedRoot, "scratch.board"),
          content:
            `${JSON.stringify({
              id: boardPageId,
              type: "page",
              z: 0,
              data: { pos: 0 },
            })}\n` +
            `${JSON.stringify({
              id: boardNoteId,
              type: "note",
              z: 1,
              page: boardPageId,
              x: 80,
              y: 80,
              w: 280,
              h: 120,
              str: "Bug-hunt whiteboard fixture",
            })}\n`,
        },
      ],
      open_paths: [joinSeedPath(seedRoot, "scratch.board")],
    });
  }
  return fixtures;
}

function joinSeedPath(base, ...parts) {
  return path.posix.join(`${base}`.replaceAll("\\", "/"), ...parts);
}

function shouldWriteFixturesLocally(context, seedRoot) {
  return context.mode === "lite" && path.isAbsolute(seedRoot);
}

function uploadFixtures(context, projectId, tmpRoot, fixtures, seedRoot) {
  if (shouldWriteFixturesLocally(context, seedRoot)) {
    const uploaded = [];
    for (const fixture of fixtures) {
      for (const entry of fixture.upload) {
        fs.mkdirSync(path.dirname(entry.dest), { recursive: true });
        fs.writeFileSync(entry.dest, entry.content);
        uploaded.push({
          type: fixture.type,
          dest: entry.dest,
          bytes: Buffer.byteLength(entry.content),
          result: {
            project_id: projectId,
            dest: entry.dest,
            bytes: Buffer.byteLength(entry.content),
            status: "written-local",
          },
        });
      }
    }
    return uploaded;
  }
  const uploaded = [];
  for (const fixture of fixtures) {
    for (const entry of fixture.upload) {
      const local = path.join(tmpRoot, entry.dest.replaceAll("/", "__"));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, entry.content);
      const result = runCliJson(context, [
        "project",
        "file",
        "put",
        "-w",
        projectId,
        local,
        entry.dest,
      ]);
      uploaded.push({
        type: fixture.type,
        dest: entry.dest,
        bytes: Buffer.byteLength(entry.content),
        result,
      });
    }
  }
  return uploaded;
}

function openFixturePaths(context, projectId, openPaths) {
  if (!openPaths.length) return undefined;
  return runCliJson(context, ["browser", "open", projectId, ...openPaths]);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const originalContext = readJson(options.contextFile, "bug-hunt context");
  const context = refreshLiveContextTarget(originalContext);
  writeContextFileIfChanged(options.contextFile, originalContext, context);
  const projectId =
    `${context.project_id || context.exports?.COCALC_PROJECT_ID || ""}`.trim();
  if (!projectId) {
    throw new Error("current context does not include a project id");
  }
  const now = Date.now();
  const baseDir = resolveSeedBaseDir(
    context.mode,
    options.baseDir,
    options.baseDirProvided,
  );
  const seedRoot = path.isAbsolute(baseDir)
    ? path.join(baseDir, createSeedDirName(now, options.name))
    : path.posix.join(baseDir, createSeedDirName(now, options.name));
  const fixtures = buildFixturePlan(seedRoot, now, options.fixtures);
  const tmpRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-seed-"),
  );
  const summary = {
    mode: context.mode ?? "",
    browser_mode: context.browser_mode ?? "",
    browser_id: context.browser_id ?? "",
    project_id: projectId,
    seed_root: seedRoot,
    cleanup_hint: `rm -rf ${seedRoot}`,
    fixtures: fixtures.map((fixture) => ({
      type: fixture.type,
      created_paths: fixture.upload.map((entry) => entry.dest),
      open_paths: fixture.open_paths,
      ...(fixture.directory_path
        ? { directory_path: fixture.directory_path }
        : {}),
    })),
    uploaded: [],
    opened_paths: [],
    warning: "",
  };
  try {
    summary.uploaded = uploadFixtures(
      context,
      projectId,
      tmpRoot,
      fixtures,
      seedRoot,
    );
    const openPaths = fixtures.flatMap((fixture) => fixture.open_paths);
    summary.opened_paths = openPaths;
    if (!options.open) {
      summary.warning = "browser open skipped by --no-open";
    } else if (!context.browser_id) {
      summary.warning =
        "current context has no browser_id; fixtures were created but not opened";
    } else if (openPaths.length > 0) {
      const openResult = openFixturePaths(context, projectId, openPaths);
      summary.open_result = openResult;
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  console.log(`bug-hunt seed: ${seedRoot}`);
  console.log(
    `fixtures: ${fixtures.map((fixture) => fixture.type).join(", ")}`,
  );
  console.log(`uploaded: ${summary.uploaded.length}`);
  if (summary.warning) {
    console.log(`warning: ${summary.warning}`);
  } else {
    console.log(`opened: ${summary.opened_paths.length}`);
  }
}

module.exports = {
  FIXTURE_TYPES,
  buildFixturePlan,
  createSeedDirName,
  normalizeProjectPath,
  parseArgs,
  resolveSeedBaseDir,
  resolveFixtureTypes,
  sanitizeSegment,
  shouldWriteFixturesLocally,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`bug-hunt seed error: ${err?.message ?? err}`);
    process.exit(1);
  }
}
