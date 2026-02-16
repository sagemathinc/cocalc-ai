/*
Browser-path Jupyter benchmark for CoCalc Lite / CoCalc Plus.

This uses Playwright against a real running lite server and measures end-to-end
browser path timing directly from notebook DOM state transitions.

Examples:

  pnpm -C src/packages/lite jupyter:bench:browser -- --help
  pnpm -C src/packages/lite jupyter:bench:browser -- --port 5173
  pnpm -C src/packages/lite jupyter:bench:browser -- --base-url http://127.0.0.1:5173
*/

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AsciiTable3 } from "ascii-table3";
import { encode_path } from "@cocalc/util/misc";
import { project_id } from "@cocalc/project/data";
import { connectionInfoPath } from "./connection-info";

type Options = {
  base_url?: string;
  port?: number;
  host?: string;
  protocol?: "http" | "https";
  auth_token?: string;
  path_ipynb: string;
  code: string;
  iterations: number;
  warmup_iterations: number;
  timeout_ms: number;
  headless: boolean;
  json: boolean;
  quiet: boolean;
};

type RunMetric = {
  run_id: string;
  total_ms: number;
  first_chunk_ms: number | null;
  to_stop_ms: number | null;
  to_exec_count_ms: number | null;
};

type Quantiles = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

type BrowserBenchmarkResult = {
  ok: boolean;
  base_url: string;
  notebook_url: string;
  path_ipynb: string;
  code: string;
  iterations: number;
  warmup_iterations: number;
  total_ms: Quantiles;
  first_chunk_ms: Quantiles | null;
  to_stop_ms: Quantiles | null;
  to_exec_count_ms: Quantiles | null;
  runs: RunMetric[];
  started_at: string;
  finished_at: string;
};

type ConnectionInfo = {
  pid?: number;
  port?: number;
  protocol?: string;
  host?: string;
  token?: string;
  url?: string;
};

const DEFAULT_CODE = "2+3";
const DEFAULT_ITERATIONS = 30;
const DEFAULT_WARMUP = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

function requireHomeDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME must be set in lite mode");
  }
  return home;
}

const DEFAULT_PATH_IPYNB = `${requireHomeDir()}/jupyter-browser-benchmark.ipynb`;

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isRunningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function normalizeLiteHost(host: unknown): string {
  if (typeof host !== "string") return "localhost";
  const trimmed = host.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "localhost";
  }
  return trimmed;
}

function startLiteServerMessage(detail: string): Error {
  return new Error(
    `you must start a lite server running here -- 'pnpm app' (${detail})`,
  );
}

async function readConnectionInfo(): Promise<ConnectionInfo | undefined> {
  const path = connectionInfoPath();
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return undefined;
    }
    throw startLiteServerMessage(`unable to read ${path}: ${err?.message ?? err}`);
  }
}

function validatedPort(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n)) return;
  if (n < 1 || n > 65535) return;
  return n;
}

async function resolveBaseUrl(opts: Options): Promise<{
  base_url: string;
  connection_info?: ConnectionInfo;
}> {
  if (opts.base_url) {
    return { base_url: trimTrailingSlash(opts.base_url) };
  }
  const info = await readConnectionInfo();
  if (opts.port != null) {
    const protocol =
      opts.protocol ?? (info?.protocol === "https" ? "https" : "http");
    const host = opts.host ?? normalizeLiteHost(info?.host);
    return { base_url: `${protocol}://${host}:${opts.port}`, connection_info: info };
  }
  if (!info) {
    throw startLiteServerMessage(`missing ${connectionInfoPath()}`);
  }
  const pid = Number(info.pid);
  const port = validatedPort(info.port);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw startLiteServerMessage(`invalid pid in ${connectionInfoPath()}`);
  }
  if (port == null) {
    throw startLiteServerMessage(`invalid port in ${connectionInfoPath()}`);
  }
  if (!isRunningPid(pid)) {
    throw startLiteServerMessage(
      `pid ${pid} from ${connectionInfoPath()} is not running`,
    );
  }
  const protocol = info.protocol === "https" ? "https" : "http";
  const host = normalizeLiteHost(info.host);
  return {
    base_url: `${protocol}://${host}:${port}`,
    connection_info: info,
  };
}

function encodeNotebookPath(path: string): string {
  if (path.startsWith("/")) {
    return `%2F${encode_path(path.slice(1))}`;
  }
  return encode_path(path);
}

function notebookUrl({
  base_url,
  path_ipynb,
  auth_token,
}: {
  base_url: string;
  path_ipynb: string;
  auth_token?: string;
}): string {
  const base = new URL(base_url.endsWith("/") ? base_url : `${base_url}/`);
  const encodedPath = encodeNotebookPath(path_ipynb);
  const url = new URL(`projects/${project_id}/files/${encodedPath}`, base);
  url.searchParams.set("jupyter_run_debug", "json");
  if (auth_token) {
    url.searchParams.set("auth_token", auth_token);
  }
  return url.toString();
}

