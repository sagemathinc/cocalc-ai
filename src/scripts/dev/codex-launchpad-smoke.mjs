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
      "Usage: node scripts/dev/codex-launchpad-smoke.mjs --project <project-id> [options]",
      "",
      "Options:",
      "  --project <id>              Project id to test",
      "  --account-id <uuid>         Account id for CLI calls (defaults to dev:env:hub active account)",
      "  --model <id>                Codex model to use (default: gpt-5.4)",
      "  --reasoning <level>         Codex reasoning level (default: low)",
      "  --timeout <ms>              CLI timeout for codex exec (default: 180000)",
      "  --no-stop-first             Skip the initial project stop/autostart check",
      "  --verify-site-metering      Require a new codex-site-key usage row",
      "  --help                      Show this help",
      "",
      "This script refreshes the local hub CLI env automatically via dev:env:hub",
      "before each cocalc invocation, then exercises the real routed project-host",
      "Codex runner path with project autostart + session resume.",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    projectId: "",
    accountId: "",
    model: "gpt-5.4",
    reasoning: "low",
    timeoutMs: 180_000,
    stopFirst: true,
    verifySiteMetering: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--project" && next) {
      options.projectId = next;
      i += 1;
    } else if (arg === "--account-id" && next) {
      options.accountId = next;
      i += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--reasoning" && next) {
      options.reasoning = next;
      i += 1;
    } else if (arg === "--timeout" && next) {
      options.timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--no-stop-first") {
      options.stopFirst = false;
    } else if (arg === "--verify-site-metering") {
      options.verifySiteMetering = true;
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
  return options;
}

function shellQuote(value) {
  return `'${`${value ?? ""}`.replace(/'/g, `'\\''`)}'`;
}

function sqlLiteral(value) {
  return `'${`${value ?? ""}`.replace(/'/g, "''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runCocalcJson(cocalcArgs, options = {}) {
  const cmd = [
    "cd",
    shellQuote(SRC_ROOT),
    "&&",
    'eval "$(pnpm -s dev:env:hub)"',
    "&&",
    "cocalc",
    ...cocalcArgs.map(shellQuote),
  ].join(" ");
  const result = await spawnCapture("bash", ["-lc", cmd], options);
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

async function getPgEnv() {
  const result = await spawnCapture("bash", [
    "-lc",
    `cd ${shellQuote(SRC_ROOT)} && bash scripts/dev/hub-daemon.sh status`,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `hub-daemon.sh status failed with code ${result.code}\n${result.stderr}`,
    );
  }
  const env = {};
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(
      /^postgres (socket \(PGHOST\)|user   \(PGUSER\)):\s+(.+)$/,
    );
    if (!match) continue;
    if (match[1].startsWith("socket")) {
      env.PGHOST = match[2].trim();
    } else if (match[1].startsWith("user")) {
      env.PGUSER = match[2].trim();
    }
  }
  if (!env.PGHOST || !env.PGUSER) {
    throw new Error(
      `unable to discover PGHOST/PGUSER from hub-daemon status\n${result.stdout}`,
    );
  }
  env.PGDATABASE = `${process.env.PGDATABASE ?? "smc"}`.trim() || "smc";
  return env;
}

async function psqlScalar(sql) {
  const pgEnv = await getPgEnv();
  const result = await spawnCapture(
    "psql",
    ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      env: {
        ...process.env,
        ...pgEnv,
      },
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `psql exited with code ${result.code}\n${result.stderr}\nSQL:\n${sql}`,
    );
  }
  return result.stdout.trim();
}

async function querySiteMeteringCount({ projectId, accountId, sinceIso }) {
  const sql = `
    SELECT COUNT(*)
    FROM openai_chatgpt_log
    WHERE project_id = ${sqlLiteral(projectId)}
      AND account_id = ${sqlLiteral(accountId)}
      AND tag = 'codex-site-key'
      AND time >= ${sqlLiteral(sinceIso)}::timestamptz
  `;
  return Number(await psqlScalar(sql));
}

