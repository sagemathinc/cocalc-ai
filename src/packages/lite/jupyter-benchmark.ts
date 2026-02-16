/*
Jupyter benchmark harness for CoCalc Lite / CoCalc Plus.

This intentionally targets the single-project, single-host lite architecture.

Examples:

  pnpm -C src/packages/lite jupyter:bench -- --profile quick
  pnpm -C src/packages/lite jupyter:bench -- --profile full --json
*/

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AsciiTable3 } from "ascii-table3";
import getLogger from "@cocalc/backend/logger";
import { conatPassword } from "@cocalc/backend/data";
import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import {
  connect,
  type Client as ConatClient,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import { projectApiClient } from "@cocalc/conat/project/api";
import { jupyterClient } from "@cocalc/conat/project/jupyter/run-code";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import { project_id as defaultProjectId } from "@cocalc/project/data";
import { connectionInfoPath } from "./connection-info";

const logger = getLogger("lite:jupyter-benchmark");

type Quantiles = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

type IterationResult = {
  ok: boolean;
  total_ms: number;
  first_message_ms: number | null;
  messages: number;
  message_bytes: number;
  more_output_messages: number;
  error_messages: number;
  error?: string;
};

export type ScenarioSummary = {
  name: string;
  iterations: number;
  ok_iterations: number;
  failed_iterations: number;
  total_ms: Quantiles;
  first_message_ms: Quantiles | null;
  messages: Quantiles;
  message_bytes: Quantiles;
  more_output_messages: Quantiles;
  error_messages: Quantiles;
  failures: string[];
};

export type ScenarioConfig = {
  name: string;
  code: string;
  iterations: number;
};

export type JupyterBenchmarkOptions = {
  client?: ConatClient;
  conat_server?: string;
  sign_in_timeout_ms?: number;
  kernel?: string;
  path_ipynb?: string;
  limit?: number;
  warmup_iterations?: number;
  profile?: "quick" | "output" | "full";
  scenarios?: ScenarioConfig[];
  stop_jupyter_on_finish?: boolean;
  log?: (event: {
    step: string;
    status: "start" | "ok" | "failed";
    message?: string;
  }) => void;
};

export type JupyterBenchmarkResult = {
  ok: boolean;
  project_id: string;
  path_ipynb: string;
  syncdb_path: string;
  profile: string;
  started_at: string;
  finished_at: string;
  scenarios: ScenarioSummary[];
  error?: string;
};

function requireHomeDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME must be set in lite mode");
  }
  return home;
}

const DEFAULT_PATH_IPYNB = `${requireHomeDir()}/jupyter-benchmark.ipynb`;
const DEFAULT_LIMIT = 500;
const DEFAULT_KERNEL = "python3";
const JUPYTER_SYNCDB_PRIMARY_KEYS = ["type", "id"];
const JUPYTER_SYNCDB_STRING_COLS = ["input"];

const SCENARIOS_QUICK: ScenarioConfig[] = [
  {
    name: "simple_expr",
    code: "2+3",
    iterations: 30,
  },
];

const SCENARIOS_OUTPUT: ScenarioConfig[] = [
  {
    name: "huge_print",
    code: "print('x'*1000000)",
    iterations: 3,
  },
  {
    name: "burst_print",
    code: "for i in range(100000):\n    print(i, end=' ')",
    iterations: 3,
  },
  {
    name: "burst_flush_write",
    code: "import sys\nfor i in range(10000):\n    sys.stdout.write(str(i) + ' ')\n    sys.stdout.flush()",
    iterations: 2,
  },
];

const SCENARIOS_FULL: ScenarioConfig[] = [
  ...SCENARIOS_QUICK,
  ...SCENARIOS_OUTPUT,
  {
    name: "sleep_stream",
    code: "from time import sleep\nfor i in range(1000):\n    print(i, end=' ')\n    sleep(0.001)",
    iterations: 2,
  },
];