type CellSnapshot = {
  cell_text: string;
  input_exec_count?: number;
  run_button_label: "Run" | "Stop" | "Unknown";
};

function parseInputExecCount(cellText: string): number | undefined {
  const m = cellText.match(/\bIn\s*\[(\d+)\]\s*:/);
  if (!m) return;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function randomRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function setCellInputCode({
  page,
  code,
}: {
  page: any;
  code: string;
}): Promise<void> {
  const input = page.locator('[cocalc-test="cell-input"] .CodeMirror').first();
  await input.click();
  await input.evaluate(
    (element: any, value: string) => {
      const cm = element?.CodeMirror;
      if (!cm) {
        throw new Error("CodeMirror editor not available");
      }
      cm.setValue(value);
      cm.focus();
      const line = Math.max(0, cm.lineCount() - 1);
      const ch = cm.getLine(line)?.length ?? 0;
      cm.setCursor({ line, ch });
    },
    code,
  );
}

async function readCellSnapshot(page: any): Promise<CellSnapshot> {
  const cell = page.locator('[cocalc-test="jupyter-cell"]').first();
  const cellText = await cell.innerText();
  let runButtonLabel: CellSnapshot["run_button_label"] = "Unknown";
  try {
    const runStopButton = cell.getByRole("button", { name: /Run|Stop/ }).first();
    if ((await runStopButton.count()) > 0) {
      const text = (await runStopButton.innerText()).trim();
      if (/\bStop\b/i.test(text)) {
        runButtonLabel = "Stop";
      } else if (/\bRun\b/i.test(text)) {
        runButtonLabel = "Run";
      }
    }
  } catch {
    // keep Unknown
  }
  return {
    cell_text: cellText,
    input_exec_count: parseInputExecCount(cellText),
    run_button_label: runButtonLabel,
  };
}

async function runCellViaRunButton({
  page,
  code,
  timeout_ms,
}: {
  page: any;
  code: string;
  timeout_ms: number;
}): Promise<RunMetric> {
  const cell = page.locator('[cocalc-test="jupyter-cell"]').first();
  await setCellInputCode({ page, code });
  const before = await readCellSnapshot(page);
  await cell.hover();
  const runButton = cell.getByRole("button", { name: /Run/ }).first();
  if ((await runButton.count()) === 0) {
    throw new Error("run button not found");
  }

  const runId = randomRunId();
  const t0 = Date.now();
  await runButton.click();

  let firstChunkMs: number | null = null;
  let toStopMs: number | null = null;
  let toExecCountMs: number | null = null;
  let sawStop = false;
  let last = before;
  const deadline = t0 + timeout_ms;

  while (Date.now() < deadline) {
    last = await readCellSnapshot(page);
    const elapsed = Date.now() - t0;
    const anyChange =
      last.cell_text !== before.cell_text ||
      last.input_exec_count !== before.input_exec_count ||
      last.run_button_label === "Stop";
    if (anyChange && firstChunkMs == null) {
      firstChunkMs = elapsed;
    }
    if (last.run_button_label === "Stop") {
      sawStop = true;
      if (toStopMs == null) {
        toStopMs = elapsed;
      }
    }

    const execChanged =
      last.input_exec_count != null &&
      last.input_exec_count !== before.input_exec_count;
    if (execChanged && toExecCountMs == null) {
      toExecCountMs = elapsed;
    }
    const runCycleFinished = sawStop && last.run_button_label === "Run";
    if ((execChanged || runCycleFinished) && last.run_button_label !== "Stop") {
      return {
        run_id: runId,
        total_ms: elapsed,
        first_chunk_ms: firstChunkMs,
        to_stop_ms: toStopMs,
        to_exec_count_ms: toExecCountMs,
      };
    }
    await page.waitForTimeout(20);
  }

  throw new Error(
    `timed out after ${timeout_ms}ms waiting for cell completion (before_exec=${before.input_exec_count ?? "none"}, after_exec=${last.input_exec_count ?? "none"}, run_button=${last.run_button_label})`,
  );
}

async function waitForNotebookReady({
  page,
  timeout_ms,
}: {
  page: any;
  timeout_ms: number;
}): Promise<void> {
  await page.waitForSelector('[cocalc-test="jupyter-cell"]', {
    timeout: timeout_ms,
  });
  await page.waitForSelector('[cocalc-test="cell-input"] .CodeMirror', {
    timeout: timeout_ms,
  });
  // Ensure the notebook isn't in a transient loading state before first run.
  await page.waitForTimeout(250);
}

async function openNotebookPage({
  page,
  url,
  timeout_ms,
}: {
  page: any;
  url: string;
  timeout_ms: number;
}): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout_ms });
  await waitForNotebookReady({ page, timeout_ms });
}

