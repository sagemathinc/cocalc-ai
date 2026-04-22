import { performance } from "node:perf_hooks";
import { Command } from "commander";

type LoadScenarioResult = Record<string, unknown> | null | undefined;
type SeedScenarioResult = Record<string, unknown>;

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
  resolveProjectFromArgOrContext: any;
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

function normalizeNonEmpty(raw: string | undefined, flag: string): string {
  const value = `${raw ?? ""}`.trim();
  if (!value) {
    throw new Error(`${flag} must be non-empty`);
  }
  return value;
}

function buildSeedEmail(opts: {
  prefix: string;
  domain: string;
  index: number;
  width: number;
}): string {
  const { prefix, domain, index, width } = opts;
  return `${prefix}-${String(index).padStart(width, "0")}@${domain}`.toLowerCase();
}

function isAlreadyCollaboratorError(err: unknown): boolean {
  return `${(err as any)?.message ?? err ?? ""}`
    .toLowerCase()
    .includes("already a collaborator");
}

async function findAccountByEmailExact(ctx: any, email: string) {
  const normalized = `${email ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const rows = (await ctx.hub.system.userSearch({
    query: normalized,
    limit: 10,
    only_email: true,
    admin: true,
  })) as Array<{
    account_id: string;
    email_address?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
  }>;
  return (
    rows.find(
      (row) => `${row.email_address ?? ""}`.trim().toLowerCase() === normalized,
    ) ?? null
  );
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
  execute: (index: number, workerIndex: number) => Promise<LoadScenarioResult>;
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

  const workers = Array.from(
    { length: workerCount },
    async (_, workerIndex) => {
      while (true) {
        const index = nextIndex++;
        if (index >= total) {
          return;
        }
        const sampleStart = performance.now();
        try {
          const result = await execute(index, workerIndex);
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
    },
  );

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

async function ensureProjectCollaboratorPresent({
  ctx,
  project_id,
  account_id,
}: {
  ctx: any;
  project_id: string;
  account_id: string;
}) {
  try {
    await ctx.hub.projects.createCollabInvite({
      project_id,
      invitee_account_id: account_id,
      direct: true,
    });
  } catch (err) {
    if (!isAlreadyCollaboratorError(err)) {
      throw err;
    }
  }
}

export function registerLoadCommand(
  program: Command,
  deps: LoadCommandDeps,
): Command {
  const { withContext, queryProjects, resolveProjectFromArgOrContext } = deps;

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

  load
    .command("collaborators")
    .description("measure repeated project collaborator-list queries")
    .requiredOption("-w, --project <project>", "project id or name")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .action(
      async (
        opts: {
          project?: string;
          iterations?: string;
          warmup?: string;
          concurrency?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "load collaborators", async (ctx) => {
          const project = await resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
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
            scenario: "collaborators",
            iterations,
            warmup,
            concurrency,
            execute: async () => {
              const rows = await ctx.hub.projects.listCollaborators({
                project_id: project.project_id,
              });
              const ownerCount = (rows ?? []).filter(
                (row) => row.group === "owner",
              ).length;
              return {
                project_id: project.project_id,
                project_title: project.title,
                collaborator_count: rows.length,
                owner_count: ownerCount,
                non_owner_count: rows.length - ownerCount,
                first_account_id: rows[0]?.account_id ?? null,
                first_group: rows[0]?.group ?? null,
              };
            },
          });
        });
      },
    );

  load
    .command("my-collaborators")
    .description("measure repeated account-wide collaborator summary queries")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .option("--limit <n>", "rows to fetch per iteration", "500")
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
        await withContext(command, "load my-collaborators", async (ctx) => {
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
          const limit = parsePositiveInteger(opts.limit, "--limit", 500);
          return await runLoadScenario({
            scenario: "my-collaborators",
            iterations,
            warmup,
            concurrency,
            execute: async () => {
              const rows = await ctx.hub.projects.listMyCollaborators({
                limit,
              });
              return {
                collaborator_count: rows.length,
                first_account_id: rows[0]?.account_id ?? null,
                first_shared_projects: rows[0]?.shared_projects ?? null,
                max_shared_projects:
                  rows.reduce(
                    (acc, row) =>
                      Math.max(acc, Number(row.shared_projects ?? 0) || 0),
                    0,
                  ) ?? 0,
              };
            },
          });
        });
      },
    );

  load
    .command("mentions")
    .description("measure repeated account mention/notification queries")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .option("--limit <n>", "rows to fetch per iteration", "500")
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
        await withContext(command, "load mentions", async (ctx) => {
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
          const limit = parsePositiveInteger(opts.limit, "--limit", 500);
          return await runLoadScenario({
            scenario: "mentions",
            iterations,
            warmup,
            concurrency,
            execute: async () => {
              const result = (await ctx.hub.db.userQuery({
                query: {
                  mentions: [
                    {
                      time: null,
                      project_id: null,
                      path: null,
                      source: null,
                      target: null,
                      description: null,
                    },
                  ],
                },
                options: [{ limit }],
              })) as {
                mentions?: Array<{
                  time?: string | Date | null;
                  project_id?: string | null;
                  path?: string | null;
                  target?: string | null;
                }>;
              };
              const rows = Array.isArray(result?.mentions)
                ? result.mentions
                : [];
              return {
                mention_count: rows.length,
                first_project_id: rows[0]?.project_id ?? null,
                first_path: rows[0]?.path ?? null,
                first_target: rows[0]?.target ?? null,
              };
            },
          });
        });
      },
    );

  load
    .command("collaborator-cycle")
    .description(
      "measure repeated remove-then-direct-add collaborator cycles using a seeded account pool",
    )
    .requiredOption("-w, --project <project>", "project id or name")
    .requiredOption(
      "--prefix <prefix>",
      "email prefix used when the collaborator pool was seeded",
    )
    .requiredOption(
      "--count <n>",
      "number of seeded accounts available in the collaborator pool",
    )
    .option(
      "--domain <domain>",
      "email domain for the seeded accounts",
      "load.test",
    )
    .option("--start <n>", "starting numeric suffix", "1")
    .option("--iterations <n>", "measured iterations", "20")
    .option("--warmup <n>", "warmup iterations", "2")
    .option("--concurrency <n>", "parallel workers", "1")
    .action(
      async (
        opts: {
          project?: string;
          prefix?: string;
          count?: string;
          domain?: string;
          start?: string;
          iterations?: string;
          warmup?: string;
          concurrency?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "load collaborator-cycle", async (ctx) => {
          const project = await resolveProjectFromArgOrContext(
            ctx,
            opts.project,
          );
          const prefix = normalizeNonEmpty(opts.prefix, "--prefix");
          const domain = normalizeNonEmpty(opts.domain, "--domain");
          const count = parsePositiveInteger(opts.count, "--count", 1);
          const start = parsePositiveInteger(opts.start, "--start", 1);
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
          if (count < concurrency) {
            throw new Error(
              "--count must be at least as large as --concurrency for collaborator-cycle",
            );
          }
          const width = Math.max(4, String(start + count - 1).length);
          const pool = [] as Array<{
            index: number;
            email: string;
            account_id: string;
          }>;
          for (let offset = 0; offset < count; offset += 1) {
            const index = start + offset;
            const email = buildSeedEmail({ prefix, domain, index, width });
            const account = await findAccountByEmailExact(ctx, email);
            if (!account?.account_id) {
              throw new Error(
                `seed account '${email}' was not found; run 'cocalc load seed users' first`,
              );
            }
            await ensureProjectCollaboratorPresent({
              ctx,
              project_id: project.project_id,
              account_id: account.account_id,
            });
            pool.push({
              index,
              email,
              account_id: account.account_id,
            });
          }

          return await runLoadScenario({
            scenario: "collaborator-cycle",
            iterations,
            warmup,
            concurrency,
            execute: async (_sampleIndex, workerIndex) => {
              const account = pool[workerIndex % pool.length];
              await ctx.hub.projects.removeCollaborator({
                opts: {
                  project_id: project.project_id,
                  account_id: account.account_id,
                },
              });
              await ctx.hub.projects.createCollabInvite({
                project_id: project.project_id,
                invitee_account_id: account.account_id,
                direct: true,
              });
              return {
                project_id: project.project_id,
                project_title: project.title,
                account_id: account.account_id,
                email: account.email,
                seed_index: account.index,
                operation: "remove-then-direct-add",
              };
            },
          });
        });
      },
    );

  const seed = load
    .command("seed")
    .description("create deterministic synthetic load-test fixtures");

  seed
    .command("users")
    .description(
      "create or reuse many accounts, and optionally add them directly as collaborators to a project",
    )
    .requiredOption("--count <n>", "number of accounts to create or reuse")
    .requiredOption(
      "--prefix <prefix>",
      "email prefix, used as '<prefix>-NNNN@<domain>'",
    )
    .option(
      "--domain <domain>",
      "email domain for synthetic accounts",
      "load.test",
    )
    .option("--start <n>", "starting numeric suffix", "1")
    .option("--concurrency <n>", "parallel workers", "8")
    .option(
      "-w, --project <project>",
      "project id or name to add as collaborator",
    )
    .option(
      "--password <password>",
      "shared password for all created accounts (omit to auto-generate)",
    )
    .option("--tag <tag...>", "additional tags for newly created accounts")
    .option("--no-reuse-existing", "fail if a target email already exists")
    .option("--full", "include all per-account rows in the output")
    .action(
      async (
        opts: {
          count?: string;
          prefix?: string;
          domain?: string;
          start?: string;
          concurrency?: string;
          project?: string;
          password?: string;
          tag?: string[];
          reuseExisting?: boolean;
          full?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "load seed users", async (ctx) => {
          const count = parsePositiveInteger(opts.count, "--count", 1);
          const start = parsePositiveInteger(opts.start, "--start", 1);
          const concurrency = parsePositiveInteger(
            opts.concurrency,
            "--concurrency",
            8,
          );
          const prefix = normalizeNonEmpty(opts.prefix, "--prefix");
          const domain = normalizeNonEmpty(opts.domain, "--domain");
          const width = Math.max(4, String(start + count - 1).length);
          const baseTags = ["load-test", "load-seed", `load-seed:${prefix}`];
          const tags = Array.from(
            new Set(
              [...baseTags, ...(opts.tag ?? []).map((tag) => `${tag}`.trim())]
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          );
          const startedAt = new Date();
          const started = performance.now();
          const project = opts.project
            ? await resolveProjectFromArgOrContext(ctx, opts.project)
            : null;
          const workerCount = Math.min(concurrency, count);
          const rows: SeedScenarioResult[] = [];
          const sampleErrors: string[] = [];
          let nextIndex = 0;
          let created = 0;
          let reused = 0;
          let collaboratorsAdded = 0;
          let collaboratorsExisting = 0;
          let failures = 0;

          const workers = Array.from({ length: workerCount }, async () => {
            while (true) {
              const offset = nextIndex++;
              if (offset >= count) {
                return;
              }
              const index = start + offset;
              const email = buildSeedEmail({
                prefix,
                domain,
                index,
                width,
              });
              const row: SeedScenarioResult = {
                index,
                email,
              };
              try {
                let account = null as null | {
                  account_id: string;
                  first_name?: string | null;
                  last_name?: string | null;
                  email_address?: string | null;
                };
                let accountStatus: "created" | "reused" = "created";
                try {
                  const createdAccount = await ctx.hub.system.adminCreateUser({
                    email,
                    password: opts.password,
                    first_name: "Load",
                    last_name: `${prefix}-${index}`,
                    tags,
                  });
                  account = createdAccount;
                  created += 1;
                } catch (err) {
                  if (!opts.reuseExisting) {
                    throw err;
                  }
                  const existing = await findAccountByEmailExact(ctx, email);
                  if (!existing?.account_id) {
                    throw err;
                  }
                  account = existing;
                  accountStatus = "reused";
                  reused += 1;
                }
                if (!account?.account_id) {
                  throw new Error(`unable to resolve account for '${email}'`);
                }

                row.account_id = account.account_id;
                row.account_status = accountStatus;

                if (project?.project_id) {
                  try {
                    await ctx.hub.projects.createCollabInvite({
                      project_id: project.project_id,
                      invitee_account_id: account.account_id,
                      direct: true,
                    });
                    row.collaborator_status = "added";
                    collaboratorsAdded += 1;
                  } catch (err) {
                    if (!isAlreadyCollaboratorError(err)) {
                      throw err;
                    }
                    row.collaborator_status = "existing";
                    collaboratorsExisting += 1;
                  }
                }
              } catch (err) {
                failures += 1;
                row.error = err instanceof Error ? err.message : `${err}`;
                if (sampleErrors.length < 10) {
                  sampleErrors.push(`${email}: ${row.error}`);
                }
              }
              rows.push(row);
            }
          });

          await Promise.all(workers);

          rows.sort((a, b) => Number(a.index) - Number(b.index));
          const elapsed = performance.now() - started;
          return {
            scenario: "seed-users",
            started_at: startedAt.toISOString(),
            finished_at: new Date().toISOString(),
            wall_ms: roundMs(elapsed),
            accounts_per_sec:
              count <= 0 || elapsed <= 0
                ? 0
                : roundMs((count * 1000) / elapsed),
            count_requested: count,
            count_processed: rows.length,
            start_index: start,
            end_index: start + count - 1,
            concurrency: workerCount,
            prefix,
            domain,
            email_pattern: `${prefix}-{n}@${domain}`,
            tags,
            project_id: project?.project_id ?? null,
            project_title: project?.title ?? null,
            accounts_created: created,
            accounts_reused: reused,
            collaborators_added: collaboratorsAdded,
            collaborators_existing: collaboratorsExisting,
            failures,
            sample_errors: sampleErrors,
            sample_rows: rows.slice(0, 10),
            last_row: rows[rows.length - 1] ?? null,
            ...(opts.full ? { rows } : undefined),
          };
        });
      },
    );

  return load;
}
