#!/usr/bin/env node
"use strict";

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
const WORKFLOWS = new Set(["backup", "move", "copy-path"]);
const WORKLOADS = new Set(["random-4g", "apt-jupyter"]);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: launchpad-benchmark.js --workflow <backup|move|copy-path> --workload <random-4g|apt-jupyter> [--project <id>] [--host <host>] [--src-project <id>] [--dest-project <id>] [--src-host <host>] [--dest-host <host>] [--api-url <url>] [--account-id <uuid>] [--timeout <duration>] [--seed-timeout <seconds>] [--run-root <path>] [--dry-run] [--json]",
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
    runRoot: DEFAULT_RUN_ROOT,
    cleanupOnSuccess: true,
    dryRun: false,
    json: false,
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
  if (options.workflow === "backup" && options.srcProject) {
    usageAndExit("--src-project is not used with --workflow backup");
  }
  if (options.workflow === "move" && !options.destHost) {
    usageAndExit("--dest-host is required for --workflow move");
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
  const markerPath = `/tmp/bug-hunt-benchmark-marker-${stamp}.json`;
  if (workload === "random-4g") {
    const payloadPath = `/tmp/bug-hunt-random-4g-${stamp}.bin`;
    return {
      workload,
      markerPath,
      markerPayload: `${markerPayload}\n`,
      payloadPath,
      prepareBash: [
        "set -euo pipefail",
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
    markerPath,
    markerPayload: `${markerPayload}\n`,
    prepareBash: [
      "set -euo pipefail",
      "export DEBIAN_FRONTEND=noninteractive",
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
  return runCliJson(
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
      } else {
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
        runCli(cliBase, [
          "project",
          "start",
          "--project",
          result.project_id,
          "--wait",
        ]),
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
        runCli(cliBase, [
          "project",
          "start",
          "--project",
          result.src_project_id,
          "--wait",
        ]),
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
    } else {
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
        runCli(cliBase, [
          "project",
          "start",
          "--project",
          result.src_project_id,
          "--wait",
        ]),
      );
      await timeStep("start_dest_project", () =>
        runCli(cliBase, [
          "project",
          "start",
          "--project",
          result.dest_project_id,
          "--wait",
        ]),
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
    }
  } finally {
    if (options.cleanupOnSuccess && !options.dryRun) {
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
  executeLaunchpadBenchmark,
  main,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-benchmark error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
