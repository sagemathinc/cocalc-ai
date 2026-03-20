#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  ROOT,
  applyLocalPostgresEnv,
  createRunDir,
  runCliJson,
  writeJson,
  writeTempFile,
} = require("./launchpad-cli-helpers.js");

const DEFAULT_RUN_ROOT = path.join(
  ROOT,
  ".agents",
  "bug-hunt",
  "launchpad-benchmarks",
);
const DEFAULT_TIMEOUT = "90m";
const DEFAULT_SEED_TIMEOUT_SECONDS = 7200;
const DEFAULT_CACHE_MODE = "cold";
const WORKFLOWS = new Set(["backup", "move", "copy-path", "restore"]);
const WORKLOADS = new Set(["random-4g", "apt-jupyter"]);
const CACHE_MODES = new Set(["cold", "warm"]);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: launchpad-benchmark.js --workflow <backup|move|copy-path|restore> --workload <random-4g|apt-jupyter> [--project <id>] [--host <host>] [--src-project <id>] [--dest-project <id>] [--src-host <host>] [--dest-host <host>] [--cache-mode <cold|warm>] [--api-url <url>] [--account-id <uuid>] [--timeout <duration>] [--seed-timeout <seconds>] [--run-root <path>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parsePositiveInteger(raw, flag) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    usageAndExit(`${flag} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    workflow: "",
    workload: "",
    project: "",
    host: "",
    srcProject: "",
    destProject: "",
    srcHost: "",
    destHost: "",
    apiUrl: "",
    accountId: "",
    timeout: DEFAULT_TIMEOUT,
    seedTimeoutSeconds: DEFAULT_SEED_TIMEOUT_SECONDS,
    cacheMode: DEFAULT_CACHE_MODE,
    runRoot: DEFAULT_RUN_ROOT,
    cleanupOnSuccess: true,
    dryRun: false,
    json: false,
    verifyRestoredStart: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--workflow") {
      options.workflow =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--workflow requires a value");
    } else if (arg === "--workload") {
      options.workload =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--workload requires a value");
    } else if (arg === "--project") {
      options.project =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--project requires a value");
    } else if (arg === "--host") {
      options.host =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--host requires a value");
    } else if (arg === "--src-project") {
      options.srcProject =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--src-project requires a value");
    } else if (arg === "--dest-project") {
      options.destProject =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--dest-project requires a value");
    } else if (arg === "--src-host") {
      options.srcHost =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--src-host requires a value");
    } else if (arg === "--dest-host") {
      options.destHost =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--dest-host requires a value");
    } else if (arg === "--api-url") {
      options.apiUrl =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--api-url requires a value");
    } else if (arg === "--account-id") {
      options.accountId =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--account-id requires a value");
    } else if (arg === "--timeout") {
      options.timeout =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--timeout requires a value");
    } else if (arg === "--seed-timeout") {
      options.seedTimeoutSeconds = parsePositiveInteger(
        normalizedArgv[++i] || "",
        "--seed-timeout",
      );
    } else if (arg === "--cache-mode") {
      options.cacheMode =
        `${normalizedArgv[++i] || ""}`.trim().toLowerCase() ||
        usageAndExit("--cache-mode requires a value");
    } else if (arg === "--run-root") {
      options.runRoot = path.resolve(
        normalizedArgv[++i] || usageAndExit("--run-root requires a path"),
      );
    } else if (arg === "--cleanup-on-success") {
      options.cleanupOnSuccess = true;
    } else if (arg === "--no-cleanup-on-success") {
      options.cleanupOnSuccess = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verify-restored-start") {
      options.verifyRestoredStart = true;
    } else if (arg === "--help" || arg === "-h") {
      usageAndExit(undefined, 0);
    } else {
      usageAndExit(`Unknown argument: ${arg}`);
    }
  }

  if (!WORKFLOWS.has(options.workflow)) {
    usageAndExit(
      `--workflow must be one of ${Array.from(WORKFLOWS).join(", ")}`,
    );
  }
  if (!WORKLOADS.has(options.workload)) {
    usageAndExit(
      `--workload must be one of ${Array.from(WORKLOADS).join(", ")}`,
    );
  }
  if (!CACHE_MODES.has(options.cacheMode)) {
    usageAndExit(
      `--cache-mode must be one of ${Array.from(CACHE_MODES).join(", ")}`,
    );
  }
  if (options.workflow === "backup" && options.srcProject) {
    usageAndExit("--src-project is not used with --workflow backup");
  }
  if (options.workflow === "move" && !options.destHost) {
    usageAndExit("--dest-host is required for --workflow move");
  }
  if (options.workflow === "restore") {
    if (!options.srcProject && !options.srcHost) {
      usageAndExit(
        "--src-host is required for --workflow restore when --src-project is not provided",
      );
    }
    if (!options.destProject && !options.destHost) {
      usageAndExit(
        "--dest-host is required for --workflow restore when --dest-project is not provided",
      );
    }
  }
  return options;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\"'\"'`)}'`;
}

