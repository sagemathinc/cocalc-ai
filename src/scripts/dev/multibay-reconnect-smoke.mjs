#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SRC_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);

function usageAndExit(message, code = 1) {
  if (message) {
    console.error(message);
  }
  console.error(
    [
      "Usage: node scripts/dev/multibay-reconnect-smoke.mjs --project <project-id> [options]",
      "",
      "Options:",
      "  --project <id>              Project id to exercise",
      "  --host <name>              Host name to verify (repeatable; default: host1, host2)",
      "  --timeout <ms>             Root CLI/RPC timeout in milliseconds (default: 120000)",
      "  --tail <n>                 Number of runtime log lines to fetch (default: 40)",
      "  --no-restart               Skip pnpm dev:hub:restart before checks",
      "  --no-stop-start            Skip project stop/start cycle",
      "  --help                     Show this help",
      "",
      "This script refreshes dev:hub:env before each cocalc call and verifies",
      "the reconnect-sensitive control-plane paths on the local 3-bay stack:",
      "host list/get, project get/logs, project stop/start, and project exec.",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    projectId: "",
    hostNames: [],
    timeoutMs: 120_000,
    tail: 40,
    restart: true,
    stopStart: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    } else if (arg === "--project" && next) {
      options.projectId = next;
      i += 1;
    } else if (arg === "--host" && next) {
      options.hostNames.push(next);
      i += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--tail" && next) {
      options.tail = Number(next);
      i += 1;
    } else if (arg === "--no-restart") {
      options.restart = false;
    } else if (arg === "--no-stop-start") {
      options.stopStart = false;
    } else if (arg === "--help") {
      usageAndExit("", 0);
    } else {
      usageAndExit(`unknown argument: ${arg}`);
    }
  }

  if (!options.projectId.trim()) {
    usageAndExit("--project is required");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    usageAndExit("--timeout must be a positive number");
  }
  if (!Number.isFinite(options.tail) || options.tail <= 0) {
    usageAndExit("--tail must be a positive number");
  }
  if (!options.hostNames.length) {
    options.hostNames = ["host1", "host2"];
  }
  return options;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: SRC_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function spawnInherit(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: SRC_ROOT,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function runCocalcJson(cocalcArgs) {
  const cmd = [
    "cd",
    shellQuote(SRC_ROOT),
    "&&",
    'eval "$(pnpm -s dev:hub:env)"',
    "&&",
    "cocalc",
    ...cocalcArgs.map(shellQuote),
  ].join(" ");
  const result = await spawnCapture("bash", ["-lc", cmd]);
  if (result.code !== 0) {
    throw new Error(
      [
        `cocalc exited with code ${result.code}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `unable to parse cocalc JSON output: ${err}\n${result.stdout}`,
    );
  }
  if (!parsed?.ok) {
    throw new Error(JSON.stringify(parsed, null, 2));
  }
  return parsed;
}

function getData(result) {
  return result?.data ?? result;
}

function getState(result) {
  return `${getData(result)?.state ?? ""}`.trim();
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function jsonContains(value, needle) {
  return JSON.stringify(value).includes(needle);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
  const globalArgs = [
    "--json",
    "--timeout",
    `${timeoutSeconds}s`,
    "--rpc-timeout",
    `${timeoutSeconds}s`,
  ];
  const steps = [];

  const runStep = async (name, fn) => {
    const startedAt = new Date().toISOString();
    console.error(`[multibay-reconnect] ${name}: start`);
    try {
      const detail = await fn();
      const finishedAt = new Date().toISOString();
      steps.push({
        name,
        status: "ok",
        started_at: startedAt,
        finished_at: finishedAt,
        detail,
      });
      console.error(`[multibay-reconnect] ${name}: ok`);
      return detail;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const message = `${err?.stack ?? err}`;
      steps.push({
        name,
        status: "failed",
        started_at: startedAt,
        finished_at: finishedAt,
        error: message,
      });
      console.error(`[multibay-reconnect] ${name}: failed\n${message}`);
      throw err;
    }
  };

  if (options.restart) {
    await runStep("hub_restart", async () => {
      await spawnInherit("bash", [
        "-lc",
        `cd ${shellQuote(SRC_ROOT)} && pnpm dev:hub:restart`,
      ]);
      return { restarted: true };
    });
  }

  const hostList = await runStep("host_list", async () => {
    const result = await runCocalcJson([...globalArgs, "host", "list"]);
    for (const hostName of options.hostNames) {
      ensure(
        jsonContains(getData(result), hostName),
        `host list did not include ${hostName}`,
      );
    }
    return { host_names: options.hostNames };
  });

  const hosts = {};
  for (const hostName of options.hostNames) {
    hosts[hostName] = await runStep(`host_get:${hostName}`, async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "host",
        "get",
        hostName,
      ]);
      ensure(
        jsonContains(getData(result), hostName),
        `host get output did not mention ${hostName}`,
      );
      return {
        name: hostName,
        status: `${getData(result)?.status ?? ""}`.trim(),
        runtime_summary:
          getData(result)?.runtime_summary ?? getData(result)?.runtime ?? null,
      };
    });
  }

  const before = await runStep("project_get:before", async () => {
    const result = await runCocalcJson([
      ...globalArgs,
      "project",
      "get",
      "-w",
      options.projectId,
    ]);
    const state = getState(result);
    ensure(state.length > 0, "project get returned no state");
    return {
      project_id: options.projectId,
      state,
      host_id: `${getData(result)?.host_id ?? ""}`.trim(),
      bay_id: `${getData(result)?.bay_id ?? ""}`.trim(),
    };
  });

  const runtimeLog = await runStep("project_logs", async () => {
    const result = await runCocalcJson([
      ...globalArgs,
      "project",
      "logs",
      "-w",
      options.projectId,
      "--tail",
      `${Math.floor(options.tail)}`,
    ]);
    const text = `${getData(result)?.text ?? ""}`;
    return {
      lines_requested: Math.floor(options.tail),
      text_bytes: Buffer.byteLength(text, "utf8"),
      preview: text.slice(-400),
    };
  });

  if (options.stopStart) {
    await runStep("project_stop", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "stop",
        "-w",
        options.projectId,
        "--wait",
      ]);
      return {
        status: `${getData(result)?.status ?? ""}`.trim(),
        op_id: `${getData(result)?.op_id ?? ""}`.trim(),
      };
    });

    await runStep("project_get:after_stop", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "get",
        "-w",
        options.projectId,
      ]);
      const state = getState(result);
      ensure(
        state !== "running",
        `project still running after stop (state=${state})`,
      );
      return { state };
    });

    await runStep("project_start", async () => {
      const result = await runCocalcJson([
        ...globalArgs,
        "project",
        "start",
        "-w",
        options.projectId,
        "--wait",
      ]);
      return {
        status: `${getData(result)?.status ?? ""}`.trim(),
        op_id: `${getData(result)?.op_id ?? ""}`.trim(),
      };
    });
  }

  const after = await runStep("project_get:after", async () => {
    const result = await runCocalcJson([
      ...globalArgs,
      "project",
      "get",
      "-w",
      options.projectId,
    ]);
    const state = getState(result);
    ensure(
      state === "running",
      `project is not running after smoke (state=${state})`,
    );
    return {
      state,
      host_id: `${getData(result)?.host_id ?? ""}`.trim(),
      bay_id: `${getData(result)?.bay_id ?? ""}`.trim(),
    };
  });

  const execResult = await runStep("project_exec", async () => {
    const result = await runCocalcJson([
      ...globalArgs,
      "project",
      "exec",
      "-w",
      options.projectId,
      "--bash",
      "echo EXEC_OK && hostname && date -u +%FT%TZ",
    ]);
    const stdout = `${getData(result)?.stdout ?? ""}`;
    ensure(stdout.includes("EXEC_OK"), "project exec did not print EXEC_OK");
    return {
      exit_code: getData(result)?.exit_code ?? null,
      stdout,
      stderr: `${getData(result)?.stderr ?? ""}`,
    };
  });

  const summary = {
    ok: true,
    project_id: options.projectId,
    host_names: options.hostNames,
    restarted: options.restart,
    stop_start: options.stopStart,
    timeout_ms: options.timeoutMs,
    tail: options.tail,
    host_list: hostList,
    hosts,
    project_before: before,
    project_logs: runtimeLog,
    project_after: after,
    exec: {
      exit_code: execResult.exit_code,
      stdout_preview: execResult.stdout.trim(),
    },
    steps,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`multibay reconnect smoke failed: ${err?.stack ?? err}`);
  process.exit(1);
});