async function runOneIteration({
  page,
  code,
  timeout_ms,
}: {
  page: any;
  code: string;
  timeout_ms: number;
}): Promise<RunMetric> {
  return await runCellViaRunButton({ page, code, timeout_ms });
}

async function runIterations({
  page,
  code,
  timeout_ms,
  warmup_iterations,
  iterations,
  quiet,
}: {
  page: any;
  code: string;
  timeout_ms: number;
  warmup_iterations: number;
  iterations: number;
  quiet: boolean;
}): Promise<RunMetric[]> {
  const runs: RunMetric[] = [];
  const total = warmup_iterations + iterations;

  for (let i = 0; i < total; i += 1) {
    const metric = await runOneIteration({ page, code, timeout_ms });
    if (i >= warmup_iterations) {
      runs.push(metric);
    }
    if (!quiet) {
      const prefix =
        i < warmup_iterations
          ? `warmup ${i + 1}/${warmup_iterations}`
          : `iter ${i + 1 - warmup_iterations}/${iterations}`;
      const firstChunk =
        metric.first_chunk_ms == null ? "n/a" : fmtMs(metric.first_chunk_ms);
      console.log(
        `[jupyter-browser-bench] ${prefix}: total=${fmtMs(metric.total_ms)}, first_chunk=${firstChunk}`,
      );
    }
  }
  return runs;
}

function quantiles(values: number[]): Quantiles {
  if (values.length === 0) {
    throw new Error("quantiles: empty input");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => {
    if (sorted.length === 1) {
      return sorted[0];
    }
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(q * (sorted.length - 1))),
    );
    return sorted[idx];
  };
  const sum = sorted.reduce((acc, x) => acc + x, 0);
  return {
    min: sorted[0],
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function printUsage() {
  console.log(`Usage: pnpm -C src/packages/lite jupyter:bench:browser -- [options]

Options:
  --base-url <url>             Full lite base URL (e.g. http://127.0.0.1:5173)
  --port <n>                   Lite server port (uses connection-info host/protocol if available)
  --host <name>                Hostname with --port (default: localhost)
  --protocol <http|https>      Protocol with --port (default: http)
  --auth-token <token>         Auth token (default: from connection-info.json)
  --path <ipynb-path>          Notebook path (default: $HOME/jupyter-browser-benchmark.ipynb)
  --code <python-code>         Code to run each iteration (default: 2+3)
  --iterations <n>             Measured iterations (default: 30)
  --warmup <n>                 Warmup iterations (default: 2)
  --timeout-ms <n>             Per-run timeout in ms (default: 30000)
  --headed                     Run browser with UI (default: headless)
  --json                       Print raw JSON result
  --quiet                      Do not print per-iteration logs
  --help                       Show this help
`);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    path_ipynb: DEFAULT_PATH_IPYNB,
    code: DEFAULT_CODE,
    iterations: DEFAULT_ITERATIONS,
    warmup_iterations: DEFAULT_WARMUP,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    headless: true,
    json: false,
    quiet: false,
  };

  const args: string[] = [];
  for (const raw of argv) {
    const i = raw.indexOf("=");
    if (i > 0 && raw.startsWith("--")) {
      args.push(raw.slice(0, i), raw.slice(i + 1));
    } else {
      args.push(raw);
    }
  }

  let i = 0;
  const next = () => {
    i += 1;
    const v = args[i];
    if (v == null) {
      throw new Error(`missing value for ${args[i - 1]}`);
    }
    return v;
  };
  while (i < args.length) {
    const a = args[i];
    switch (a) {
      case "--":
        break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      case "--base-url":
        opts.base_url = trimTrailingSlash(next());
        break;
      case "--port":
        opts.port = Number(next());
        if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
          throw new Error(`invalid --port '${opts.port}'`);
        }
        break;
      case "--host":
        opts.host = next();
        break;
      case "--protocol": {
        const protocol = next();
        if (protocol !== "http" && protocol !== "https") {
          throw new Error(`--protocol must be http or https, got '${protocol}'`);
        }
        opts.protocol = protocol;
        break;
      }
      case "--auth-token":
        opts.auth_token = next();
        break;
      case "--path":
        opts.path_ipynb = next();
        break;
      case "--code":
        opts.code = next();
        break;
      case "--iterations":
        opts.iterations = Number(next());
        if (!Number.isInteger(opts.iterations) || opts.iterations < 1) {
          throw new Error(`invalid --iterations '${opts.iterations}'`);
        }
        break;
      case "--warmup":
        opts.warmup_iterations = Number(next());
        if (!Number.isInteger(opts.warmup_iterations) || opts.warmup_iterations < 0) {
          throw new Error(`invalid --warmup '${opts.warmup_iterations}'`);
        }
        break;
      case "--timeout-ms":
        opts.timeout_ms = Number(next());
        if (!Number.isInteger(opts.timeout_ms) || opts.timeout_ms < 1000) {
          throw new Error(`invalid --timeout-ms '${opts.timeout_ms}'`);
        }
        break;
      case "--headed":
        opts.headless = false;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      default:
        throw new Error(`unknown option '${a}'`);
    }
    i += 1;
  }
  return opts;
}

