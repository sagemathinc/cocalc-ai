/**
 * Basic project lifecycle and metadata commands.
 *
 * Includes list/get/context management plus create/start/stop/restart/delete.
 * This is the "core admin surface" for direct project operations.
 */
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

export function getProjectExecTimeoutSeconds(argv = process.argv): number {
  const timeout = extractProjectExecTimeout(argv);
  if (timeout != null && Number.isFinite(timeout) && timeout > 0) {
    return timeout;
  }
  return 60;
}

function extractProjectExecTimeout(argv: string[]): number | null {
  const start = findProjectExecArgs(argv);
  if (start === -1) {
    return null;
  }
  for (let i = start; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      break;
    }
    if (!token.startsWith("-")) {
      break;
    }
    if (token === "--timeout") {
      const value = Number(argv[i + 1] ?? "");
      return Number.isFinite(value) ? value : null;
    }
    if (token.startsWith("--timeout=")) {
      const value = Number(token.slice("--timeout=".length));
      return Number.isFinite(value) ? value : null;
    }
    if (token === "--project" || token === "-w" || token === "--path") {
      i += 1;
    }
  }
  return null;
}

function findProjectExecArgs(argv: string[]): number {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "project" && argv[i + 1] === "exec") {
      return i + 2;
    }
  }
  return -1;
}

