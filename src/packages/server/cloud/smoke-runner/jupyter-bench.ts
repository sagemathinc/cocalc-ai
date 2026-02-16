/*
Jupyter benchmark harness for latency and output throughput.

Typical usage from a node REPL:

  const bench = require("../../dist/cloud/smoke-runner/jupyter-bench");
  await bench.runJupyterBenchmark({
    account_id: "...",
    project_id: "...", // optional; created if omitted
    profile: "quick",
  });
*/

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { projectApiClient } from "@cocalc/conat/project/api";
import { jupyterClient } from "@cocalc/conat/project/jupyter/run-code";
import { syncdbPath } from "@cocalc/util/jupyter/names";
import admins from "@cocalc/server/accounts/admins";
import {
  createProject,
  start as startProject,
} from "@cocalc/server/conat/api/projects";
import deleteProject from "@cocalc/server/projects/delete";

const logger = getLogger("server:cloud:smoke-runner:jupyter-bench");

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

type ScenarioSummary = {
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

type ScenarioConfig = {
  name: string;
  code: string;
  iterations: number;
};

export type JupyterBenchmarkOptions = {
  account_id?: string;
  project_id?: string;
  create_project_when_missing?: boolean;
  cleanup_created_project?: boolean;
  path_ipynb?: string;
  kernel?: string;
  limit?: number;
  warmup_iterations?: number;
  profile?: "quick" | "output" | "full";
  scenarios?: ScenarioConfig[];
  log?: (event: {
    step: string;
    status: "start" | "ok" | "failed";
    message?: string;
  }) => void;
};

export type JupyterBenchmarkResult = {
  ok: boolean;
  account_id: string;
  project_id: string;
  path_ipynb: string;
  syncdb_path: string;
  kernel: string;
  profile: string;
  started_at: string;
  finished_at: string;
  scenarios: ScenarioSummary[];
  created_project: boolean;
  error?: string;
};

const DEFAULT_PATH_IPYNB = "/root/jupyter-benchmark.ipynb";
const DEFAULT_KERNEL = "python3";
const DEFAULT_LIMIT = 500;

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

async function resolveAccountId(account_id?: string): Promise<string> {
  if (account_id) return account_id;
  const ids = await admins();
  if (ids.length === 0) {
    throw new Error(
      "no admin account found; pass account_id explicitly or create an admin account",
    );
  }
  return ids[0];
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
  const cleanupCreatedProject = opts.cleanup_created_project ?? true;
  const createWhenMissing = opts.create_project_when_missing ?? true;

  let account_id = "";
  let project_id = "";
  let created_project = false;
  let client: ReturnType<typeof jupyterClient> | undefined;

  try {
    account_id = await resolveAccountId(opts.account_id);
    project_id = opts.project_id ?? "";
    if (!project_id) {
      if (!createWhenMissing) {
        throw new Error("project_id not provided and create_project_when_missing=false");
      }
      opts.log?.({ step: "create_project", status: "start" });
      project_id = await createProject({
        account_id,
        title: `jupyter benchmark ${new Date().toISOString()}`,
      });
      created_project = true;
      opts.log?.({ step: "create_project", status: "ok", message: project_id });
    }

    opts.log?.({ step: "start_project", status: "start", message: project_id });
    await startProject({ account_id, project_id, wait: true });
    opts.log?.({ step: "start_project", status: "ok" });

    const routed = conatWithProjectRouting();
    const projectApi = projectApiClient({ project_id, client: routed });
    await projectApi.waitUntilReady({ timeout: 60_000 });

    opts.log?.({ step: "jupyter_start", status: "start", message: path_syncdb });
    await projectApi.jupyter.start(path_syncdb);
    opts.log?.({ step: "jupyter_start", status: "ok" });

    client = jupyterClient({
      path: path_syncdb,
      project_id,
      client: routed,
    });

    for (let i = 0; i < warmup; i += 1) {
      opts.log?.({ step: "warmup", status: "start", message: `iteration ${i + 1}` });
      const warm = await runOne({ client, code: "2+3", limit });
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
          client,
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
      account_id,
      project_id,
      path_ipynb,
      syncdb_path: path_syncdb,
      kernel,
      profile,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      scenarios: scenarioSummaries,
      created_project,
    };
  } catch (err: any) {
    logger.debug("runJupyterBenchmark failed", err);
    return {
      ok: false,
      account_id,
      project_id,
      path_ipynb,
      syncdb_path: path_syncdb,
      kernel,
      profile,
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      scenarios: [],
      created_project,
      error: `${err}`,
    };
  } finally {
    try {
      client?.close();
    } catch {}
    try {
      if (project_id) {
        const routed = conatWithProjectRouting();
        const projectApi = projectApiClient({ project_id, client: routed });
        await projectApi.jupyter.stop(path_syncdb);
      }
    } catch {
      // best effort stop
    }
    if (created_project && cleanupCreatedProject && project_id) {
      try {
        await deleteProject({ project_id, skipPermissionCheck: true });
      } catch {
        // best effort cleanup
      }
    }
  }
}

