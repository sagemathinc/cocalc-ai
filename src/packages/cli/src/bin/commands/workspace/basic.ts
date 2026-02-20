/**
 * Basic workspace lifecycle and metadata commands.
 *
 * Includes list/get/context management plus create/start/stop/restart/delete.
 * This is the "core admin surface" for direct workspace operations.
 */
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

export function registerWorkspaceBasicCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const {
    withContext,
    resolveHost,
    queryProjects,
    workspaceState,
    toIso,
    resolveWorkspaceFromArgOrContext,
    resolveWorkspace,
    saveWorkspaceContext,
    workspaceContextPath,
    clearWorkspaceContext,
    isValidUUID,
    confirmHardWorkspaceDelete,
    waitForLro,
    waitForWorkspaceNotRunning,
    runLocalCommand,
  } = deps;

workspace
  .command("list")
  .description("list workspaces")
  .option("--host <host>", "filter by host id or name")
  .option("--prefix <prefix>", "filter title by prefix")
  .option("--limit <n>", "max rows", "100")
  .action(
    async (
      opts: { host?: string; prefix?: string; limit?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace list", async (ctx) => {
        const hostId = opts.host ? (await resolveHost(ctx, opts.host)).id : null;
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "100") || 100));
        const prefix = opts.prefix?.trim() || "";
        // Deleted workspaces are still returned by projects_all; overfetch so we can
        // filter locally and still satisfy requested limits.
        const fetchLimit = Math.min(10000, Math.max(limitNum * 10, 200));
        const rows = await queryProjects({
          ctx,
          host_id: hostId,
          limit: fetchLimit,
        });
        const normalizedPrefix = prefix.toLowerCase();
        const filtered = normalizedPrefix
          ? rows.filter((row) => row.title.toLowerCase().startsWith(normalizedPrefix))
          : rows;
        return filtered.slice(0, limitNum).map((row) => ({
          workspace_id: row.project_id,
          title: row.title,
          host_id: row.host_id,
          state: workspaceState(row.state),
          last_edited: toIso(row.last_edited),
        }));
      });
    },
  );

workspace
  .command("get")
  .description("get one workspace by id or name (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace get", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      return {
        workspace_id: ws.project_id,
        title: ws.title,
        host_id: ws.host_id,
        state: workspaceState(ws.state),
        last_edited: toIso(ws.last_edited),
      };
    });
  });

workspace
  .command("create [name]")
  .description("create a workspace")
  .option("--host <host>", "host id or name")
  .action(async (name: string | undefined, opts: { host?: string }, command: Command) => {
    await withContext(command, "workspace create", async (ctx) => {
      const host = opts.host ? await resolveHost(ctx, opts.host) : null;
      const workspaceId = await ctx.hub.projects.createProject({
        title: name ?? "New Workspace",
        host_id: host?.id,
        start: false,
      });
      return {
        workspace_id: workspaceId,
        title: name ?? "New Workspace",
        host_id: host?.id ?? null,
      };
    });
  });

workspace
  .command("rename <title>")
  .description("rename a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (title: string, opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace rename", async (ctx) => {
      const nextTitle = title.trim();
      if (!nextTitle) {
        throw new Error("title must be non-empty");
      }
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await ctx.hub.db.userQuery({
        query: {
          projects: [{ project_id: ws.project_id, title: nextTitle }],
        },
        options: [],
      });
      return {
        workspace_id: ws.project_id,
        title: nextTitle,
      };
    });
  });

workspace
  .command("use")
  .description("set default workspace for this directory")
  .requiredOption("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace: string }, command: Command) => {
    await withContext(command, "workspace use", async (ctx) => {
      const ws = await resolveWorkspace(ctx, opts.workspace);
      saveWorkspaceContext({
        workspace_id: ws.project_id,
        title: ws.title,
      });
      return {
        context_path: workspaceContextPath(),
        workspace_id: ws.project_id,
        title: ws.title,
      };
    });
  });

workspace
  .command("unuse")
  .description("clear default workspace for this directory")
  .action(async (command: Command) => {
    await runLocalCommand(command, "workspace unuse", async () => {
      const removed = clearWorkspaceContext();
      return {
        context_path: workspaceContextPath(),
        removed,
      };
    });
  });

