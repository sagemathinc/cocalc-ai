/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc admin parallel-ops ...`: read and set the hub's worker concurrency
// limits (the same overrides as the Hosts page's parallel-ops panel), so a
// limit can be set on many hosts at once from a script.
//
// Per-project-host workers (e.g. project-host-backup-execution) resolve only
// per-host overrides, with no global fallback, hence --all-hosts. Changing a
// limit needs a fresh sign-in with two-factor: run `cocalc auth elevate`.

import { Command } from "commander";
import type {
  ParallelOpsLimitResolution,
  ParallelOpsWorkerStatus,
} from "@cocalc/conat/hub/api/system";
import { listHosts, resolveHost } from "../../core/project-resolve";

export type ParallelOpsCommandDeps = {
  withContext: any;
};

interface HostRef {
  id: string;
  name: string;
  status?: string;
}

function collect(value: string, values: string[] = []): string[] {
  for (const v of value.split(",")) {
    if (v.trim()) values.push(v.trim());
  }
  return values;
}

function positiveInteger(flag: string) {
  return (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${flag} must be a positive integer`);
    }
    return n;
  };
}

// The limit-changing calls need a fresh sign-in; say how to get one.
function explain(err: unknown): string {
  const message = `${(err as Error)?.message ?? err}`;
  return /fresh|two-factor|second factor/i.test(message)
    ? `${message} (run \`cocalc auth elevate\` first, approving with two-factor)`
    : message;
}

export function statusRows(workers: ParallelOpsWorkerStatus[]) {
  return workers.map((w) => ({
    worker: w.worker_kind,
    scope: w.scope_model,
    running: w.running_count,
    queued: w.queued_count,
    limit: w.effective_limit,
    default: w.default_limit,
    source: w.config_source,
    settable: w.dynamic_limit_supported,
  }));
}

export async function findWorker(
  ctx: any,
  worker_kind: string,
): Promise<ParallelOpsWorkerStatus> {
  const workers: ParallelOpsWorkerStatus[] =
    await ctx.hub.system.getParallelOpsStatus({});
  const worker = workers.find((w) => w.worker_kind === worker_kind);
  if (!worker) {
    throw new Error(
      `unknown worker '${worker_kind}'; known workers: ${workers
        .map((w) => w.worker_kind)
        .sort()
        .join(", ")}`,
    );
  }
  return worker;
}

// The hosts to act on: those named, or every running host the admin sees.
export async function targetHosts(
  ctx: any,
  opts: { host?: string[]; allHosts?: boolean },
): Promise<HostRef[]> {
  if (opts.allHosts && opts.host?.length) {
    throw new Error("give --host or --all-hosts, not both");
  }
  if (opts.allHosts) {
    const hosts = (await listHosts(ctx, { admin_view: true })) as HostRef[];
    return hosts.filter((h) => h.status === "running");
  }
  if (!opts.host?.length) {
    throw new Error(
      "this worker's limit is per host: give --host <id|name> (repeatable) or --all-hosts",
    );
  }
  const out: HostRef[] = [];
  for (const id of opts.host) {
    out.push((await resolveHost(ctx, id, { admin_view: true })) as HostRef);
  }
  return out;
}

async function hostLimit(
  ctx: any,
  worker_kind: string,
  host_id: string,
): Promise<ParallelOpsLimitResolution> {
  return await ctx.hub.system.getProjectHostParallelOpsLimit({
    host_id,
    worker_kind,
  });
}

function scopeFor(
  worker: ParallelOpsWorkerStatus,
  opts: { host?: string[]; allHosts?: boolean; provider?: string },
): { scope_type: "global" | "provider" } {
  if (opts.host?.length || opts.allHosts) {
    throw new Error(
      `'${worker.worker_kind}' has a ${worker.scope_model} limit, not a per-host one: drop --host/--all-hosts`,
    );
  }
  if (opts.provider) {
    if (worker.scope_model !== "per-provider") {
      throw new Error(
        `'${worker.worker_kind}' has a ${worker.scope_model} limit, not a per-provider one: drop --provider`,
      );
    }
    return { scope_type: "provider" };
  }
  return { scope_type: "global" };
}

