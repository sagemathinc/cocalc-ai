#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(scriptDir, "../../cli/dist/bin/cocalc.js");

function parseArgs(argv) {
  const options = {
    api: "https://staging.cocalc.ai",
    concurrency: 4,
    rounds: 10,
    scenario: "idle",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || value == null) {
      throw new Error(`invalid argument '${key}'`);
    }
    options[key.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }
  options.concurrency = Number(options.concurrency);
  options.rounds = Number(options.rounds);
  options.projects = `${options.projects ?? ""}`
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  options.output ||= `/tmp/project-start-${options.scenario}-${Date.now()}.jsonl`;
  if (!`${options.api}`.startsWith("https://staging.cocalc.ai")) {
    throw new Error("this benchmark is intentionally restricted to staging");
  }
  if (
    !options.projects.length ||
    options.projects.some((id) => !UUID_RE.test(id))
  ) {
    throw new Error(
      "--projects must be a comma-separated list of project UUIDs",
    );
  }
  if (
    !Number.isInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 16
  ) {
    throw new Error("--concurrency must be an integer from 1 through 16");
  }
  if (
    !Number.isInteger(options.rounds) ||
    options.rounds < 1 ||
    options.rounds > 100
  ) {
    throw new Error("--rounds must be an integer from 1 through 100");
  }
  return options;
}

async function runCli(api, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        "--profile",
        "staging",
        "--api",
        api,
        "--poll-ms",
        "100ms",
        "--json",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      let response;
      try {
        response = JSON.parse(stdout);
      } catch (err) {
        reject(
          new Error(
            `CLI returned invalid JSON (exit=${code}): ${stderr || stdout}\n${err}`,
          ),
        );
        return;
      }
      if (code !== 0 || !response.ok) {
        reject(
          new Error(
            `CLI failed (exit=${code}): ${JSON.stringify(response.error ?? response)} ${stderr}`,
          ),
        );
        return;
      }
      resolvePromise(response);
    });
  });
}

async function mapLimit(values, limit, fn) {
  let next = 0;
  const results = new Array(values.length);
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, worker),
  );
  return results;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

const options = parseArgs(process.argv.slice(2));
await mkdir(dirname(resolve(options.output)), { recursive: true });
await writeFile(options.output, "", "utf8");

const samples = [];
for (let round = 1; round <= options.rounds; round += 1) {
  await mapLimit(options.projects, options.concurrency, async (projectId) => {
    await runCli(options.api, ["project", "stop", "-w", projectId, "--wait"]);
  });
  await mapLimit(options.projects, options.concurrency, async (projectId) => {
    const requestedAt = new Date().toISOString();
    const started = performance.now();
    const response = await runCli(options.api, [
      "project",
      "start",
      "-w",
      projectId,
      "--wait",
    ]);
    const clientElapsedMs = Math.round(performance.now() - started);
    const operation = await runCli(options.api, [
      "op",
      "get",
      response.data.op_id,
    ]);
    const sample = {
      scenario: options.scenario,
      round,
      project_id: projectId,
      op_id: response.data.op_id,
      requested_at: requestedAt,
      client_elapsed_ms: clientElapsedMs,
      operation_started_at: operation.data.started_at,
      operation_finished_at: operation.data.finished_at,
      phase_timings_ms: operation.data.result?.phase_timings_ms ?? {},
    };
    samples.push(sample);
    await appendFile(options.output, `${JSON.stringify(sample)}\n`, "utf8");
  });
  process.stderr.write(
    `completed ${round}/${options.rounds} rounds (${samples.length} samples)\n`,
  );
}

const client = samples.map((sample) => sample.client_elapsed_ms);
const backend = samples
  .map((sample) => sample.phase_timings_ms.total)
  .filter((value) => Number.isFinite(value));
process.stdout.write(
  `${JSON.stringify(
    {
      scenario: options.scenario,
      output: resolve(options.output),
      samples: samples.length,
      client_ms: {
        p50: percentile(client, 0.5),
        p90: percentile(client, 0.9),
        p95: percentile(client, 0.95),
        p99: percentile(client, 0.99),
        max: Math.max(...client),
      },
      backend_ms: {
        p50: percentile(backend, 0.5),
        p90: percentile(backend, 0.9),
        p95: percentile(backend, 0.95),
        p99: percentile(backend, 0.99),
        max: Math.max(...backend),
      },
    },
    null,
    2,
  )}\n`,
);