function profileScenarios(profile: "quick" | "output" | "full"): ScenarioConfig[] {
  switch (profile) {
    case "output":
      return SCENARIOS_OUTPUT;
    case "full":
      return SCENARIOS_FULL;
    default:
      return SCENARIOS_QUICK;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function resolveConatAddress(opts: JupyterBenchmarkOptions): Promise<string> {
  if (opts.conat_server) {
    return trimTrailingSlash(opts.conat_server);
  }
  const infoPath = connectionInfoPath();
  let info: any;
  try {
    const raw = await readFile(infoPath, "utf8");
    info = JSON.parse(raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw startLiteServerMessage(`missing ${infoPath}`);
    }
    throw startLiteServerMessage(
      `unable to read ${infoPath}: ${err?.message ?? err}`,
    );
  }
  const pid = Number(info?.pid);
  const port = Number(info?.port);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw startLiteServerMessage(`invalid pid in ${infoPath}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw startLiteServerMessage(`invalid port in ${infoPath}`);
  }
  if (!isRunningPid(pid)) {
    throw startLiteServerMessage(`pid ${pid} from ${infoPath} is not running`);
  }
  const protocol = info?.protocol === "https" ? "https" : "http";
  const host = normalizeLiteHost(info?.host);
  return trimTrailingSlash(`${protocol}://${host}:${port}`);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeout_ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(message));
      }
    }, timeout_ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createConatClient(address: string): ConatClient {
  return connect({
    address,
    inboxPrefix: inboxPrefix({ hub_id: "hub" }),
    extraHeaders: {
      Cookie: `${HUB_PASSWORD_COOKIE_NAME}=${conatPassword}`,
    },
  });
}

async function ensureNotebookKernelMetadata(opts: {
  path_ipynb: string;
  kernel: string;
}) {
  const { path_ipynb, kernel } = opts;
  let notebook: any;
  try {
    const raw = await readFile(path_ipynb, "utf8");
    notebook = JSON.parse(raw);
  } catch {
    notebook = {
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    };
  }
  if (typeof notebook !== "object" || notebook == null) {
    notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  }
  if (!Array.isArray(notebook.cells)) {
    notebook.cells = [];
  }
  notebook.metadata ??= {};
  notebook.metadata.kernelspec = {
    ...(notebook.metadata.kernelspec ?? {}),
    name: kernel,
    display_name: notebook.metadata.kernelspec?.display_name ?? kernel,
  };
  notebook.metadata.language_info = {
    ...(notebook.metadata.language_info ?? {}),
    name: notebook.metadata.language_info?.name ?? "python",
  };
  notebook.nbformat ??= 4;
  notebook.nbformat_minor ??= 5;
  await mkdir(dirname(path_ipynb), { recursive: true });
  await writeFile(path_ipynb, `${JSON.stringify(notebook, null, 2)}\n`, "utf8");
}

async function ensureSyncdbKernel(opts: {
  client: ConatClient;
  project_id: string;
  path_syncdb: string;
  kernel: string;
}) {
  const syncdb = opts.client.sync.db({
    project_id: opts.project_id,
    path: opts.path_syncdb,
    primary_keys: JUPYTER_SYNCDB_PRIMARY_KEYS,
    string_cols: JUPYTER_SYNCDB_STRING_COLS,
    change_throttle: 25,
    patch_interval: 25,
    cursors: true,
    persistent: true,
    noSaveToDisk: true,
  });
  try {
    if (!syncdb.isReady()) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          syncdb.once("ready", () => resolve());
          syncdb.once("error", (err) => reject(err));
        }),
        10_000,
        "syncdb did not become ready in time",
      );
    }
    syncdb.set({ type: "settings", kernel: opts.kernel });
    syncdb.commit();
    await withTimeout(
      syncdb.save(),
      10_000,
      "syncdb save timed out while setting kernel",
    );
  } finally {
    syncdb.close();
  }
}

function quantiles(values: number[]): Quantiles {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) {
    return {
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
    };
  }
  const at = (q: number) => {
    if (v.length === 1) return v[0];
    const pos = (v.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return v[lo];
    const w = pos - lo;
    return v[lo] * (1 - w) + v[hi] * w;
  };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    min: v[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: v[v.length - 1],
    mean,
  };
}

