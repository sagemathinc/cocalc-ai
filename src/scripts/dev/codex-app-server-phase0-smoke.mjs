#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const probePath = path.join(
  repoRoot,
  "scripts/dev/codex-app-server-phase0-probe.mjs",
);

function parseArgs(argv) {
  const options = {
    projectId: null,
    projectPath: "/root",
    cwd: process.cwd(),
    codex: "codex",
    node: null,
    model: "gpt-5.3-codex-spark",
    timeoutSeconds: 180,
    timeoutMs: 90_000,
    interruptDelayMs: 1_500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--project" && next) {
      options.projectId = next;
      i += 1;
    } else if (arg === "--project-path" && next) {
      options.projectPath = next;
      i += 1;
    } else if (arg === "--cwd" && next) {
      options.cwd = next;
      i += 1;
    } else if (arg === "--codex" && next) {
      options.codex = next;
      i += 1;
    } else if (arg === "--node" && next) {
      options.node = next;
      i += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutSeconds = Number(next);
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--interrupt-delay-ms" && next) {
      options.interruptDelayMs = Number(next);
      i += 1;
    } else if (arg === "--help") {
      console.error(
        [
          "Usage: node codex-app-server-phase0-smoke.mjs [options]",
          "",
          "Local mode:",
          "  node codex-app-server-phase0-smoke.mjs --cwd /path/to/workspace --codex /path/to/codex",
          "",
          "Launchpad mode:",
          "  node codex-app-server-phase0-smoke.mjs --project <project-id> --project-path /root --codex /opt/cocalc/bin2/codex",
          "",
          "Options:",
          "  --project <id>               Run the probe inside a Launchpad project via cocalc project exec",
          "  --project-path <path>        Working path inside the project (default: /root)",
          "  --cwd <path>                 Probe working directory inside the target runtime",
          "  --codex <path>               Codex binary path inside the target runtime",
          "  --node <path>                Node binary used to execute the probe",
          "  --model <id>                 Model for thread/start",
          "  --timeout <seconds>          cocalc project exec timeout in Launchpad mode",
          "  --timeout-ms <ms>            App-server request timeout",
          "  --interrupt-delay-ms <ms>    Delay before turn/interrupt",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function spawnAndPipe(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function runProjectExec(options, bashCommand) {
  const result = await spawnCapture("cocalc", [
    "project",
    "exec",
    "-w",
    options.projectId,
    "--timeout",
    String(options.timeoutSeconds),
    "--path",
    options.projectPath,
    "--",
    "bash",
    "-lc",
    bashCommand,
  ]);
  if (result.code !== 0) {
    throw new Error(`cocalc exited with code ${result.code}\n${result.stderr}`);
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `unable to parse cocalc JSON output: ${err}\n${result.stdout}`,
    );
  }
  if (!payload.ok) {
    throw new Error(JSON.stringify(payload, null, 2));
  }
  return payload.data;
}

async function runLocal(options) {
  const nodePath = options.node ?? process.execPath;
  return spawnAndPipe(nodePath, [
    probePath,
    "--codex",
    options.codex,
    "--cwd",
    options.cwd,
    "--model",
    options.model,
    "--timeout-ms",
    String(options.timeoutMs),
    "--interrupt-delay-ms",
    String(options.interruptDelayMs),
  ]);
}

async function runLaunchpad(options) {
  const nodePath = options.node ?? "/opt/cocalc/bin/node";
  const probeSource = fs.readFileSync(probePath, "utf8");
  const probeB64 = Buffer.from(probeSource, "utf8").toString("base64");
  const startCommand = [
    "set -euo pipefail",
    "probe=$(mktemp /tmp/codex-phase0-probe-XXXXXX.mjs)",
    "runner=$(mktemp /tmp/codex-phase0-runner-XXXXXX.sh)",
    "output=$(mktemp /tmp/codex-phase0-output-XXXXXX.log)",
    "status=$(mktemp /tmp/codex-phase0-status-XXXXXX.txt)",
    `printf '%s' '${probeB64}' | base64 -d > "$probe"`,
    'cat > "$runner" <<EOF',
    "#!/bin/bash",
    "set -u",
    "set +e",
    `${JSON.stringify(nodePath)} "$probe" --codex ${JSON.stringify(options.codex)} --cwd ${JSON.stringify(options.cwd)} --model ${JSON.stringify(options.model)} --timeout-ms ${JSON.stringify(String(options.timeoutMs))} --interrupt-delay-ms ${JSON.stringify(String(options.interruptDelayMs))} > \"$output\" 2>&1`,
    "rc=\\$?",
    'printf \'%s\\n\' "\\$rc" > "$status"',
    'exit "\\$rc"',
    "EOF",
    'chmod 700 "$runner"',
    'nohup "$runner" >/dev/null 2>&1 &',
    `printf '{"probe":"%s","runner":"%s","output":"%s","status":"%s","pid":%s}\\n' "$probe" "$runner" "$output" "$status" "$!"`,
  ].join("\n");

  const started = await runProjectExec(options, startCommand);
  const meta = JSON.parse(started.stdout);
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  process.stderr.write(
    `Launchpad Phase 0 probe started in project ${options.projectId} (pid ${meta.pid}).\n`,
  );

  let exitCode = null;
  while (Date.now() < deadline) {
    const statusResult = await runProjectExec(
      options,
      `if [ -s ${JSON.stringify(meta.status)} ]; then cat ${JSON.stringify(meta.status)}; else echo __PENDING__; fi`,
    );
    const status = statusResult.stdout.trim();
    if (status && status !== "__PENDING__") {
      exitCode = Number(status);
      break;
    }
    process.stderr.write(".");
    await delay(2000);
  }
  process.stderr.write("\n");

  if (exitCode == null) {
    throw new Error(
      `launchpad probe did not finish within ${options.timeoutSeconds}s; output is in ${meta.output}`,
    );
  }

  const outputResult = await runProjectExec(
    options,
    `cat ${JSON.stringify(meta.output)}`,
  );
  process.stdout.write(outputResult.stdout);

  await runProjectExec(
    options,
    `rm -f ${JSON.stringify(meta.probe)} ${JSON.stringify(meta.runner)} ${JSON.stringify(meta.output)} ${JSON.stringify(meta.status)}`,
  );

  if (exitCode !== 0) {
    throw new Error(`launchpad probe exited with status ${exitCode}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.projectId) {
    await runLaunchpad(options);
    return;
  }
  await runLocal(options);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