workspace
  .command("delete")
  .description("delete a workspace (soft by default; permanent with --hard)")
  .requiredOption("-w, --workspace <project_id>", "workspace project_id (UUID)")
  .option("--hard", "permanently delete workspace data and metadata")
  .option(
    "--backup-retention-days <days>",
    "when --hard, keep backups this many days before purge (default: 7)",
    "7",
  )
  .option("--purge-backups-now", "when --hard, purge backups immediately")
  .option("--wait", "when --hard, wait for delete completion")
  .option("-y, --yes", "when --hard, skip interactive confirmation")
  .action(
    async (
      opts: {
        workspace: string;
        hard?: boolean;
        backupRetentionDays?: string;
        purgeBackupsNow?: boolean;
        wait?: boolean;
        yes?: boolean;
      },
      command: Command,
    ) => {
    await withContext(command, "workspace delete", async (ctx) => {
      const projectId = `${opts.workspace ?? ""}`.trim();
      if (!isValidUUID(projectId)) {
        throw new Error("--workspace must be a workspace project_id UUID");
      }
      const ws = await resolveWorkspace(ctx, projectId);
      if (!opts.hard) {
        await ctx.hub.projects.deleteProject({
          project_id: ws.project_id,
        });
        return {
          workspace_id: ws.project_id,
          status: "deleted",
          mode: "soft",
        };
      }

      const retentionRaw = Number(opts.backupRetentionDays ?? "7");
      if (!Number.isFinite(retentionRaw) || retentionRaw < 0) {
        throw new Error("--backup-retention-days must be a non-negative number");
      }
      const backupRetentionDays = Math.floor(retentionRaw);
      const purgeBackupsNow = !!opts.purgeBackupsNow || backupRetentionDays === 0;

      if (!opts.yes) {
        await confirmHardWorkspaceDelete({
          workspace_id: ws.project_id,
          title: ws.title,
          backupRetentionDays,
          purgeBackupsNow,
        });
      }

      const op = await ctx.hub.projects.hardDeleteProject({
        project_id: ws.project_id,
        backup_retention_days: backupRetentionDays,
        purge_backups_now: purgeBackupsNow,
      });
      if (!opts.wait) {
        return {
          workspace_id: ws.project_id,
          op_id: op.op_id,
          status: "queued",
          mode: "hard",
          backup_retention_days: backupRetentionDays,
          purge_backups_now: purgeBackupsNow,
        };
      }
      const summary = await waitForLro(ctx, op.op_id, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (summary.timedOut) {
        throw new Error(
          `hard delete timed out (op=${op.op_id}, last_status=${summary.status})`,
        );
      }
      if (summary.status !== "succeeded") {
        throw new Error(
          `hard delete failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
        );
      }
      return {
        workspace_id: ws.project_id,
        op_id: op.op_id,
        status: summary.status,
        mode: "hard",
        backup_retention_days: backupRetentionDays,
        purge_backups_now: purgeBackupsNow,
      };
    });
    },
  );

workspace
  .command("undelete")
  .description("undelete a workspace")
  .requiredOption("-w, --workspace <project_id>", "workspace project_id (UUID)")
  .action(async (opts: { workspace: string }, command: Command) => {
    await withContext(command, "workspace undelete", async (ctx) => {
      const projectId = `${opts.workspace ?? ""}`.trim();
      if (!isValidUUID(projectId)) {
        throw new Error("--workspace must be a workspace project_id UUID");
      }
      await ctx.hub.projects.setProjectDeleted({
        project_id: projectId,
        deleted: false,
      });
      return {
        workspace_id: projectId,
        status: "active",
        mode: "soft",
      };
    });
  });

workspace
  .command("start")
  .description("start a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait for completion")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace start", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const op = await ctx.hub.projects.start({
        project_id: ws.project_id,
        wait: false,
      });

      if (opts.wait) {
        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`timeout waiting for start op ${op.op_id}; last status=${summary.status}`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(`start failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
        }
        return {
          workspace_id: ws.project_id,
          op_id: op.op_id,
          status: summary.status,
        };
      }

      return {
        workspace_id: ws.project_id,
        op_id: op.op_id,
        status: "queued",
      };
    });
  });

workspace
  .command("stop")
  .description("stop a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait until the workspace is not running")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace stop", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await ctx.hub.projects.stop({
        project_id: ws.project_id,
      });

      if (opts.wait) {
        const wait = await waitForWorkspaceNotRunning(ctx, ws.project_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (!wait.ok) {
          throw new Error(
            `timeout waiting for workspace to stop (workspace=${ws.project_id}, last_state=${wait.state || "running"})`,
          );
        }
        return {
          workspace_id: ws.project_id,
          status: wait.state || "stopped",
        };
      }

      return {
        workspace_id: ws.project_id,
        status: "stop_requested",
      };
    });
  });

workspace
  .command("restart")
  .description("restart a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait for restart completion")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace restart", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await ctx.hub.projects.stop({
        project_id: ws.project_id,
      });

      const op = await ctx.hub.projects.start({
        project_id: ws.project_id,
        wait: false,
      });

      if (opts.wait) {
        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(
            `timeout waiting for restart op ${op.op_id}; last status=${summary.status}`,
          );
        }
        if (summary.status !== "succeeded") {
          throw new Error(
            `restart failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
          );
        }
        return {
          workspace_id: ws.project_id,
          op_id: op.op_id,
          status: summary.status,
        };
      }

      return {
        workspace_id: ws.project_id,
        op_id: op.op_id,
        status: "queued",
      };
    });
  });

workspace
  .command("exec [command...]")
  .description("execute a command in a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--timeout <seconds>", "command timeout seconds", "60")
  .option("--path <path>", "working path inside workspace")
  .option("--bash", "treat command as a bash command string")
  .action(
    async (
      commandArgs: string[],
      opts: { workspace?: string; timeout?: string; path?: string; bash?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace exec", async (ctx) => {
        const execArgs = Array.isArray(commandArgs)
          ? commandArgs
          : commandArgs
            ? [commandArgs]
            : [];
        if (!execArgs.length) {
          throw new Error("command is required");
        }
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const timeout = Number(opts.timeout ?? "60");
        const [first, ...rest] = execArgs;
        const execOpts = opts.bash
          ? {
              command: execArgs.join(" "),
              bash: true,
              timeout,
              err_on_exit: false,
              path: opts.path,
            }
          : {
              command: first,
              args: rest,
              bash: false,
              timeout,
              err_on_exit: false,
              path: opts.path,
            };

        const result = await ctx.hub.projects.exec({
          project_id: ws.project_id,
          execOpts,
        });

        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          if (result.exit_code !== 0) {
            process.exitCode = result.exit_code;
          }
        }

        return {
          workspace_id: ws.project_id,
          ...result,
        };
      });
    },
  );
}