async function runOne({
  client,
  code,
  limit,
}: {
  client: ReturnType<typeof jupyterClient>;
  code: string;
  limit: number;
}): Promise<IterationResult> {
  const started = Date.now();
  const cell_id = randomUUID().slice(0, 8);
  let firstMessageAt: number | null = null;
  let messages = 0;
  let message_bytes = 0;
  let more_output_messages = 0;
  let error_messages = 0;
  try {
    const iter = await client.run([{ id: cell_id, input: code }], {
      limit,
      noHalt: true,
      run_id: `bench-${Date.now().toString(36)}-${cell_id}`,
    });
    for await (const batch of iter) {
      if (firstMessageAt == null) {
        firstMessageAt = Date.now();
      }
      messages += batch.length;
      for (const mesg of batch) {
        if (mesg.more_output) more_output_messages += 1;
        if (mesg.msg_type === "error") error_messages += 1;
        try {
          message_bytes += JSON.stringify(mesg).length;
        } catch {
          // ignore serialization edge-cases in benchmark accounting
        }
      }
    }
    return {
      ok: true,
      total_ms: Date.now() - started,
      first_message_ms:
        firstMessageAt == null ? null : Math.max(0, firstMessageAt - started),
      messages,
      message_bytes,
      more_output_messages,
      error_messages,
    };
  } catch (err: any) {
    return {
      ok: false,
      total_ms: Date.now() - started,
      first_message_ms:
        firstMessageAt == null ? null : Math.max(0, firstMessageAt - started),
      messages,
      message_bytes,
      more_output_messages,
      error_messages,
      error: `${err}`,
    };
  }
}

function summarizeScenario(name: string, results: IterationResult[]): ScenarioSummary {
  const ok = results.filter((x) => x.ok);
  const failed = results.filter((x) => !x.ok);
  const first = ok
    .map((x) => x.first_message_ms)
    .filter((x): x is number => x != null);
  return {
    name,
    iterations: results.length,
    ok_iterations: ok.length,
    failed_iterations: failed.length,
    total_ms: quantiles(ok.map((x) => x.total_ms)),
    first_message_ms: first.length > 0 ? quantiles(first) : null,
    messages: quantiles(ok.map((x) => x.messages)),
    message_bytes: quantiles(ok.map((x) => x.message_bytes)),
    more_output_messages: quantiles(ok.map((x) => x.more_output_messages)),
    error_messages: quantiles(ok.map((x) => x.error_messages)),
    failures: failed.map((x) => x.error ?? "unknown error"),
  };
}

