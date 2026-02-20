import { Command } from "commander";

export function registerOpCommand(program: Command, deps: any): Command {
  const {
    withContext,
    resolveWorkspace,
    resolveHost,
    parseLroScopeType,
    serializeLroSummary,
    waitForLro,
  } = deps;

  const op = program.command("op").description("long-running operation management");

  op
    .command("list")
    .description("list operations for a scope")
    .option("--scope-type <type>", "scope type: project|account|host|hub")
    .option("--scope-id <id>", "scope id")
    .option("--workspace <workspace>", "workspace id or name")
    .option("--host <host>", "host id or name")
    .option("--include-completed", "include completed operations")
    .option("--limit <n>", "max rows", "100")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "op list", async (ctx: any) => {
        const haveExplicitScope = !!opts.scopeType || !!opts.scopeId;
        const haveWorkspace = !!opts.workspace;
        const haveHost = !!opts.host;
        const scopeModes = Number(haveExplicitScope) + Number(haveWorkspace) + Number(haveHost);
        if (scopeModes > 1) {
          throw new Error(
            "use only one scope selector: (--scope-type + --scope-id) OR --workspace OR --host",
          );
        }

        let scope_type: any;
        let scope_id: string;

        if (haveWorkspace) {
          const ws = await resolveWorkspace(ctx, opts.workspace);
          scope_type = "project";
          scope_id = ws.project_id;
        } else if (haveHost) {
          const h = await resolveHost(ctx, opts.host);
          scope_type = "host";
          scope_id = h.id;
        } else if (haveExplicitScope) {
          if (!opts.scopeType || !opts.scopeId) {
            throw new Error("--scope-type and --scope-id must be used together");
          }
          scope_type = parseLroScopeType(opts.scopeType);
          scope_id = opts.scopeId;
        } else {
          scope_type = "account";
          scope_id = ctx.accountId;
        }

        const rows = await ctx.hub.lro.list({
          scope_type,
          scope_id,
          include_completed: !!opts.includeCompleted,
        });
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "100") || 100));
        return (rows ?? []).slice(0, limitNum).map((summary: any) => serializeLroSummary(summary));
      });
    });

  op
    .command("get <op-id>")
    .description("get one operation by id")
    .action(async (opId: string, command: Command) => {
      await withContext(command, "op get", async (ctx: any) => {
        const summary = await ctx.hub.lro.get({ op_id: opId });
        if (!summary) {
          throw new Error(`operation '${opId}' not found`);
        }
        return serializeLroSummary(summary);
      });
    });

  op
    .command("wait <op-id>")
    .description("wait until an operation reaches a terminal state")
    .action(async (opId: string, command: Command) => {
      await withContext(command, "op wait", async (ctx: any) => {
        const waited = await waitForLro(ctx, opId, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (waited.timedOut) {
          throw new Error(`timeout waiting for operation ${opId}; last status=${waited.status}`);
        }
        const summary = await ctx.hub.lro.get({ op_id: opId });
        if (!summary) {
          return {
            op_id: opId,
            status: waited.status,
            error: waited.error ?? null,
          };
        }
        return serializeLroSummary(summary);
      });
    });

  op
    .command("cancel <op-id>")
    .description("cancel an operation")
    .action(async (opId: string, command: Command) => {
      await withContext(command, "op cancel", async (ctx: any) => {
        await ctx.hub.lro.cancel({ op_id: opId });
        const summary = await ctx.hub.lro.get({ op_id: opId });
        if (!summary) {
          return {
            op_id: opId,
            status: "canceled",
          };
        }
        return serializeLroSummary(summary);
      });
    });

  return op;
}
