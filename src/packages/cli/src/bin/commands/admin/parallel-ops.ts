/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc admin parallel-ops ...`: read and set the hub's worker concurrency
// limits (the same overrides as the Hosts page's parallel-ops panel), so a
// limit can be set on many hosts at once from a script.
//
// Per-project-host workers (e.g. project-host-backup-execution) resolve only
// per-host overrides, with no global fallback, hence --all-hosts. These
// calls aren't routed to a host's owning bay yet, so the command only acts
// on hosts owned by the bay it is connected to; another bay's host is
// reported as an error, never as changed. Other
// workers have one global limit (per-provider overrides aren't offered: the
// hub has no per-provider read to report them truthfully). Changing a limit
// needs a fresh sign-in with two-factor: run `cocalc auth elevate`.

import { Command } from "commander";
import type {
  ParallelOpsLimitResolution,
  ParallelOpsWorkerStatus,
} from "@cocalc/conat/hub/api/system";
import { listHosts } from "../../core/project-resolve";

export type ParallelOpsCommandDeps = {
  withContext: any;
};

interface HostRef {
  id: string;
  name: string;
  status?: string;
  // the owning bay, from the (federated) host listing
  bay_id?: string | null;
  // a name that couldn't be resolved: reported, the rest still run
  error?: string;
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
  // Matched against the admin host list itself, by id or name: an unknown
  // or deleted id is an error, never a stand-in (an override stored for a
  // host that doesn't exist would do nothing).
  const known = (await listHosts(ctx, { admin_view: true })) as HostRef[];
  const out: HostRef[] = [];
  for (const id of opts.host) {
    const byId = known.find((h) => h.id === id);
    const byName = known.filter((h) => h.name === id);
    if (byId) out.push(byId);
    else if (byName.length === 1) out.push(byName[0]);
    else
      out.push({
        id: "",
        name: id,
        error:
          byName.length > 1
            ? `host name '${id}' is ambiguous: ${byName.map((h) => h.id).join(", ")}`
            : `host '${id}' not found`,
      });
  }
  return out;
}

// The bay this command talks to, and a check that a host is owned by it:
// the per-host limit calls run where they are received, so a host on
// another bay would get an override its own bay never reads. The owner is
// the federated host row's bay_id (a lookup on this bay would default an
// unknown host to this bay). A host with no recorded bay counts as local
// only on a single-bay deployment.
function localBayCheck(ctx: any) {
  let local: Promise<{ bay_id: string; deployment_mode?: string }> | undefined;
  return async (host: HostRef): Promise<void> => {
    local ??= ctx.hub.system.getBayLoad({});
    const here = await local!;
    const owner = `${host.bay_id ?? ""}`.trim();
    if (!owner) {
      if (here.deployment_mode === "single-bay") return;
      throw new Error(
        `host's bay is unknown on this multibay deployment; not changed`,
      );
    }
    if (owner !== here.bay_id) {
      throw new Error(
        `host is on bay ${owner}, not ${here.bay_id}; run this against that bay`,
      );
    }
  };
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

function requireGlobal(
  worker: ParallelOpsWorkerStatus,
  opts: { host?: string[]; allHosts?: boolean },
): void {
  if (opts.host?.length || opts.allHosts) {
    throw new Error(
      `'${worker.worker_kind}' has a ${worker.scope_model} limit, not a per-host one: drop --host/--all-hosts`,
    );
  }
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
    scope_type: "global" | "project_host";
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
    const hosts = await targetHosts(ctx, opts);
    const ownedHere = localBayCheck(ctx);
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
        if (host.error) throw new Error(host.error);
        await ownedHere(host);
        const before = await hostLimit(ctx, worker.worker_kind, host.id);
        row.before = before.effective_limit;
        if (opts.dryRun) {
          // nothing written; what it becomes is shown by the real run
          row.result =
            opts.limit == null
              ? "would clear (back to the default)"
              : `would set to ${opts.limit}`;
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

  requireGlobal(worker, opts);
  const row: Record<string, unknown> = {
    worker: worker.worker_kind,
    scope: "global",
    before: worker.effective_limit,
    after: null,
    result: "",
  };
  if (opts.dryRun) {
    row.result =
      opts.limit == null
        ? "would clear (back to the default)"
        : `would set to ${opts.limit}`;
    return [row];
  }
  try {
    await write({ scope_type: "global" });
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
          requireGlobal(worker, opts);
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
        const ownedHere = localBayCheck(ctx);
        const rows: Record<string, unknown>[] = [];
        for (const host of hosts) {
          try {
            if (host.error) throw new Error(host.error);
            await ownedHere(host);
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
      "set a worker's limit: per host (--host/--all-hosts) for per-host workers, otherwise global",
    )
    .requiredOption("--worker <kind>", "worker kind (see `status`)")
    .requiredOption("--limit <n>", "the new limit", positiveInteger("--limit"))
    .option("--host <id|name>", "a host (repeatable)", collect)
    .option("--all-hosts", "every running host")
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
    .option("--dry-run", "show what would change, without changing it")
    .action(async (opts: any, command: Command) => {
      await deps.withContext(command, "admin parallel-ops clear", async (ctx) =>
        change(ctx, { ...opts, limit: undefined }),
      );
    });

  return ops;
}