export async function runJupyterBenchmark(
  opts: JupyterBenchmarkOptions = {},
): Promise<JupyterBenchmarkResult> {
  const started = new Date();
  const profile = opts.profile ?? "quick";
  const kernel = opts.kernel ?? DEFAULT_KERNEL;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const path_ipynb = opts.path_ipynb ?? DEFAULT_PATH_IPYNB;
  const path_syncdb = syncdbPath(path_ipynb);
  const warmup = Math.max(0, opts.warmup_iterations ?? 1);
  const scenarios = opts.scenarios ?? profileScenarios(profile);
  const stopJupyterOnFinish = opts.stop_jupyter_on_finish ?? true;
  const signInTimeout = Math.max(1_000, opts.sign_in_timeout_ms ?? 15_000);
  const conatAddress = await resolveConatAddress(opts);

  const conatClient = opts.client ?? createConatClient(conatAddress);
  const ownsClient = opts.client == null;
  const project_id = defaultProjectId;
  let runClient: ReturnType<typeof jupyterClient> | undefined;

  try {
    opts.log?.({
      step: "conat_connect",
      status: "start",
      message: conatAddress,
    });
    await withTimeout(
      conatClient.waitUntilSignedIn(),
      signInTimeout,
      `unable to sign in to Conat at ${conatAddress} within ${signInTimeout}ms (is cocalc-lite running on that address?)`,
    );
    opts.log?.({ step: "conat_connect", status: "ok" });

    const projectApi = projectApiClient({ project_id, client: conatClient });
    opts.log?.({
      step: "project_ready",
      status: "start",
      message: project_id,
    });
    await withTimeout(
      projectApi.waitUntilReady({ timeout: 60_000 }),
      70_000,
      `project ${project_id} did not become ready`,
    );
    opts.log?.({ step: "project_ready", status: "ok" });

    opts.log?.({
      step: "notebook_bootstrap",
      status: "start",
      message: `${path_ipynb} kernel=${kernel}`,
    });
    await ensureNotebookKernelMetadata({ path_ipynb, kernel });
    opts.log?.({ step: "notebook_bootstrap", status: "ok" });

    opts.log?.({
      step: "kernel_syncdb",
      status: "start",
      message: kernel,
    });
    await ensureSyncdbKernel({
      client: conatClient,
      project_id,
      path_syncdb,
      kernel,
    });
    opts.log?.({ step: "kernel_syncdb", status: "ok" });

    opts.log?.({ step: "jupyter_start", status: "start", message: path_syncdb });
    await projectApi.jupyter.start(path_syncdb);
    opts.log?.({ step: "jupyter_start", status: "ok" });

    runClient = jupyterClient({
      path: path_syncdb,
      project_id,
      client: conatClient,
    });

    for (let i = 0; i < warmup; i += 1) {
      opts.log?.({ step: "warmup", status: "start", message: `iteration ${i + 1}` });
      const warm = await runOne({ client: runClient, code: "2+3", limit });
      if (!warm.ok) {
        throw new Error(`warmup failed: ${warm.error}`);
      }
      opts.log?.({
        step: "warmup",
        status: "ok",
        message: `total_ms=${warm.total_ms} first_ms=${warm.first_message_ms}`,
      });
      await sleep(100);
    }

    const scenarioSummaries: ScenarioSummary[] = [];
    for (const scenario of scenarios) {
      opts.log?.({
        step: `scenario:${scenario.name}`,
        status: "start",
        message: `iterations=${scenario.iterations}`,
      });
      const results: IterationResult[] = [];
      for (let i = 0; i < scenario.iterations; i += 1) {
        const result = await runOne({
          client: runClient,
          code: scenario.code,
          limit,
        });
        results.push(result);
      }
      const summary = summarizeScenario(scenario.name, results);
      scenarioSummaries.push(summary);
      opts.log?.({
        step: `scenario:${scenario.name}`,
        status: summary.failed_iterations > 0 ? "failed" : "ok",
        message: `p50=${summary.total_ms.p50.toFixed(1)}ms p95=${summary.total_ms.p95.toFixed(1)}ms first_p50=${summary.first_message_ms?.p50?.toFixed?.(1) ?? "n/a"}ms`,
      });
    }

    const finished = new Date();
    return {
      ok: scenarioSummaries.every((x) => x.failed_iterations === 0),
      project_id,
      path_ipynb,
      syncdb_path: path_syncdb,
      profile,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      scenarios: scenarioSummaries,
    };
  } catch (err: any) {
    logger.debug("runJupyterBenchmark failed", err);
    return {
      ok: false,
      project_id,
      path_ipynb,
      syncdb_path: path_syncdb,
      profile,
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      scenarios: [],
      error: `${err}`,
    };
  } finally {
    try {
      runClient?.close();
    } catch {}
    try {
      if (stopJupyterOnFinish) {
        const projectApi = projectApiClient({ project_id, client: conatClient });
        await projectApi.jupyter.stop(path_syncdb);
      }
    } catch {
      // best effort stop
    }
    if (ownsClient) {
      try {
        conatClient.close();
      } catch {
        // best effort close
      }
    }
  }
}

