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
  "launchpad-copy-path-runs",
);

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    "Usage: launchpad-copy-path.js [--src-project <id>] [--dest-project <id>] [--src-host <host>] [--dest-host <host>] [--api-url <url>] [--account-id <uuid>] [--timeout <duration>] [--run-root <path>] [--dry-run] [--json]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const normalizedArgv = [...argv];
  while (normalizedArgv[0] === "--") {
    normalizedArgv.shift();
  }
  const options = {
    srcProject: "",
    destProject: "",
    srcHost: "",
    destHost: "",
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
    if (arg === "--src-project") {
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
      workflow: "launchpad-copy-path",
      timestamp: stamp,
    },
    null,
    2,
  );
  return {
    payload: `${payload}\n`,
    srcPath: `.bug-hunt-copy-path-${stamp.replace(/[:.]/g, "-")}.txt`,
    destPath: `.bug-hunt-copy-path-dest-${stamp.replace(/[:.]/g, "-")}.txt`,
  };
}

async function executeCopyPathWorkflow(options, now = Date.now(), deps = {}) {
  const runCli = deps.runCliJson || runCliJson;
  if (!deps.skipLocalPostgresEnv) {
    applyLocalPostgresEnv();
  }
  const runDir = createRunDir(options.runRoot, now);
  fs.mkdirSync(runDir, { recursive: true });
  const startedAt = new Date(now).toISOString();
  const sentinel = buildSentinel(now);
  const payloadFile = writeTempFile("cocalc-copy-path", sentinel.payload);
  const result = {
    started_at: startedAt,
    finished_at: startedAt,
    run_dir: runDir,
    dry_run: options.dryRun,
    cleanup_on_success: options.cleanupOnSuccess,
    steps: [],
    src_project_id: options.srcProject || "",
    dest_project_id: options.destProject || "",
    src_path: sentinel.srcPath,
    dest_path: sentinel.destPath,
    payload_bytes: Buffer.byteLength(sentinel.payload),
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
    if (!options.srcProject) {
      if (options.dryRun) {
        result.src_project_id = "planned-src-project";
        pushStep("create_src_project", {
          status: "planned",
          host: options.srcHost || null,
        });
      } else {
        const args = ["project", "create", "Bug Hunt Copy Src"];
        if (options.srcHost) {
          args.push("--host", options.srcHost);
        }
        const created = runCli(cliBase, args);
        result.src_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.src_project_id);
        pushStep("create_src_project", {
          status: "ok",
          project_id: result.src_project_id,
        });
      }
    }
    if (!result.src_project_id) {
      result.src_project_id = options.srcProject;
    }

    if (!options.destProject) {
      if (options.dryRun) {
        result.dest_project_id = "planned-dest-project";
        pushStep("create_dest_project", {
          status: "planned",
          host: options.destHost || null,
        });
      } else {
        const args = ["project", "create", "Bug Hunt Copy Dest"];
        if (options.destHost) {
          args.push("--host", options.destHost);
        }
        const created = runCli(cliBase, args);
        result.dest_project_id = `${created.project_id ?? ""}`.trim();
        createdProjects.push(result.dest_project_id);
        pushStep("create_dest_project", {
          status: "ok",
          project_id: result.dest_project_id,
        });
      }
    }
    if (!result.dest_project_id) {
      result.dest_project_id = options.destProject;
    }

    if (options.dryRun) {
      pushStep("seed_source_file", {
        status: "planned",
        project_id: result.src_project_id,
        path: sentinel.srcPath,
      });
      pushStep("copy_path", {
        status: "planned",
        src_project_id: result.src_project_id,
        dest_project_id: result.dest_project_id,
      });
      pushStep("verify_dest_file", {
        status: "planned",
        project_id: result.dest_project_id,
        path: sentinel.destPath,
      });
    } else {
      runCli(cliBase, [
        "project",
        "file",
        "put",
        payloadFile.file,
        sentinel.srcPath,
        "--project",
        result.src_project_id,
      ]);
      pushStep("seed_source_file", {
        status: "ok",
        project_id: result.src_project_id,
        path: sentinel.srcPath,
      });

      const copy = runCli(cliBase, [
        "project",
        "copy-path",
        "--src-project",
        result.src_project_id,
        "--src",
        sentinel.srcPath,
        "--dest-project",
        result.dest_project_id,
        "--dest",
        sentinel.destPath,
        "--wait",
      ]);
      pushStep("copy_path", {
        status: "ok",
        op_id: copy.op_id ?? null,
      });

      const cat = runCli(cliBase, [
        "project",
        "file",
        "cat",
        sentinel.destPath,
        "--project",
        result.dest_project_id,
      ]);
      const content = `${cat.content ?? ""}`;
      if (content !== sentinel.payload) {
        throw new Error("destination content did not match source payload");
      }
      pushStep("verify_dest_file", {
        status: "ok",
        project_id: result.dest_project_id,
        path: sentinel.destPath,
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
      src_project_id: result.src_project_id,
      dest_project_id: result.dest_project_id,
      src_path: result.src_path,
      dest_path: result.dest_path,
      payload_bytes: result.payload_bytes,
    });
  }

  return result;
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeCopyPathWorkflow(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`launchpad copy-path: ${payload.run_dir}`);
  console.log(`status: ${payload.ok ? "ok" : "failed"}`);
  if (!payload.ok) {
    console.log(`error:  ${payload.error}`);
  }
  return payload;
}

module.exports = {
  buildSentinel,
  executeCopyPathWorkflow,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-copy-path error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