export function registerProjectBasicCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveHost,
    queryProjects,
    projectState,
    toIso,
    resolveProjectFromArgOrContext,
    resolveProject,
    saveProjectContext,
    projectContextPath,
    clearProjectContext,
    isValidUUID,
    confirmHardProjectDelete,
    waitForLro,
    waitForProjectNotRunning,
    runLocalCommand,
  } = deps;

  project
    .command("list")
    .description("list projects")
    .option("--host <host>", "filter by host id or name")
    .option("--prefix <prefix>", "filter title by prefix")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: { host?: string; prefix?: string; limit?: string },
        command: Command,
      ) => {
        await withContext(command, "project list", async (ctx) => {
          const hostId = opts.host
            ? (await resolveHost(ctx, opts.host)).id
            : null;
          const limitNum = Math.max(
            1,
            Math.min(10000, Number(opts.limit ?? "100") || 100),
          );
          const prefix = opts.prefix?.trim() || "";
          // Deleted projects are still returned by projects_all; overfetch so we can
          // filter locally and still satisfy requested limits.
          const fetchLimit = Math.min(10000, Math.max(limitNum * 10, 200));
          const rows = await queryProjects({
            ctx,
            host_id: hostId,
            limit: fetchLimit,
          });
          const normalizedPrefix = prefix.toLowerCase();
          const filtered = normalizedPrefix
            ? rows.filter((row) =>
                row.title.toLowerCase().startsWith(normalizedPrefix),
              )
            : rows;
          return filtered.slice(0, limitNum).map((row) => ({
            project_id: row.project_id,
            title: row.title,
            host_id: row.host_id,
            state: projectState(row.state),
            last_edited: toIso(row.last_edited),
          }));
        });
      },
    );

  project
    .command("get")
    .description("get one project by id or name (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project get", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        return {
          project_id: ws.project_id,
          title: ws.title,
          host_id: ws.host_id,
          state: projectState(ws.state),
          last_edited: toIso(ws.last_edited),
        };
      });
    });

  project
    .command("create [name]")
    .description("create a project")
    .option("--host <host>", "host id or name")
    .option("--rootfs-image <image>", "runtime RootFS image to assign")
    .option(
      "--rootfs-image-id <id>",
      "managed RootFS catalog entry id to record on the project",
    )
    .option("--start", "start the project after creating it")
    .action(
      async (
        name: string | undefined,
        opts: {
          host?: string;
          rootfsImage?: string;
          rootfsImageId?: string;
          start?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project create", async (ctx) => {
          const host = opts.host ? await resolveHost(ctx, opts.host) : null;
          const rootfs_image = `${opts.rootfsImage ?? ""}`.trim() || undefined;
          const rootfs_image_id =
            `${opts.rootfsImageId ?? ""}`.trim() || undefined;
          const projectId = await ctx.hub.projects.createProject({
            title: name ?? "New Project",
            host_id: host?.id,
            rootfs_image,
            rootfs_image_id,
            start: !!opts.start,
          });
          return {
            project_id: projectId,
            title: name ?? "New Project",
            host_id: host?.id ?? null,
            rootfs_image: rootfs_image ?? null,
            rootfs_image_id: rootfs_image_id ?? null,
            started: !!opts.start,
          };
        });
      },
    );

  project
    .command("rename <title>")
    .description("rename a project (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (title: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project rename", async (ctx) => {
          const nextTitle = title.trim();
          if (!nextTitle) {
            throw new Error("title must be non-empty");
          }
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          await ctx.hub.db.userQuery({
            query: {
              projects: [{ project_id: ws.project_id, title: nextTitle }],
            },
            options: [],
          });
          return {
            project_id: ws.project_id,
            title: nextTitle,
          };
        });
      },
    );

  project
    .command("use")
    .description("set default project for this directory")
    .requiredOption("-w, --project <project>", "project id or name")
    .action(async (opts: { project: string }, command: Command) => {
      await withContext(command, "project use", async (ctx) => {
        const ws = await resolveProject(ctx, opts.project);
        saveProjectContext({
          project_id: ws.project_id,
          title: ws.title,
        });
        return {
          context_path: projectContextPath(),
          project_id: ws.project_id,
          title: ws.title,
        };
      });
    });

  project
    .command("unuse")
    .description("clear default project for this directory")
    .action(async (command: Command) => {
      await runLocalCommand(command, "project unuse", async () => {
        const removed = clearProjectContext();
        return {
          context_path: projectContextPath(),
          removed,
        };
      });
    });

  project
    .command("delete")
    .description("delete a project (soft by default; permanent with --hard)")
    .requiredOption("-w, --project <project_id>", "project project_id (UUID)")
    .option("--hard", "permanently delete project data and metadata")
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
          project: string;
          hard?: boolean;
          backupRetentionDays?: string;
          purgeBackupsNow?: boolean;
          wait?: boolean;
          yes?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project delete", async (ctx) => {
          const projectId = `${opts.project ?? ""}`.trim();
          if (!isValidUUID(projectId)) {
            throw new Error("--project must be a project project_id UUID");
          }
          const ws = await resolveProject(ctx, projectId);
          if (!opts.hard) {
            await ctx.hub.projects.deleteProject({
              project_id: ws.project_id,
            });
            return {
              project_id: ws.project_id,
              status: "deleted",
              mode: "soft",
            };
          }

          const retentionRaw = Number(opts.backupRetentionDays ?? "7");
          if (!Number.isFinite(retentionRaw) || retentionRaw < 0) {
            throw new Error(
              "--backup-retention-days must be a non-negative number",
            );
          }
          const backupRetentionDays = Math.floor(retentionRaw);
          const purgeBackupsNow =
            !!opts.purgeBackupsNow || backupRetentionDays === 0;

          if (!opts.yes) {
            await confirmHardProjectDelete({
              project_id: ws.project_id,
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
              project_id: ws.project_id,
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
            project_id: ws.project_id,
            op_id: op.op_id,
            status: summary.status,
            mode: "hard",
            backup_retention_days: backupRetentionDays,
            purge_backups_now: purgeBackupsNow,
          };
        });
      },
    );

  project
    .command("undelete")
    .description("undelete a project")
    .requiredOption("-w, --project <project_id>", "project project_id (UUID)")
    .action(async (opts: { project: string }, command: Command) => {
      await withContext(command, "project undelete", async (ctx) => {
        const projectId = `${opts.project ?? ""}`.trim();
        if (!isValidUUID(projectId)) {
          throw new Error("--project must be a project project_id UUID");
        }
        await ctx.hub.projects.setProjectDeleted({
          project_id: projectId,
          deleted: false,
        });
        return {
          project_id: projectId,
          status: "active",
          mode: "soft",
        };
      });
    });

  project
    .command("start")
    .description("start a project (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait for completion")
    .action(
      async (opts: { project?: string; wait?: boolean }, command: Command) => {
        await withContext(command, "project start", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
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
                `timeout waiting for start op ${op.op_id}; last status=${summary.status}`,
              );
            }
            if (summary.status !== "succeeded") {
              throw new Error(
                `start failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
              );
            }
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              status: summary.status,
            };
          }

          return {
            project_id: ws.project_id,
            op_id: op.op_id,
            status: "queued",
          };
        });
      },
    );

  project
    .command("stop")
    .description("stop a project (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait until the project is not running")
    .action(
      async (opts: { project?: string; wait?: boolean }, command: Command) => {
        await withContext(command, "project stop", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          await ctx.hub.projects.stop({
            project_id: ws.project_id,
          });

          if (opts.wait) {
            const wait = await waitForProjectNotRunning(ctx, ws.project_id, {
              timeoutMs: ctx.timeoutMs,
              pollMs: ctx.pollMs,
            });
            if (!wait.ok) {
              throw new Error(
                `timeout waiting for project to stop (project=${ws.project_id}, last_state=${wait.state || "running"})`,
              );
            }
            return {
              project_id: ws.project_id,
              status: wait.state || "stopped",
            };
          }

          return {
            project_id: ws.project_id,
            status: "stop_requested",
          };
        });
      },
    );

  project
    .command("restart")
    .description("restart a project (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait for restart completion")
    .action(
      async (opts: { project?: string; wait?: boolean }, command: Command) => {
        await withContext(command, "project restart", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
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
              project_id: ws.project_id,
              op_id: op.op_id,
              status: summary.status,
            };
          }

          return {
            project_id: ws.project_id,
            op_id: op.op_id,
            status: "queued",
          };
        });
      },
    );

  project
    .command("exec [command...]")
    .description("execute a command in a project (defaults to context)")
    .option("-w, --project <project>", "project id or name")
    .option("--timeout <seconds>", "command timeout seconds", "60")
    .option("--path <path>", "working path inside project")
    .option("--bash", "treat command as a bash command string")
    .action(
      async (
        commandArgs: string[],
        opts: {
          project?: string;
          timeout?: string;
          path?: string;
          bash?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project exec", async (ctx) => {
          const execArgs = Array.isArray(commandArgs)
            ? commandArgs
            : commandArgs
              ? [commandArgs]
              : [];
          if (!execArgs.length) {
            throw new Error("command is required");
          }
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const timeout =
            opts.timeout != null && Number(opts.timeout) !== 60
              ? Number(opts.timeout)
              : getProjectExecTimeoutSeconds();
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

          const commandTimeoutMs = Math.max(
            30_000,
            Math.ceil(timeout * 1000) + 5_000,
          );
          const prevTimeoutMs = ctx.timeoutMs;
          const prevRpcTimeoutMs = ctx.rpcTimeoutMs;
          ctx.timeoutMs = Math.max(prevTimeoutMs, commandTimeoutMs);
          ctx.rpcTimeoutMs = Math.max(prevRpcTimeoutMs, commandTimeoutMs);
          let result;
          try {
            result = await ctx.hub.projects.exec({
              project_id: ws.project_id,
              execOpts,
            });
          } finally {
            ctx.timeoutMs = prevTimeoutMs;
            ctx.rpcTimeoutMs = prevRpcTimeoutMs;
          }

          if (!ctx.globals.json && ctx.globals.output !== "json") {
            if (result.stdout) process.stdout.write(result.stdout);
            if (result.stderr) process.stderr.write(result.stderr);
            if (result.exit_code !== 0) {
              process.exitCode = result.exit_code;
            }
          }

          return {
            project_id: ws.project_id,
            ...result,
          };
        });
      },
    );
}