function formatMs(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value.toFixed(0)} B`;
}

export function benchmarkTable(result: JupyterBenchmarkResult): string {
  const table = new AsciiTable3("Jupyter Benchmark")
    .setHeading(
      "Scenario",
      "Iter",
      "OK",
      "Fail",
      "Total p50",
      "Total p95",
      "First p50",
      "Msgs p50",
      "Bytes p50",
      "MoreOut p50",
    )
    .setStyle("unicode-round");
  for (const s of result.scenarios) {
    table.addRow(
      s.name,
      String(s.iterations),
      String(s.ok_iterations),
      String(s.failed_iterations),
      formatMs(s.total_ms.p50),
      formatMs(s.total_ms.p95),
      s.first_message_ms ? formatMs(s.first_message_ms.p50) : "n/a",
      s.messages.p50.toFixed(1),
      formatBytes(s.message_bytes.p50),
      s.more_output_messages.p50.toFixed(1),
    );
  }
  let output = table.toString();
  for (const s of result.scenarios) {
    if (s.failures.length === 0) continue;
    output += `\n\n${s.name} failures:\n`;
    for (const failure of s.failures) {
      output += `- ${failure}\n`;
    }
  }
  return output;
}

function printUsage() {
  console.log(`Usage: pnpm -C src/packages/lite jupyter:bench -- [options]

Options:
  --conat-server <url>           Conat server address (default: read from ${connectionInfoPath()})
  --sign-in-timeout-ms <n>       Timeout for initial sign-in (default: 15000)
  --kernel <name>                Kernel name to enforce in benchmark notebook (default: ${DEFAULT_KERNEL})
  --profile <quick|output|full>  Scenario set (default: quick)
  --path <ipynb-path>            Notebook path (default: $HOME/jupyter-benchmark.ipynb)
  --limit <n>                    Per-run output limit (default: 500)
  --warmup <n>                   Warmup iterations (default: 1)
  --json                         Print raw JSON result
  --quiet                        Do not print step logs
  --no-stop                      Keep benchmark kernel running at the end
  --help                         Show this help
`);
}

function parseInteger(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid value for ${flag}: '${raw}'`);
  }
  return Math.floor(n);
}

export function parseArgs(argv: string[]) {
  const opts: JupyterBenchmarkOptions = {};
  let json = false;
  let quiet = false;
  let showHelp = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") continue;
    const next = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`missing value after ${a}`);
      }
      i += 1;
      return argv[i];
    };
    switch (a) {
      case "--profile": {
        const v = next();
        if (v !== "quick" && v !== "output" && v !== "full") {
          throw new Error(`invalid --profile '${v}'`);
        }
        opts.profile = v;
        break;
      }
      case "--conat-server":
        opts.conat_server = next();
        break;
      case "--sign-in-timeout-ms":
        opts.sign_in_timeout_ms = parseInteger(next(), "--sign-in-timeout-ms");
        break;
      case "--path":
        opts.path_ipynb = next();
        break;
      case "--kernel":
        opts.kernel = next();
        break;
      case "--limit":
        opts.limit = parseInteger(next(), "--limit");
        break;
      case "--warmup":
        opts.warmup_iterations = parseInteger(next(), "--warmup");
        break;
      case "--json":
        json = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--no-stop":
        opts.stop_jupyter_on_finish = false;
        break;
      case "--help":
      case "-h":
        showHelp = true;
        break;
      default:
        throw new Error(`unknown option '${a}'`);
    }
  }
  return { opts, json, quiet, showHelp };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { opts, json, quiet, showHelp } = parseArgs(argv);
  if (showHelp) {
    printUsage();
    return;
  }
  const result = await runJupyterBenchmark({
    ...opts,
    log: quiet
      ? undefined
      : (event) => {
          const suffix = event.message ? ` ${event.message}` : "";
          console.log(`[${event.status}] ${event.step}${suffix}`);
        },
  });
  if (json) {
    console.log(JSON.stringify(result, undefined, 2));
  } else {
    console.log(benchmarkTable(result));
  }
  if (!result.ok) {
    if (result.error) {
      console.error(result.error);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .then(() => {
      process.exit(process.exitCode ?? 0);
    })
    .catch((err) => {
      console.error("jupyter benchmark failed:", err?.message ?? err);
      process.exit(1);
    });
}