function notebookTemplate(code: string): string {
  return JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [code],
        },
      ],
      metadata: {
        kernelspec: {
          display_name: "Python 3 (ipykernel)",
          language: "python",
          name: "python3",
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
  );
}

async function ensureNotebook(path_ipynb: string, code: string): Promise<void> {
  await mkdir(dirname(path_ipynb), { recursive: true });
  await writeFile(path_ipynb, notebookTemplate(code), "utf8");
}

function fmtMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function fmtQuantile(value: Quantiles): string {
  return `${value.p50.toFixed(1)} / ${value.p95.toFixed(1)} / ${value.p99.toFixed(1)} ms`;
}

async function runBrowserBenchmark(
  opts: Options,
): Promise<BrowserBenchmarkResult> {
  const started_at = new Date().toISOString();
  const { base_url, connection_info } = await resolveBaseUrl(opts);
  const auth_token = opts.auth_token ?? connection_info?.token;
  await ensureNotebook(opts.path_ipynb, opts.code);
  const nbUrl = notebookUrl({
    base_url,
    path_ipynb: opts.path_ipynb,
    auth_token,
  });

  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: opts.headless });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.setItem("jupyter_run_debug", "json");
    } catch {
      // ignore
    }
  });
  const page = await context.newPage();
  const runs: RunMetric[] = [];
  try {
    await openNotebookPage({ page, url: nbUrl, timeout_ms: opts.timeout_ms });
    runs.push(
      ...(await runIterations({
        page,
        code: opts.code,
        timeout_ms: opts.timeout_ms,
        warmup_iterations: opts.warmup_iterations,
        iterations: opts.iterations,
        quiet: opts.quiet,
      })),
    );
  } finally {
    await context.close();
    await browser.close();
  }

  const totalMs = runs.map((x) => x.total_ms);
  const firstChunkMs = runs
    .map((x) => x.first_chunk_ms)
    .filter((x): x is number => x != null);
  const toStopMs = runs
    .map((x) => x.to_stop_ms)
    .filter((x): x is number => x != null);
  const toExecCountMs = runs
    .map((x) => x.to_exec_count_ms)
    .filter((x): x is number => x != null);
  const finished_at = new Date().toISOString();

  return {
    ok: true,
    base_url,
    notebook_url: nbUrl,
    path_ipynb: opts.path_ipynb,
    code: opts.code,
    iterations: opts.iterations,
    warmup_iterations: opts.warmup_iterations,
    total_ms: quantiles(totalMs),
    first_chunk_ms: firstChunkMs.length > 0 ? quantiles(firstChunkMs) : null,
    to_stop_ms: toStopMs.length > 0 ? quantiles(toStopMs) : null,
    to_exec_count_ms:
      toExecCountMs.length > 0 ? quantiles(toExecCountMs) : null,
    runs,
    started_at,
    finished_at,
  };
}

function printResultTable(result: BrowserBenchmarkResult) {
  const table = new AsciiTable3("Jupyter Browser Benchmark");
  table.setHeading(
    "Iterations",
    "Warmup",
    "Total p50/p95/p99",
    "FirstObs p50/p95/p99",
    "Stop p50/p95/p99",
    "ExecCount p50/p95/p99",
  );
  table.addRow(
    String(result.iterations),
    String(result.warmup_iterations),
    fmtQuantile(result.total_ms),
    result.first_chunk_ms ? fmtQuantile(result.first_chunk_ms) : "n/a",
    result.to_stop_ms ? fmtQuantile(result.to_stop_ms) : "n/a",
    result.to_exec_count_ms ? fmtQuantile(result.to_exec_count_ms) : "n/a",
  );
  table.setAlignLeft(0);
  table.setAlignRight(1);
  table.setAlignRight(2);
  table.setAlignRight(3);
  table.setAlignRight(4);
  table.setAlignRight(5);
  console.log(table.toString());
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = await runBrowserBenchmark(opts);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResultTable(result);
      console.log(`base_url: ${result.base_url}`);
      console.log(`notebook: ${result.path_ipynb}`);
      console.log(`code: ${result.code}`);
    }
  } catch (err: any) {
    console.error(`jupyter browser benchmark failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