// Set (limit given) or clear (limit undefined) on every target; one row per
// target with its limit before and after. A failure on one host doesn't stop
// the others; the command then exits non-zero.
async function change(
  ctx: any,
  opts: {
    worker: string;
    limit?: number;
    host?: string[];
    allHosts?: boolean;
    provider?: string;
    note?: string;
    dryRun?: boolean;
  },
) {
  const worker = await findWorker(ctx, opts.worker);
  if (!worker.dynamic_limit_supported) {
    throw new Error(`'${worker.worker_kind}' has no settable limit`);
  }
  const verb = opts.limit == null ? "clear" : "set";
  const write = async (scope: {
    scope_type: "global" | "provider" | "project_host";
    scope_id?: string;
  }) => {
    if (opts.limit == null) {
      await ctx.hub.system.clearParallelOpsLimit({
        worker_kind: worker.worker_kind,
        ...scope,
      });
    } else {
      await ctx.hub.system.setParallelOpsLimit({
        worker_kind: worker.worker_kind,
        ...scope,
        limit_value: opts.limit,
        ...(opts.note ? { note: opts.note } : {}),
      });
    }
  };
  let failed = 0;

  if (worker.scope_model === "per-project-host") {
    if (opts.provider) {
      throw new Error(`'${worker.worker_kind}' is per host: drop --provider`);
    }
    const hosts = await targetHosts(ctx, opts);
    const rows: Record<string, unknown>[] = [];
    for (const host of hosts) {
      const row: Record<string, unknown> = {
        host: host.name,
        host_id: host.id,
        before: null,
        after: null,
        source: null,
        result: "",
      };
      try {
        const before = await hostLimit(ctx, worker.worker_kind, host.id);
        row.before = before.effective_limit;
        if (opts.dryRun) {
          row.after =
            opts.limit ??
            (before.configured_limit == null
              ? before.effective_limit
              : before.default_limit);
          row.source = opts.limit == null ? "default" : "db-override";
          row.result = `would ${verb}`;
        } else {
          await write({ scope_type: "project_host", scope_id: host.id });
          const after = await hostLimit(ctx, worker.worker_kind, host.id);
          row.after = after.effective_limit;
          row.source = after.config_source;
          row.result = verb === "set" ? "set" : "cleared";
        }
      } catch (err) {
        failed += 1;
        row.result = `error: ${explain(err)}`;
      }
      rows.push(row);
    }
    if (failed > 0) process.exitCode = 1;
    return rows;
  }

  const scope = scopeFor(worker, opts);
  const target = {
    ...scope,
    ...(scope.scope_type === "provider" ? { scope_id: opts.provider } : {}),
  };
  const row: Record<string, unknown> = {
    worker: worker.worker_kind,
    scope: target.scope_type,
    scope_id: target.scope_id ?? null,
    before: worker.effective_limit,
    after: null,
    result: "",
  };
  if (opts.dryRun) {
    row.after = opts.limit ?? worker.default_limit;
    row.result = `would ${verb}`;
    return [row];
  }
  try {
    await write(target);
    row.after = (await findWorker(ctx, worker.worker_kind)).effective_limit;
    row.result = verb === "set" ? "set" : "cleared";
  } catch (err) {
    throw new Error(explain(err));
  }
  return [row];
}

export function registerParallelOpsCommand(
  admin: Command,
  deps: ParallelOpsCommandDeps,
): Command {
  const ops = admin
    .command("parallel-ops")
    .description(
      "worker concurrency limits (as on the Hosts page); changing one needs `cocalc auth elevate` first",
    )
    .addHelpText(
      "after",
      `
Per-host workers (e.g. project-host-backup-execution) have no global limit:
set them per host, or on every running host at once:

  cocalc admin parallel-ops get --worker project-host-backup-execution --all-hosts
  cocalc auth elevate
  cocalc admin parallel-ops set --worker project-host-backup-execution --limit 1 --all-hosts --dry-run
  cocalc admin parallel-ops set --worker project-host-backup-execution --limit 1 --all-hosts --note "one backup per host"
`,
    );

  ops
    .command("status")
    .description(
      "every worker: running, queued, effective limit and its source",
    )
    .action(async (_opts: any, command: Command) => {
      await deps.withContext(
        command,
        "admin parallel-ops status",
        async (ctx) => {
          const workers = await ctx.hub.system.getParallelOpsStatus({});
          return ctx.globals?.json || ctx.globals?.output === "json"
            ? workers
            : statusRows(workers);
        },
      );
    });

  ops
    .command("get")
    .description(
      "a worker's effective, default and configured limit (per host for per-host workers)",
    )
    .requiredOption("--worker <kind>", "worker kind (see `status`)")
    .option("--host <id|name>", "a host (repeatable)", collect)
    .option("--all-hosts", "every running host")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(command, "admin parallel-ops get", async (ctx) => {
        const worker = await findWorker(ctx, opts.worker);
        if (worker.scope_model !== "per-project-host") {
          scopeFor(worker, opts);
          return [
            {
              worker: worker.worker_kind,
              scope: worker.scope_model,
              effective: worker.effective_limit,
              default: worker.default_limit,
              configured: worker.configured_limit,
              source: worker.config_source,
            },
          ];
        }
        const hosts = await targetHosts(ctx, opts);
        const rows: Record<string, unknown>[] = [];
        for (const host of hosts) {
          try {
            const r = await hostLimit(ctx, worker.worker_kind, host.id);
            rows.push({
              host: host.name,
              host_id: host.id,
              effective: r.effective_limit,
              default: r.default_limit,
              configured: r.configured_limit,
              source: r.config_source,
            });
          } catch (err) {
            process.exitCode = 1;
            rows.push({
              host: host.name,
              host_id: host.id,
              error: `${(err as Error)?.message ?? err}`,
            });
          }
        }
        return rows;
      });
    });

  ops
    .command("set")
    .description(
      "set a worker's limit: per host (--host/--all-hosts), per provider (--provider) or global",
    )
    .requiredOption("--worker <kind>", "worker kind (see `status`)")
    .requiredOption("--limit <n>", "the new limit", positiveInteger("--limit"))
    .option("--host <id|name>", "a host (repeatable)", collect)
    .option("--all-hosts", "every running host")
    .option("--provider <name>", "one cloud provider (per-provider workers)")
    .option("--note <text>", "why, kept with the override")
    .option("--dry-run", "show what would change, without changing it")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(command, "admin parallel-ops set", async (ctx) =>
        change(ctx, opts),
      );
    });

  ops
    .command("clear")
    .description("remove a worker's override, back to its default")
    .requiredOption("--worker <kind>", "worker kind (see `status`)")
    .option("--host <id|name>", "a host (repeatable)", collect)
    .option("--all-hosts", "every running host")
    .option("--provider <name>", "one cloud provider (per-provider workers)")
    .option("--dry-run", "show what would change, without changing it")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(command, "admin parallel-ops clear", async (ctx) =>
        change(ctx, { ...opts, limit: undefined }),
      );
    });

  return ops;
}