function buildWorkloadSpec(workload, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const markerPayload = JSON.stringify(
    { benchmark: workload, timestamp: new Date(now).toISOString() },
    null,
    2,
  );
  const benchmarkDir = `bug-hunt-benchmark-${stamp}`;
  const markerPath = `${benchmarkDir}/marker.json`;
  const restoreTargetPath = `bug-hunt-restore-target-${stamp}`;
  const restoreTargetShellPath = restoreTargetPath;
  if (workload === "random-4g") {
    const payloadPath = `${benchmarkDir}/random-4g.bin`;
    return {
      workload,
      benchmarkDir,
      markerPath,
      markerPayload: `${markerPayload}\n`,
      payloadPath,
      restoreSourcePath: payloadPath,
      restoreTargetPath: `${restoreTargetPath}/random-4g.bin`,
      restoreTargetShellPath: `${restoreTargetShellPath}/random-4g.bin`,
      prepareBash: [
        "set -euo pipefail",
        `mkdir -p ${shellQuote(benchmarkDir)}`,
        `cat > ${shellQuote(markerPath)} <<'EOF'`,
        markerPayload,
        "EOF",
        `dd if=/dev/urandom of=${shellQuote(payloadPath)} bs=16M count=256 status=progress`,
        "sync",
      ].join("\n"),
      inspectBash: [
        "set -euo pipefail",
        `stat -c 'payload_bytes=%s' ${shellQuote(payloadPath)}`,
        `sha256sum ${shellQuote(markerPath)}`,
        `stat -c 'marker_bytes=%s' ${shellQuote(markerPath)}`,
        "df -B1 . | tail -n +2",
      ].join("\n"),
      verifyPaths: [markerPath, payloadPath],
    };
  }
  return {
    workload,
    benchmarkDir,
    markerPath,
    markerPayload: `${markerPayload}\n`,
    restoreSourcePath: benchmarkDir,
    restoreTargetPath,
    restoreTargetShellPath,
    prepareBash: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
      `mkdir -p ${shellQuote(benchmarkDir)}`,
      `cat > ${shellQuote(markerPath)} <<'EOF'`,
      markerPayload,
      "EOF",
      "apt-get update",
      "apt-get install -y jupyter",
      "sync",
    ].join("\n"),
    inspectBash: [
      "set -euo pipefail",
      "jupyter --version || true",
      'du -sb "$HOME/.local" 2>/dev/null || true',
      'find "$HOME/.local" -type f 2>/dev/null | wc -l || true',
      `sha256sum ${shellQuote(markerPath)}`,
    ].join("\n"),
    verifyPaths: [markerPath],
  };
}

function makeStep(name, startedAt, data = {}) {
  const finishedAt = new Date().toISOString();
  return {
    name,
    started_at: startedAt,
    finished_at: finishedAt,
    elapsed_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    ...data,
  };
}

function runProjectExec(cliBase, projectId, bash, timeoutSeconds) {
  const result = runCliJson(
    {
      ...cliBase,
      rpcTimeout: `${timeoutSeconds}s`,
    },
    [
      "project",
      "exec",
      "--project",
      projectId,
      "--bash",
      "--timeout",
      `${timeoutSeconds}`,
      bash,
    ],
  );
  if ((result?.exit_code ?? 0) !== 0) {
    const stderr = `${result?.stderr ?? ""}`.trim();
    const stdout = `${result?.stdout ?? ""}`.trim();
    const detail = stderr || stdout || `exit_code=${result?.exit_code}`;
    throw new Error(`project exec failed: ${detail}`);
  }
  return result;
}

