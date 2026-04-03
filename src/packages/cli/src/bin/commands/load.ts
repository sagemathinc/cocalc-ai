import { performance } from "node:perf_hooks";
import { Command } from "commander";

type LoadScenarioResult = Record<string, unknown> | null | undefined;

type LoadSummary = {
  scenario: string;
  iterations: number;
  warmup: number;
  concurrency: number;
  successes: number;
  failures: number;
  started_at: string;
  finished_at: string;
  wall_ms: number;
  ops_per_sec: number;
  latency_ms: {
    min: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
    max: number | null;
    avg: number | null;
  };
  sample_errors: string[];
  last_result: LoadScenarioResult;
};

export type LoadCommandDeps = {
  withContext: any;
  queryProjects: any;
};

function parsePositiveInteger(
  raw: string | undefined,
  flag: string,
  defaultValue: number,
): number {
  if (raw == null || `${raw}`.trim() === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return roundMs(sorted[index]);
}

function summarizeLatencies(latencies: number[]): LoadSummary["latency_ms"] {
  if (!latencies.length) {
    return {
      min: null,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      avg: null,
    };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: roundMs(sorted[0]),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: roundMs(sorted[sorted.length - 1]),
    avg: roundMs(sum / sorted.length),
  };
}

async function runLoadScenario({
  scenario,
  iterations,
  warmup,
  concurrency,
  execute,
}: {
  scenario: string;
  iterations: number;
  warmup: number;
  concurrency: number;
  execute: (index: number) => Promise<LoadScenarioResult>;
}): Promise<LoadSummary> {
  const total = iterations + warmup;
  const workerCount = Math.min(concurrency, Math.max(1, total));
  const startedAt = new Date();
  const started = performance.now();
  const latencies: number[] = [];
  const sampleErrors: string[] = [];
  let lastResult: LoadScenarioResult = null;
  let successes = 0;
  let failures = 0;
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= total) {
        return;
      }
      const sampleStart = performance.now();
      try {
        const result = await execute(index);
        if (index >= warmup) {
          successes += 1;
          lastResult = result ?? null;
        }
      } catch (err) {
        if (index >= warmup) {
          failures += 1;
          if (sampleErrors.length < 5) {
            sampleErrors.push(err instanceof Error ? err.message : `${err}`);
          }
        }
      } finally {
        if (index >= warmup) {
          latencies.push(performance.now() - sampleStart);
        }
      }
    }
  });

  await Promise.all(workers);

  const elapsed = performance.now() - started;
  const measuredAttempts = successes + failures;
  return {
    scenario,
    iterations,
    warmup,
    concurrency: workerCount,
    successes,
    failures,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    wall_ms: roundMs(elapsed),
    ops_per_sec:
      measuredAttempts === 0 || elapsed <= 0
        ? 0
        : roundMs((measuredAttempts * 1000) / elapsed),
    latency_ms: summarizeLatencies(latencies),
    sample_errors: sampleErrors,
    last_result: lastResult ?? null,
  };
}

export function registerLoadCommand(
  program: Command,
  deps: LoadCommandDeps,
): Command {
  const { withContext, queryProjects } = deps;

  const load = program
    .command("load")
    .description("load-test harness commands");

  load
    .command("bootstrap")
    .description("measure repeated account bootstrap control-plane calls")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .action(
      async (
        opts: {
          iterations?: string;
          warmup?: string;
          concurrency?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "load bootstrap", async (ctx) => {
          const iterations = parsePositiveInteger(
            opts.iterations,
            "--iterations",
            20,
          );
          const warmup = parsePositiveInteger(opts.warmup, "--warmup", 2);
          const concurrency = parsePositiveInteger(
            opts.concurrency,
            "--concurrency",
            1,
          );
          return await runLoadScenario({
            scenario: "bootstrap",
            iterations,
            warmup,
            concurrency,
            execute: async () => {
              const homeBay = await ctx.hub.system.getAccountBay({
                user_account_id: ctx.accountId,
              });
              const bays = await ctx.hub.system.listBays({});
              return {
                account_id: ctx.accountId,
                home_bay_id: homeBay?.bay_id ?? null,
                visible_bay_count: Array.isArray(bays) ? bays.length : 0,
              };
            },
          });
        });
      },
    );

  load
    .command("projects")
    .description("measure repeated project-list queries")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .option("--limit <n>", "projects to fetch per iteration", "100")
    .action(
      async (
        opts: {
          iterations?: string;
          warmup?: string;
          concurrency?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "load projects", async (ctx) => {
          const iterations = parsePositiveInteger(
            opts.iterations,
            "--iterations",
            20,
          );
          const warmup = parsePositiveInteger(opts.warmup, "--warmup", 2);
          const concurrency = parsePositiveInteger(
            opts.concurrency,
            "--concurrency",
            1,
          );
          const limit = parsePositiveInteger(opts.limit, "--limit", 100);
          return await runLoadScenario({
            scenario: "projects",
            iterations,
            warmup,
            concurrency,
            execute: async () => {
              const rows = await queryProjects({
                ctx,
                limit,
              });
              return {
                project_count: rows.length,
                first_project_id: rows[0]?.project_id ?? null,
                first_host_id: rows[0]?.host_id ?? null,
              };
            },
          });
        });
      },
    );

  return load;
}