async function waitForSiteMeteringRow({
  projectId,
  accountId,
  sinceIso,
  baselineCount,
  timeoutMs = 30_000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await querySiteMeteringCount({
      projectId,
      accountId,
      sinceIso,
    });
    if (count > baselineCount) {
      return count;
    }
    await sleep(1500);
  }
  const finalCount = await querySiteMeteringCount({
    projectId,
    accountId,
    sinceIso,
  });
  throw new Error(
    `timed out waiting for codex-site-key metering row (baseline=${baselineCount}, final=${finalCount})`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const globalArgs = ["--json"];
  const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
  globalArgs.push("--timeout", `${timeoutSeconds}s`);
  globalArgs.push("--rpc-timeout", `${timeoutSeconds}s`);
  if (options.accountId.trim()) {
    globalArgs.push("--account-id", options.accountId.trim());
  }

  console.error(`codex smoke: resolving auth status for ${options.projectId}`);
  const authStatus = await runCocalcJson([
    ...globalArgs,
    "project",
    "codex",
    "auth",
    "status",
    "-w",
    options.projectId,
  ]);
  const paymentSource = `${authStatus.data?.payment_source ?? ""}`.trim();
  const accountId = `${authStatus.meta?.account_id ?? ""}`.trim();
  if (!accountId) {
    throw new Error("unable to determine active account_id from cocalc output");
  }
  console.error(
    `codex smoke: payment_source=${paymentSource || "unknown"} account_id=${accountId}`,
  );

  const shouldVerifySiteMetering =
    options.verifySiteMetering || paymentSource === "site-api-key";

  let meteringBaseline = 0;
  const meteringSinceIso = new Date().toISOString();
  if (shouldVerifySiteMetering) {
    meteringBaseline = await querySiteMeteringCount({
      projectId: options.projectId,
      accountId,
      sinceIso: meteringSinceIso,
    });
    console.error(
      `codex smoke: site metering baseline since ${meteringSinceIso} is ${meteringBaseline}`,
    );
  }

  if (options.stopFirst) {
    console.error(`codex smoke: stopping project ${options.projectId}`);
    await runCocalcJson([
      ...globalArgs,
      "project",
      "stop",
      "-w",
      options.projectId,
      "--wait",
    ]);
  }

  const token = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const firstPrompt = [
    `Remember this exact smoke token for the next turn: ${token}.`,
    `Reply exactly with: READY ${token}`,
  ].join(" ");
  console.error(`codex smoke: first turn with token ${token}`);
  const first = await runCocalcJson([
    ...globalArgs,
    "project",
    "codex",
    "exec",
    "-w",
    options.projectId,
    "--model",
    options.model,
    "--reasoning",
    options.reasoning,
    firstPrompt,
  ]);
  const threadId = `${first.data?.thread_id ?? ""}`.trim();
  const firstResponse = `${first.data?.final_response ?? ""}`.trim();
  if (!threadId) {
    throw new Error(
      `first turn returned no thread_id:\n${JSON.stringify(first, null, 2)}`,
    );
  }
  if (!firstResponse.includes(token)) {
    throw new Error(
      `first turn did not echo the smoke token:\n${firstResponse}`,
    );
  }

  const projectState = await runCocalcJson([
    ...globalArgs,
    "project",
    "get",
    "-w",
    options.projectId,
  ]);
  if (`${projectState.data?.state ?? ""}`.trim() !== "running") {
    throw new Error(
      `project is not running after codex exec autostart:\n${JSON.stringify(projectState, null, 2)}`,
    );
  }

  const secondPrompt =
    "What exact smoke token did I ask you to remember? Reply with the token only.";
  console.error(`codex smoke: resume turn on thread ${threadId}`);
  const second = await runCocalcJson([
    ...globalArgs,
    "project",
    "codex",
    "exec",
    "-w",
    options.projectId,
    "--model",
    options.model,
    "--reasoning",
    options.reasoning,
    "--session-id",
    threadId,
    secondPrompt,
  ]);
  const secondResponse = `${second.data?.final_response ?? ""}`.trim();
  if (!secondResponse.includes(token)) {
    throw new Error(
      `resume turn did not preserve thread context (expected token ${token}, got ${secondResponse})`,
    );
  }

  if (shouldVerifySiteMetering) {
    console.error("codex smoke: waiting for codex-site-key metering row");
    const meteredCount = await waitForSiteMeteringRow({
      projectId: options.projectId,
      accountId,
      sinceIso: meteringSinceIso,
      baselineCount: meteringBaseline,
    });
    console.error(`codex smoke: metering row detected (count=${meteredCount})`);
  }

  const summary = {
    ok: true,
    project_id: options.projectId,
    account_id: accountId,
    payment_source: paymentSource,
    model: options.model,
    reasoning: options.reasoning,
    thread_id: threadId,
    token,
    first_response: firstResponse,
    second_response: secondResponse,
    verified_site_metering: shouldVerifySiteMetering,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`codex smoke failed: ${err?.stack ?? err}`);
  process.exit(1);
});