function getProject(cliBase, projectId, runner = runCliJson) {
  return runner(cliBase, ["project", "get", "--project", projectId]);
}

async function ensureProjectRunning(cliBase, projectId, runner = runCliJson) {
  const project = getProject(cliBase, projectId, runner);
  if (`${project?.state ?? ""}`.trim().toLowerCase() === "running") {
    return { already_running: true, project };
  }
  const started = runner(cliBase, [
    "project",
    "start",
    "--project",
    projectId,
    "--wait",
  ]);
  return { already_running: false, started };
}

function verifyProjectPaths(cliBase, projectId, paths) {
  for (const filePath of paths) {
    runCliJson(cliBase, [
      "project",
      "exec",
      "--project",
      projectId,
      "--bash",
      "--timeout",
      "300",
      `test -e ${shellQuote(filePath)}`,
    ]);
  }
}

function selectLatestBackupId(backups) {
  const rows = Array.isArray(backups) ? backups : [];
  const latest = [...rows].sort((left, right) =>
    `${right.time ?? ""}`.localeCompare(`${left.time ?? ""}`),
  )[0];
  const backupId = `${latest?.backup_id ?? ""}`.trim();
  if (!backupId) {
    throw new Error("backup list did not return a usable backup id");
  }
  return backupId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRestorableBackupId(
  cliBase,
  projectId,
  wait = { attempts: 20, intervalMs: 3000 },
) {
  let lastIndexed = [];
  let lastDirect = [];
  for (let attempt = 1; attempt <= wait.attempts; attempt += 1) {
    const direct = runCliJson(cliBase, [
      "project",
      "backup",
      "list",
      "--project",
      projectId,
      "--limit",
      "100",
    ]);
    if (Array.isArray(direct) && direct.length > 0) {
      const candidateId = selectLatestBackupId(direct);
      try {
        runCliJson(cliBase, [
          "project",
          "backup",
          "files",
          "--project",
          projectId,
          "--backup-id",
          candidateId,
        ]);
      } catch (_err) {
        if (attempt < wait.attempts) {
          await sleep(wait.intervalMs);
          continue;
        }
        throw new Error(
          `backup ${candidateId} appeared in direct listing but never became readable`,
        );
      }
      return {
        id: candidateId,
        source: "direct",
        direct,
        indexed: lastIndexed,
      };
    }
    lastDirect = Array.isArray(direct) ? direct : [];

    const indexed = runCliJson(cliBase, [
      "project",
      "backup",
      "list",
      "--project",
      projectId,
      "--indexed-only",
      "--limit",
      "100",
    ]);
    lastIndexed = Array.isArray(indexed) ? indexed : [];

    if (attempt < wait.attempts) {
      await sleep(wait.intervalMs);
    }
  }
  throw new Error(
    `backup never appeared in direct listing (indexed backups=${lastIndexed.length}, direct backups=${lastDirect.length})`,
  );
}

function runHostSsh(cliBase, hostId, bash, timeoutSeconds = 900) {
  const host = runCliJson(cliBase, ["host", "get", hostId]);
  const sshHost = `${host?.public_ip ?? ""}`.trim();
  if (!sshHost) {
    throw new Error(`host ${hostId} does not have a public ip for ssh`);
  }
  const result = cp.spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ConnectTimeout=15",
      `ubuntu@${sshHost}`,
      bash,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutSeconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim() || `ssh exited with code ${result.status}`}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

function inspectHostRusticCache(cliBase, hostId) {
  const stdout = runHostSsh(
    cliBase,
    hostId,
    [
      "set -euo pipefail",
      'sudo -u cocalc-host -H python3 -c "import json,pathlib,subprocess; ' +
        "import os; os.chdir(pathlib.Path.home()); " +
        "root=pathlib.Path.home()/'.cache'/'rustic'; " +
        "root_exists=root.exists(); " +
        "entry_paths=[p for p in sorted(root.iterdir()) if p.is_dir() and p.name != 'CACHEDIR.TAG'] if root_exists else []; " +
        "entries=[p.name for p in entry_paths]; " +
        "total_bytes=sum(int(subprocess.check_output(['du','-sb', str(p)], text=True).split()[0]) for p in entry_paths); " +
        "print(json.dumps({'root': str(root), 'exists': root_exists, 'entry_count': len(entries), 'entries': entries[:20], 'total_bytes': total_bytes}))\"",
    ].join("\n"),
  );
  return JSON.parse(stdout || "{}");
}

function clearHostRusticCache(cliBase, hostId) {
  runHostSsh(
    cliBase,
    hostId,
    [
      "set -euo pipefail",
      'sudo -u cocalc-host -H bash -lc \'cd "$HOME" && mkdir -p "$HOME/.cache/rustic" && find "$HOME/.cache/rustic" -mindepth 1 -maxdepth 1 -exec rm -rf {} +\'',
    ].join("\n"),
  );
}

async function executeLaunchpadBenchmark(options, now = Date.now(), deps = {}) {
  const runCli = deps.runCliJson || runCliJson;
  if (!deps.skipLocalPostgresEnv) {
    applyLocalPostgresEnv();
  }
  const runDir = createRunDir(options.runRoot, now);
  fs.mkdirSync(runDir, { recursive: true });
  const workload = buildWorkloadSpec(options.workload, now);
  const startedAt = new Date(now).toISOString();
  const result = {
    started_at: startedAt,
    finished_at: startedAt,
    run_dir: runDir,
    workflow: options.workflow,
    workload: options.workload,
    dry_run: options.dryRun,
    cleanup_on_success: options.cleanupOnSuccess,
    steps: [],
    project_id: "",
    src_project_id: "",
    dest_project_id: "",
    marker_path: workload.markerPath,
    payload_path: workload.payloadPath ?? null,
    cache_mode: options.cacheMode,
  };
  const createdProjects = [];
  const cliBase = {
    apiUrl: options.apiUrl,
    accountId: options.accountId,
    timeout: options.timeout,
    rpcTimeout: options.timeout,
  };

  const pushStep = (name, data) => {
    result.steps.push(makeStep(name, new Date().toISOString(), data));
  };

  async function timeStep(name, fn, data = {}) {
    const stepStartedAt = new Date().toISOString();
    try {
      const value = await fn();
      result.steps.push(
        makeStep(name, stepStartedAt, { status: "ok", ...data }),
      );
      return value;
    } catch (err) {
      result.steps.push(
        makeStep(name, stepStartedAt, {
          status: "failed",
          error: err instanceof Error ? err.message : `${err}`,
          ...data,
        }),
      );
      throw err;
    }
  }

  try {
    if (options.dryRun) {
      if (options.workflow === "backup") {
        result.project_id = options.project || "planned-project";
        pushStep("prepare_workload", {
          status: "planned",
          project_id: result.project_id,
          workload: options.workload,
        });
        pushStep("run_backup", {
          status: "planned",
          project_id: result.project_id,
        });
      } else if (options.workflow === "move") {
        result.src_project_id = options.srcProject || "planned-src-project";
        pushStep("prepare_workload", {
          status: "planned",
          project_id: result.src_project_id,
          workload: options.workload,
        });
        pushStep("run_move", {
          status: "planned",
          project_id: result.src_project_id,
          dest_host: options.destHost,
        });
      } else if (options.workflow === "copy-path") {
        result.src_project_id = options.srcProject || "planned-src-project";
        result.dest_project_id = options.destProject || "planned-dest-project";
        pushStep("prepare_workload", {
          status: "planned",
          project_id: result.src_project_id,
          workload: options.workload,
        });
        pushStep("run_copy_path", {
          status: "planned",
          src_project_id: result.src_project_id,
          dest_project_id: result.dest_project_id,
        });
      } else {
        result.src_project_id = options.srcProject || "planned-src-project";
        result.dest_project_id = options.destProject || "planned-dest-project";
        pushStep("prepare_workload", {
          status: "planned",
          project_id: result.src_project_id,
          workload: options.workload,
        });
        pushStep("create_backup", {
          status: "planned",
          project_id: result.src_project_id,
        });
        pushStep("run_restore", {
          status: "planned",
          src_project_id: result.src_project_id,
          dest_project_id: result.dest_project_id,
          cache_mode: options.cacheMode,
        });
      }
      result.ok = true;
    } else if (options.workflow === "backup") {
      if (!options.project) {
        const created = await timeStep(
          "create_project",
          () => {
            const args = ["project", "create", "Bug Hunt Benchmark Backup"];
            if (options.host) {
              args.push("--host", options.host);
            }
            return runCli(cliBase, args);
          },
          { host: options.host || null },
        );
        result.project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.project_id);
      } else {
        result.project_id = options.project;
      }

      await timeStep("start_project", () =>
        ensureProjectRunning(cliBase, result.project_id),
      );

      const prep = await timeStep("prepare_workload", async () =>
        runProjectExec(
          cliBase,
          result.project_id,
          workload.prepareBash,
          options.seedTimeoutSeconds,
        ),
      );
      writeJson(path.join(runDir, "prepare-workload.json"), prep);

      const inspect = await timeStep("inspect_workload", async () =>
        runProjectExec(cliBase, result.project_id, workload.inspectBash, 600),
      );
      writeJson(path.join(runDir, "inspect-workload.json"), inspect);

      const backup = await timeStep("run_backup", () =>
        runCli(cliBase, [
          "project",
          "backup",
          "create",
          "--project",
          result.project_id,
          "--wait",
        ]),
      );
      result.backup_op_id = backup.op_id ?? null;

      const backups = await timeStep("list_indexed_backups", () =>
        runCli(cliBase, [
          "project",
          "backup",
          "list",
          "--project",
          result.project_id,
          "--indexed-only",
        ]),
      );
      writeJson(path.join(runDir, "indexed-backups.json"), backups);
      result.backup_id = selectLatestBackupId(backups);
      result.ok = true;
    } else if (options.workflow === "move") {
      if (!options.srcProject) {
        const created = await timeStep(
          "create_src_project",
          () => {
            const args = ["project", "create", "Bug Hunt Benchmark Move"];
            if (options.srcHost) {
              args.push("--host", options.srcHost);
            }
            return runCli(cliBase, args);
          },
          { host: options.srcHost || null },
        );
        result.src_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.src_project_id);
      } else {
        result.src_project_id = options.srcProject;
      }

      await timeStep("start_src_project", () =>
        ensureProjectRunning(cliBase, result.src_project_id),
      );

      const prep = await timeStep("prepare_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.prepareBash,
          options.seedTimeoutSeconds,
        ),
      );
      writeJson(path.join(runDir, "prepare-workload.json"), prep);

      const inspect = await timeStep("inspect_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.inspectBash,
          600,
        ),
      );
      writeJson(path.join(runDir, "inspect-workload.json"), inspect);

      const move = await timeStep("run_move", () =>
        runCli(cliBase, [
          "project",
          "move",
          "--project",
          result.src_project_id,
          "--host",
          options.destHost,
          "--wait",
        ]),
      );
      result.move_op_id = move.op_id ?? null;
      verifyProjectPaths(cliBase, result.src_project_id, workload.verifyPaths);
      result.ok = true;
    } else if (options.workflow === "copy-path") {
      if (!options.srcProject) {
        const created = await timeStep(
          "create_src_project",
          () => {
            const args = ["project", "create", "Bug Hunt Benchmark Copy Src"];
            if (options.srcHost) {
              args.push("--host", options.srcHost);
            }
            return runCli(cliBase, args);
          },
          { host: options.srcHost || null },
        );
        result.src_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.src_project_id);
      } else {
        result.src_project_id = options.srcProject;
      }
      if (!options.destProject) {
        const created = await timeStep(
          "create_dest_project",
          () => {
            const args = ["project", "create", "Bug Hunt Benchmark Copy Dest"];
            if (options.destHost) {
              args.push("--host", options.destHost);
            }
            return runCli(cliBase, args);
          },
          { host: options.destHost || null },
        );
        result.dest_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.dest_project_id);
      } else {
        result.dest_project_id = options.destProject;
      }

      await timeStep("start_src_project", () =>
        ensureProjectRunning(cliBase, result.src_project_id),
      );
      await timeStep("start_dest_project", () =>
        ensureProjectRunning(cliBase, result.dest_project_id),
      );

      const prep = await timeStep("prepare_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.prepareBash,
          options.seedTimeoutSeconds,
        ),
      );
      writeJson(path.join(runDir, "prepare-workload.json"), prep);

      const inspect = await timeStep("inspect_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.inspectBash,
          600,
        ),
      );
      writeJson(path.join(runDir, "inspect-workload.json"), inspect);

      const copy = await timeStep("run_copy_path", () =>
        runCli(cliBase, [
          "project",
          "copy-path",
          "--src-project",
          result.src_project_id,
          "--src",
          workload.markerPath,
          "--dest-project",
          result.dest_project_id,
          "--dest",
          workload.markerPath,
          "--wait",
        ]),
      );
      result.copy_op_id = copy.op_id ?? null;
      verifyProjectPaths(cliBase, result.dest_project_id, [
        workload.markerPath,
      ]);
      result.ok = true;
    } else {
      if (!options.srcProject) {
        const created = await timeStep(
          "create_src_project",
          () => {
            const args = [
              "project",
              "create",
              "Bug Hunt Benchmark Restore Src",
            ];
            if (options.srcHost) {
              args.push("--host", options.srcHost);
            }
            return runCli(cliBase, args);
          },
          { host: options.srcHost || null },
        );
        result.src_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.src_project_id);
      } else {
        result.src_project_id = options.srcProject;
      }

      await timeStep("start_src_project", () =>
        ensureProjectRunning(cliBase, result.src_project_id),
      );

      const prep = await timeStep("prepare_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.prepareBash,
          options.seedTimeoutSeconds,
        ),
      );
      writeJson(path.join(runDir, "prepare-workload.json"), prep);

      const inspect = await timeStep("inspect_workload", async () =>
        runProjectExec(
          cliBase,
          result.src_project_id,
          workload.inspectBash,
          600,
        ),
      );
      writeJson(path.join(runDir, "inspect-workload.json"), inspect);

      const backup = await timeStep("create_backup", () =>
        runCli(cliBase, [
          "project",
          "backup",
          "create",
          "--project",
          result.src_project_id,
          "--wait",
        ]),
      );
      result.backup_op_id = backup.op_id ?? null;

      const backupSelection = await timeStep("select_restorable_backup", () =>
        waitForRestorableBackupId(cliBase, result.src_project_id),
      );
      writeJson(
        path.join(runDir, "indexed-backups.json"),
        backupSelection.indexed ?? [],
      );
      writeJson(
        path.join(runDir, "direct-backups.json"),
        backupSelection.direct ?? [],
      );
      result.backup_id = backupSelection.id;
      result.backup_id_source = backupSelection.source;

      result.dest_project_id = options.destProject || result.src_project_id;
      const destHostId = options.destHost || options.srcHost || null;
      if (destHostId) {
        const beforeCache = await timeStep(
          "inspect_dest_cache_before_restore",
          () => inspectHostRusticCache(cliBase, destHostId),
        );
        writeJson(
          path.join(runDir, "dest-cache-before-restore.json"),
          beforeCache,
        );
      }

      if (destHostId && options.cacheMode === "cold") {
        await timeStep("clear_dest_rustic_cache", () => {
          clearHostRusticCache(cliBase, destHostId);
        });
        const afterClear = await timeStep(
          "inspect_dest_cache_after_clear",
          () => inspectHostRusticCache(cliBase, destHostId),
        );
        writeJson(path.join(runDir, "dest-cache-after-clear.json"), afterClear);
      }

      await timeStep("prepare_restore_target", async () =>
        runProjectExec(
          cliBase,
          result.dest_project_id,
          [
            "set -euo pipefail",
            `rm -rf ${shellQuote(workload.restoreTargetShellPath)}`,
            workload.payloadPath
              ? `mkdir -p ${shellQuote(path.posix.dirname(workload.restoreTargetShellPath))}`
              : `mkdir -p ${shellQuote(workload.restoreTargetShellPath)}`,
          ].join("\n"),
          300,
        ),
      );

      if (options.cacheMode === "warm") {
        await timeStep("warmup_restore", () =>
          runCli(cliBase, [
            "project",
            "backup",
            "restore",
            "--project",
            result.dest_project_id,
            "--backup-id",
            result.backup_id,
            "--path",
            workload.restoreSourcePath,
            "--dest",
            `${workload.restoreTargetPath}-warmup`,
            "--wait",
          ]),
        );
        await timeStep("cleanup_warmup_restore_target", async () =>
          runProjectExec(
            cliBase,
            result.dest_project_id,
            `rm -rf ${shellQuote(`${workload.restoreTargetShellPath}-warmup`)}`,
            300,
          ),
        );
        if (destHostId) {
          const afterWarmup = await timeStep(
            "inspect_dest_cache_after_warmup",
            () => inspectHostRusticCache(cliBase, destHostId),
          );
          writeJson(
            path.join(runDir, "dest-cache-after-warmup.json"),
            afterWarmup,
          );
        }
      }

      const restored = await timeStep("run_restore", () =>
        runCli(cliBase, [
          "project",
          "backup",
          "restore",
          "--project",
          result.dest_project_id,
          "--backup-id",
          result.backup_id,
          "--path",
          workload.restoreSourcePath,
          "--dest",
          workload.restoreTargetPath,
          "--wait",
        ]),
      );
      result.restore_op_id = restored.op_id ?? null;

      if (destHostId) {
        const afterRestore = await timeStep(
          "inspect_dest_cache_after_restore",
          () => inspectHostRusticCache(cliBase, destHostId),
        );
        writeJson(
          path.join(runDir, "dest-cache-after-restore.json"),
          afterRestore,
        );
      }

      const restoreVerifyPaths = workload.payloadPath
        ? [workload.restoreTargetShellPath]
        : workload.verifyPaths.map((filePath) =>
            filePath.replace(
              workload.benchmarkDir,
              workload.restoreTargetShellPath,
            ),
          );
      verifyProjectPaths(cliBase, result.dest_project_id, restoreVerifyPaths);

      const restoredInspect = await timeStep(
        "inspect_restored_workload",
        async () =>
          runProjectExec(
            cliBase,
            result.dest_project_id,
            [
              "set -euo pipefail",
              workload.payloadPath
                ? `stat -c 'restore_payload_bytes=%s' ${shellQuote(
                    restoreVerifyPaths[0],
                  )}`
                : `stat -c 'restore_marker_bytes=%s' ${shellQuote(
                    restoreVerifyPaths[0],
                  )}`,
              workload.payloadPath
                ? `sha256sum ${shellQuote(restoreVerifyPaths[0])}`
                : 'du -sb "$HOME/.local" 2>/dev/null || true',
            ].join("\n"),
            600,
          ),
      );
      writeJson(
        path.join(runDir, "inspect-restored-workload.json"),
        restoredInspect,
      );

      if (options.verifyRestoredStart) {
        await timeStep("start_restored_project", () =>
          ensureProjectRunning(cliBase, result.dest_project_id),
        );
      }
      result.ok = true;
    }
  } finally {
    if (options.cleanupOnSuccess && !options.dryRun && result.ok === true) {
      for (const projectId of createdProjects.reverse()) {
        try {
          runCli(cliBase, [
            "project",
            "delete",
            "--project",
            projectId,
            "--hard",
            "--purge-backups-now",
            "--wait",
            "--yes",
          ]);
        } catch (err) {
          result.cleanup_error = err instanceof Error ? err.message : `${err}`;
          break;
        }
      }
    }
    result.finished_at = new Date().toISOString();
    result.summary_file = path.join(runDir, "run-summary.json");
    result.ledger_file = path.join(runDir, "run-ledger.json");
    writeJson(result.summary_file, result);
    writeJson(result.ledger_file, {
      workflow: result.workflow,
      workload: result.workload,
      started_at: result.started_at,
      finished_at: result.finished_at,
      ok: result.ok ?? false,
      run_dir: runDir,
      cleanup_error: result.cleanup_error ?? null,
      step_count: result.steps.length,
    });
  }

  return result;
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeLaunchpadBenchmark(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`launchpad benchmark: ${payload.run_dir}`);
  console.log(`workflow: ${payload.workflow}`);
  console.log(`workload: ${payload.workload}`);
  console.log(`ok: ${payload.ok ? "yes" : "no"}`);
  return payload;
}

module.exports = {
  buildWorkloadSpec,
  ensureProjectRunning,
  executeLaunchpadBenchmark,
  getProject,
  main,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-benchmark error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
