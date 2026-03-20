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
  "launchpad-backup-snapshot-runs",
);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: launchpad-backup-snapshot.js [--project <id>] [--host <host>] [--api-url <url>] [--account-id <uuid>] [--timeout <duration>] [--run-root <path>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    project: "",
    host: "",
    apiUrl: "",
    accountId: "",
    timeout: "15m",
    runRoot: DEFAULT_RUN_ROOT,
    cleanupOnSuccess: true,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < normalizedArgv.length; i += 1) {
    const arg = normalizedArgv[i];
    if (arg === "--project") {
      options.project =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--project requires a value");
    } else if (arg === "--host") {
      options.host =
        `${normalizedArgv[++i] || ""}`.trim() ||
        usageAndExit("--host requires a value");
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
  return options;
}

function buildSentinel(now = Date.now()) {
  const stamp = new Date(now).toISOString();
  const payload = JSON.stringify(
    {
      workflow: "launchpad-backup-snapshot",
      timestamp: stamp,
    },
    null,
    2,
  );
  const suffix = stamp.replace(/[:.]/g, "-");
  return {
    payload: `${payload}\n`,
    livePath: `.bug-hunt-backup-${suffix}.txt`,
    restoredPath: `.bug-hunt-backup-restored-${suffix}.txt`,
    snapshotName: `bug-hunt-snapshot-${suffix}`,
  };
}

async function executeBackupSnapshotWorkflow(
  options,
  now = Date.now(),
  deps = {},
) {
  const runCli = deps.runCliJson || runCliJson;
  if (!deps.skipLocalPostgresEnv) {
    applyLocalPostgresEnv();
  }
  const runDir = createRunDir(options.runRoot, now);
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = new Date(now).toISOString();
  const sentinel = buildSentinel(now);
  const payloadFile = writeTempFile("cocalc-backup-snapshot", sentinel.payload);
  const result = {
    started_at: startedAt,
    finished_at: startedAt,
    run_dir: runDir,
    dry_run: options.dryRun,
    cleanup_on_success: options.cleanupOnSuccess,
    steps: [],
    project_id: options.project || "",
    live_path: sentinel.livePath,
    restored_path: sentinel.restoredPath,
    snapshot_name: sentinel.snapshotName,
    payload_bytes: Buffer.byteLength(sentinel.payload),
    backup_id: "",
  };

  const createdProjects = [];
  const pushStep = (name, data) => {
    result.steps.push({ name, ...data });
  };
  const cliBase = {
    apiUrl: options.apiUrl,
    accountId: options.accountId,
    timeout: options.timeout,
  };

  try {
    if (!options.project) {
      if (options.dryRun) {
        result.project_id = "planned-project";
        pushStep("create_project", {
          status: "planned",
          host: options.host || null,
        });
      } else {
        const args = ["project", "create", "Bug Hunt Backup Snapshot"];
        if (options.host) {
          args.push("--host", options.host);
        }
        const created = runCli(cliBase, args);
        result.project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.project_id);
        pushStep("create_project", {
          status: "ok",
          project_id: result.project_id,
        });
      }
    }
    if (!result.project_id) {
      result.project_id = options.project;
    }

    if (options.dryRun) {
      pushStep("seed_file", {
        status: "planned",
        project_id: result.project_id,
        path: sentinel.livePath,
      });
      pushStep("create_snapshot", {
        status: "planned",
        snapshot_name: sentinel.snapshotName,
      });
      pushStep("create_backup", { status: "planned" });
      pushStep("remove_live_file", { status: "planned" });
      pushStep("restore_backup", { status: "planned" });
      pushStep("verify_restored_file", { status: "planned" });
    } else {
      runCli(cliBase, [
        "project",
        "file",
        "put",
        payloadFile.file,
        sentinel.livePath,
        "--project",
        result.project_id,
      ]);
      pushStep("seed_file", {
        status: "ok",
        project_id: result.project_id,
        path: sentinel.livePath,
      });

      runCli(cliBase, [
        "project",
        "snapshot",
        "create",
        "--project",
        result.project_id,
        "--name",
        sentinel.snapshotName,
      ]);
      pushStep("create_snapshot", {
        status: "ok",
        snapshot_name: sentinel.snapshotName,
      });

      const snapshots = runCli(cliBase, [
        "project",
        "snapshot",
        "list",
        "--project",
        result.project_id,
      ]);
      const snapshotRows = Array.isArray(snapshots) ? snapshots : [];
      if (
        !snapshotRows.some(
          (row) => `${row.name ?? ""}` === sentinel.snapshotName,
        )
      ) {
        throw new Error("snapshot list did not include the created snapshot");
      }
      pushStep("verify_snapshot_list", {
        status: "ok",
        snapshot_name: sentinel.snapshotName,
      });

      const backup = runCli(cliBase, [
        "project",
        "backup",
        "create",
        "--project",
        result.project_id,
        "--wait",
      ]);
      pushStep("create_backup", {
        status: "ok",
        op_id: backup.op_id ?? null,
      });

      const backups = runCli(cliBase, [
        "project",
        "backup",
        "list",
        "--project",
        result.project_id,
        "--indexed-only",
      ]);
      const backupRows = Array.isArray(backups) ? backups : [];
      const latest = [...backupRows].sort((left, right) =>
        `${right.time ?? ""}`.localeCompare(`${left.time ?? ""}`),
      )[0];
      result.backup_id = `${latest?.backup_id ?? ""}`.trim();
      if (!result.backup_id) {
        throw new Error("backup list did not return a usable backup id");
      }
      pushStep("select_backup", {
        status: "ok",
        backup_id: result.backup_id,
      });

      runCli(cliBase, [
        "project",
        "file",
        "rm",
        sentinel.livePath,
        "--project",
        result.project_id,
        "--force",
      ]);
      pushStep("remove_live_file", {
        status: "ok",
        path: sentinel.livePath,
      });

      runCli(cliBase, [
        "project",
        "backup",
        "restore",
        "--project",
        result.project_id,
        "--backup-id",
        result.backup_id,
        "--path",
        sentinel.livePath,
        "--dest",
        sentinel.restoredPath,
        "--wait",
      ]);
      pushStep("restore_backup", {
        status: "ok",
        backup_id: result.backup_id,
      });

      const restored = runCli(cliBase, [
        "project",
        "file",
        "cat",
        sentinel.restoredPath,
        "--project",
        result.project_id,
      ]);
      const content = `${restored.content ?? ""}`;
      if (content !== sentinel.payload) {
        throw new Error("restored backup content did not match the sentinel");
      }
      pushStep("verify_restored_file", {
        status: "ok",
        path: sentinel.restoredPath,
      });
    }

    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : `${err}`;
  } finally {
    if (result.ok && options.cleanupOnSuccess && !options.dryRun) {
      for (const projectId of createdProjects) {
        try {
          runCli(cliBase, ["project", "delete", "--project", projectId]);
          pushStep("cleanup_project", {
            status: "ok",
            project_id: projectId,
          });
        } catch (err) {
          pushStep("cleanup_project", {
            status: "failed",
            project_id: projectId,
            error: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
    }
    result.finished_at = new Date().toISOString();
    result.summary_file = path.join(runDir, "run-summary.json");
    result.ledger_file = path.join(runDir, "run-ledger.json");
    writeJson(result.summary_file, result);
    writeJson(result.ledger_file, {
      run_dir: runDir,
      ok: result.ok,
      project_id: result.project_id,
      snapshot_name: result.snapshot_name,
      backup_id: result.backup_id,
      payload_bytes: result.payload_bytes,
      restored_path: result.restored_path,
    });
  }

  return result;
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeBackupSnapshotWorkflow(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`launchpad backup/snapshot: ${payload.run_dir}`);
  console.log(`status: ${payload.ok ? "ok" : "failed"}`);
  if (!payload.ok) {
    console.log(`error:  ${payload.error}`);
  }
  return payload;
}

module.exports = {
  buildSentinel,
  executeBackupSnapshotWorkflow,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(
      `bug-hunt launchpad-backup-snapshot error: ${err?.message ?? err}`,
    );
    process.exit(1);
  });
}
