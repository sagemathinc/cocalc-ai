import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { registerWorkspaceSyncCommands } from "./workspace/sync";
import { registerWorkspaceCodexCommands } from "./workspace/codex";
import { registerWorkspaceCollabCommands } from "./workspace/collab";

type SyncKeyInfo = any;
type WorkspaceRuntimeLogRow = any;
type GlobalOptions = any;
type CommandContext = any;

export type WorkspaceCommandDeps = {
  withContext: any;
  resolveHost: any;
  queryProjects: any;
  workspaceState: any;
  toIso: any;
  resolveWorkspaceFromArgOrContext: any;
  resolveWorkspace: any;
  saveWorkspaceContext: any;
  workspaceContextPath: any;
  clearWorkspaceContext: any;
  isValidUUID: any;
  confirmHardWorkspaceDelete: any;
  waitForLro: any;
  waitForWorkspaceNotRunning: any;
  resolveWorkspaceSshConnection: any;
  ensureSyncKeyPair: any;
  installSyncPublicKey: any;
  runSshCheck: any;
  isLikelySshAuthFailure: any;
  runSsh: any;
  runLocalCommand: any;
  resolveCloudflaredBinary: any;
  normalizeWorkspaceSshHostAlias: any;
  normalizeWorkspaceSshConfigPath: any;
  workspaceSshConfigBlockMarkers: any;
  removeWorkspaceSshConfigBlock: any;
  emitWorkspaceFileCatHumanContent: any;
  waitForProjectPlacement: any;
  normalizeSyncKeyBasePath: any;
  syncKeyPublicPath: any;
  readSyncPublicKey: any;
  resolveWorkspaceSshTarget: any;
  runReflectSyncCli: any;
  parseCreatedForwardId: any;
  listReflectForwards: any;
  reflectSyncHomeDir: any;
  reflectSyncSessionDbPath: any;
  formatReflectForwardRow: any;
  forwardsForWorkspace: any;
  terminateReflectForwards: any;
  readAllStdin: any;
  buildCodexSessionConfig: any;
  workspaceCodexExecData: any;
  streamCodexHumanMessage: any;
  workspaceCodexAuthStatusData: any;
  durationToMs: any;
  workspaceCodexDeviceAuthStartData: any;
  workspaceCodexDeviceAuthStatusData: any;
  workspaceCodexDeviceAuthCancelData: any;
  workspaceCodexAuthUploadFileData: any;
  normalizeUserSearchName: any;
  resolveAccountByIdentifier: any;
  serializeInviteRow: any;
  compactInviteRow: any;
  globalsFrom: any;
  shouldUseDaemonForFileOps: any;
  runDaemonRequestFromCommand: any;
  emitSuccess: any;
  isDaemonTransportError: any;
  emitError: any;
  cliDebug: any;
  workspaceFileListData: any;
  workspaceFileCatData: any;
  readFileLocal: any;
  asObject: any;
  workspaceFilePutData: any;
  mkdirLocal: any;
  writeFileLocal: any;
  workspaceFileGetData: any;
  workspaceFileRmData: any;
  workspaceFileMkdirData: any;
  workspaceFileRgData: any;
  workspaceFileFdData: any;
  contextForGlobals: any;
  runWorkspaceFileCheckBench: any;
  printArrayTable: any;
  runWorkspaceFileCheck: any;
  closeCommandContext: any;
  resolveProxyUrl: any;
  parsePositiveInteger: any;
  isRedirect: any;
  extractCookie: any;
  fetchWithTimeout: any;
  buildCookieHeader: any;
  PROJECT_HOST_HTTP_AUTH_QUERY_PARAM: string;
};

export function registerWorkspaceCommand(program: Command, deps: WorkspaceCommandDeps): Command {
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
    resolveWorkspaceSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    runSshCheck,
    isLikelySshAuthFailure,
    runSsh,
    runLocalCommand,
    resolveCloudflaredBinary,
    normalizeWorkspaceSshHostAlias,
    normalizeWorkspaceSshConfigPath,
    workspaceSshConfigBlockMarkers,
    removeWorkspaceSshConfigBlock,
    emitWorkspaceFileCatHumanContent,
    waitForProjectPlacement,
    globalsFrom,
    shouldUseDaemonForFileOps,
    runDaemonRequestFromCommand,
    emitSuccess,
    isDaemonTransportError,
    emitError,
    cliDebug,
    workspaceFileListData,
    workspaceFileCatData,
    readFileLocal,
    asObject,
    workspaceFilePutData,
    mkdirLocal,
    writeFileLocal,
    workspaceFileGetData,
    workspaceFileRmData,
    workspaceFileMkdirData,
    workspaceFileRgData,
    workspaceFileFdData,
    contextForGlobals,
    runWorkspaceFileCheckBench,
    printArrayTable,
    runWorkspaceFileCheck,
    closeCommandContext,
    resolveProxyUrl,
    parsePositiveInteger,
    isRedirect,
    extractCookie,
    fetchWithTimeout,
    buildCookieHeader,
    PROJECT_HOST_HTTP_AUTH_QUERY_PARAM,
  } = deps;
const workspace = program.command("workspace").alias("ws").description("workspace operations");

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

workspace
  .command("ssh [sshArgs...]")
  .description(
    "connect to a workspace over ssh (defaults to context); pass remote command after '--'",
  )
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--direct", "bypass Cloudflare Access and connect to host ssh endpoint directly")
  .option("--check", "verify ssh connectivity/authentication non-interactively")
  .option("--require-auth", "with --check, require successful auth (not just reachable ssh endpoint)")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option(
    "--no-install-key",
    "skip automatic local ssh key ensure + workspace authorized_keys install",
  )
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(
    async (
      sshArgs: string[],
      opts: {
        workspace?: string;
        direct?: boolean;
        check?: boolean;
        requireAuth?: boolean;
        keyPath?: string;
        installKey?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace ssh", async (ctx) => {
        if (opts.check && sshArgs.length > 0) {
          throw new Error("--check does not accept ssh arguments");
        }
        const route = await resolveWorkspaceSshConnection(ctx, opts.workspace, {
          direct: !!opts.direct,
        });

        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.installKey !== false) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            workspaceIdentifier: route.workspace.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const baseArgs: string[] = [];
        if (keyInfo?.private_key_path) {
          baseArgs.push("-i", keyInfo.private_key_path, "-o", "IdentitiesOnly=yes");
        }
        let sshServer = route.ssh_server;
        if (route.transport === "cloudflare-access-tcp") {
          const cloudflareHostname = route.cloudflare_hostname;
          if (!cloudflareHostname) {
            throw new Error("workspace ssh route is missing cloudflare hostname");
          }
          const cloudflared =
            opts.check
              ? resolveCloudflaredBinary()
              : `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
                "cloudflared";
          const proxyCommand = `${cloudflared} access ssh --hostname ${cloudflareHostname}`;
          baseArgs.push("-o", `ProxyCommand=${proxyCommand}`);
          baseArgs.push(`${route.ssh_username}@${cloudflareHostname}`);
          sshServer = `${cloudflareHostname}:443`;
        } else {
          if (!route.ssh_host) {
            throw new Error("workspace ssh route is missing host endpoint");
          }
          if (route.ssh_port != null) {
            baseArgs.push("-p", String(route.ssh_port));
          }
          baseArgs.push(`${route.ssh_username}@${route.ssh_host}`);
        }

        const commandLine = `ssh ${baseArgs.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ")}`;

        if (opts.check) {
          const checkArgs = [
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            ...baseArgs,
            "true",
          ];
          const timeoutMs = Math.min(Math.max(ctx.timeoutMs, 10_000), 30_000);
          const result = await runSshCheck(checkArgs, timeoutMs);
          if (result.code !== 0) {
            if (!opts.requireAuth && isLikelySshAuthFailure(result.stderr)) {
              return {
                workspace_id: route.workspace.project_id,
                ssh_transport: route.transport,
                ssh_server: sshServer,
                checked: true,
                command: commandLine,
                auth_ok: false,
                exit_code: result.code,
              };
            }
            const suffix = result.stderr.trim()
              ? `: ${result.stderr.trim()}`
              : result.timed_out
                ? " (timeout)"
                : "";
            throw new Error(`ssh check failed (exit ${result.code})${suffix}`);
          }
          return {
            workspace_id: route.workspace.project_id,
            ssh_transport: route.transport,
            ssh_server: sshServer,
            checked: true,
            command: commandLine,
            auth_ok: true,
            exit_code: 0,
            key_created: keyInfo?.created ?? false,
            key_path: keyInfo?.private_key_path ?? null,
            key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
            key_already_present: keyInstall
              ? Boolean((keyInstall as any).already_present)
              : false,
          };
        }

        const code = await runSsh([...baseArgs, ...sshArgs]);
        if (code !== 0) {
          process.exitCode = code;
        }
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          return null;
        }
        return {
          workspace_id: route.workspace.project_id,
          ssh_transport: route.transport,
          ssh_server: sshServer,
          exit_code: code,
          key_created: keyInfo?.created ?? false,
          key_path: keyInfo?.private_key_path ?? null,
          key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
          key_already_present: keyInstall
            ? Boolean((keyInstall as any).already_present)
            : false,
        };
      });
    },
  );

workspace
  .command("ssh-info")
  .description("print ssh connection info for a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--direct", "bypass Cloudflare Access and show direct host ssh endpoint")
  .action(
    async (
      opts: { workspace?: string; direct?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace ssh-info", async (ctx) => {
        const route = await resolveWorkspaceSshConnection(ctx, opts.workspace, {
          direct: !!opts.direct,
        });
        const baseArgs: string[] = [];
        let sshServer = route.ssh_server;
        if (route.transport === "cloudflare-access-tcp") {
          const cloudflareHostname = route.cloudflare_hostname;
          if (!cloudflareHostname) {
            throw new Error("workspace ssh route is missing cloudflare hostname");
          }
          const cloudflared = `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
            "cloudflared";
          const proxyCommand = `${cloudflared} access ssh --hostname ${cloudflareHostname}`;
          baseArgs.push("-o", `ProxyCommand=${proxyCommand}`);
          baseArgs.push(`${route.ssh_username}@${cloudflareHostname}`);
          sshServer = `${cloudflareHostname}:443`;
        } else {
          if (!route.ssh_host) {
            throw new Error("workspace ssh route is missing host endpoint");
          }
          if (route.ssh_port != null) {
            baseArgs.push("-p", String(route.ssh_port));
          }
          baseArgs.push(`${route.ssh_username}@${route.ssh_host}`);
        }
        const commandLine = `ssh ${baseArgs.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ")}`;
        return {
          workspace_id: route.workspace.project_id,
          ssh_transport: route.transport,
          ssh_server: sshServer,
          command: commandLine,
        };
      });
    },
  );

const workspaceSshConfig = workspace
  .command("ssh-config")
  .description("manage local OpenSSH config entries for workspace ssh");

workspaceSshConfig
  .command("add")
  .description(
    "add/update a managed ~/.ssh/config entry for workspace ssh (Host defaults to exactly -w value)",
  )
  .requiredOption("-w, --workspace <workspace>", "workspace id or name")
  .option("--alias <alias>", "Host alias in ssh config (defaults to exactly -w value)")
  .option("--config <path>", "ssh config path (default: ~/.ssh/config)")
  .option("--direct", "write direct-host ssh route instead of Cloudflare route")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option(
    "--no-install-key",
    "skip automatic local ssh key ensure + workspace authorized_keys install",
  )
  .action(
    async (
      opts: {
        workspace: string;
        alias?: string;
        config?: string;
        direct?: boolean;
        keyPath?: string;
        installKey?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace ssh-config add", async (ctx) => {
        const alias = normalizeWorkspaceSshHostAlias(opts.alias ?? opts.workspace);
        const route = await resolveWorkspaceSshConnection(ctx, opts.workspace, {
          direct: !!opts.direct,
        });
        const configPath = normalizeWorkspaceSshConfigPath(opts.config);

        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.installKey !== false) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            workspaceIdentifier: route.workspace.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const hostName =
          route.transport === "cloudflare-access-tcp"
            ? `${route.cloudflare_hostname ?? ""}`.trim()
            : `${route.ssh_host ?? ""}`.trim();
        if (!hostName) {
          throw new Error("workspace ssh route is missing host endpoint");
        }

        const lines = [
          `Host ${alias}`,
          `  HostName ${hostName}`,
          `  User ${route.ssh_username}`,
        ];
        if (route.transport === "cloudflare-access-tcp") {
          const cloudflared = `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
            "cloudflared";
          lines.push(`  ProxyCommand ${cloudflared} access ssh --hostname %h`);
        } else if (route.ssh_port != null) {
          lines.push(`  Port ${route.ssh_port}`);
        }
        if (keyInfo?.private_key_path) {
          lines.push(`  IdentityFile ${keyInfo.private_key_path}`);
          lines.push("  IdentitiesOnly yes");
        }
        const markers = workspaceSshConfigBlockMarkers(alias);
        const block = `${markers.start}\n${lines.join("\n")}\n${markers.end}\n`;

        mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
        const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        const stripped = removeWorkspaceSshConfigBlock(existing, alias).content.trimEnd();
        const next = stripped ? `${stripped}\n\n${block}` : block;
        writeFileSync(configPath, next, { encoding: "utf8", mode: 0o600 });

        return {
          workspace_id: route.workspace.project_id,
          workspace_title: route.workspace.title,
          alias,
          config_path: configPath,
          ssh_transport: route.transport,
          ssh_server:
            route.transport === "cloudflare-access-tcp"
              ? `${hostName}:443`
              : route.ssh_server,
          key_created: keyInfo?.created ?? false,
          key_path: keyInfo?.private_key_path ?? null,
          key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
          key_already_present: keyInstall
            ? Boolean((keyInstall as any).already_present)
            : false,
          command: `ssh ${alias}`,
        };
      });
    },
  );

workspaceSshConfig
  .command("remove")
  .description("remove a managed workspace ssh entry from ~/.ssh/config")
  .requiredOption("-w, --workspace <workspace>", "workspace id or name")
  .option("--alias <alias>", "Host alias in ssh config (defaults to exactly -w value)")
  .option("--config <path>", "ssh config path (default: ~/.ssh/config)")
  .action(
    async (
      opts: {
        workspace: string;
        alias?: string;
        config?: string;
      },
      command: Command,
    ) => {
      await runLocalCommand(command, "workspace ssh-config remove", async () => {
        const alias = normalizeWorkspaceSshHostAlias(opts.alias ?? opts.workspace);
        const configPath = normalizeWorkspaceSshConfigPath(opts.config);
        if (!existsSync(configPath)) {
          return {
            alias,
            config_path: configPath,
            removed: false,
          };
        }
        const existing = readFileSync(configPath, "utf8");
        const stripped = removeWorkspaceSshConfigBlock(existing, alias);
        if (!stripped.removed) {
          return {
            alias,
            config_path: configPath,
            removed: false,
          };
        }
        writeFileSync(configPath, stripped.content.trimEnd() + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        return {
          alias,
          config_path: configPath,
          removed: true,
        };
      });
    },
  );

workspace
  .command("logs")
  .description("show workspace runtime logs from project-host (prints nothing if not running)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--tail <n>", "number of log lines", "200")
  .action(
    async (
      opts: { workspace?: string; tail?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace logs", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const tail = Number(opts.tail ?? "200");
        if (!Number.isFinite(tail) || tail <= 0) {
          throw new Error("--tail must be a positive integer");
        }
        const log = (await ctx.hub.projects.getRuntimeLog({
          project_id: ws.project_id,
          lines: Math.floor(tail),
        })) as WorkspaceRuntimeLogRow;
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (log.text) {
            emitWorkspaceFileCatHumanContent(log.text);
          }
          return null;
        }
        return log;
      });
    },
  );

workspace
  .command("move")
  .description("move a workspace to another host (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--host <host>", "destination host id or name")
  .option("--wait", "wait for completion")
  .action(
    async (opts: { workspace?: string; host: string; wait?: boolean }, command: Command) => {
      await withContext(command, "workspace move", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const host = await resolveHost(ctx, opts.host);
        const op = await ctx.hub.projects.moveProject({
          project_id: ws.project_id,
          dest_host_id: host.id,
        });

        if (!opts.wait) {
          return {
            workspace_id: ws.project_id,
            dest_host_id: host.id,
            op_id: op.op_id,
            status: "queued",
          };
        }

        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });

        if (!summary.timedOut && summary.status === "succeeded") {
          return {
            workspace_id: ws.project_id,
            dest_host_id: host.id,
            op_id: op.op_id,
            status: summary.status,
          };
        }

        const placementOk = await waitForProjectPlacement(ctx, ws.project_id, host.id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });

        if (!placementOk) {
          if (summary.timedOut) {
            throw new Error(
              `move timed out and placement check failed (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          throw new Error(
            `move failed and placement check failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
          );
        }

        return {
          workspace_id: ws.project_id,
          dest_host_id: host.id,
          op_id: op.op_id,
          status: summary.status,
          warning:
            "move LRO did not report succeeded, but destination placement was verified",
        };
      });
    },
  );

workspace
  .command("copy-path")
  .description("copy a path between workspaces")
  .requiredOption("--src-workspace <workspace>", "source workspace")
  .requiredOption("--src <path>", "source path")
  .requiredOption("--dest-workspace <workspace>", "destination workspace")
  .requiredOption("--dest <path>", "destination path")
  .option("--wait", "wait for completion")
  .action(
    async (
      opts: {
        srcWorkspace: string;
        src: string;
        destWorkspace: string;
        dest: string;
        wait?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace copy-path", async (ctx) => {
        const srcWs = await resolveWorkspace(ctx, opts.srcWorkspace);
        const destWs = await resolveWorkspace(ctx, opts.destWorkspace);
        const op = await ctx.hub.projects.copyPathBetweenProjects({
          src: { project_id: srcWs.project_id, path: opts.src },
          dest: { project_id: destWs.project_id, path: opts.dest },
        });

        if (!opts.wait) {
          return {
            src_workspace_id: srcWs.project_id,
            src_path: opts.src,
            dest_workspace_id: destWs.project_id,
            dest_path: opts.dest,
            op_id: op.op_id,
            status: "queued",
          };
        }

        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`copy timed out (op=${op.op_id}, last_status=${summary.status})`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(`copy failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
        }

        return {
          src_workspace_id: srcWs.project_id,
          src_path: opts.src,
          dest_workspace_id: destWs.project_id,
          dest_path: opts.dest,
          op_id: op.op_id,
          status: summary.status,
        };
      });
    },
  );

registerWorkspaceSyncCommands(workspace, deps);

registerWorkspaceCodexCommands(workspace, deps);
registerWorkspaceCollabCommands(workspace, deps);
const file = workspace.command("file").description("workspace file operations");

file
  .command("list [path]")
  .description("list files in a workspace directory")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      path: string | undefined,
      opts: { workspace?: string },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.list",
            payload: {
              workspace: opts.workspace,
              path,
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file list",
            response.data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file list", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file list daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file list", async (ctx) => {
        return await workspaceFileListData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
        });
      });
    },
  );

file
  .command("cat <path>")
  .description("print a text file from a workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      path: string,
      opts: { workspace?: string },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.cat",
            payload: {
              workspace: opts.workspace,
              path,
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          const data = asObject(response.data);
          const content = typeof data.content === "string" ? data.content : "";
          if (!globals.json && globals.output !== "json") {
            emitWorkspaceFileCatHumanContent(content);
            return;
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file cat",
            data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file cat", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file cat daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file cat", async (ctx) => {
        const data = await workspaceFileCatData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
        });
        const content = String(data.content ?? "");
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          emitWorkspaceFileCatHumanContent(content);
          return null;
        }
        return data;
      });
    },
  );

file
  .command("put <src> <dest>")
  .description("upload a local file to a workspace path")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--no-parents", "do not create destination parent directories")
  .action(
    async (
      src: string,
      dest: string,
      opts: { workspace?: string; parents?: boolean },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      const data = await readFileLocal(src);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.put",
            payload: {
              workspace: opts.workspace,
              dest,
              parents: opts.parents !== false,
              content_base64: data.toString("base64"),
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          const result = asObject(response.data);
          result.src = src;
          result.dest = dest;
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file put",
            result,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file put", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file put daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file put", async (ctx) => {
        const result = await workspaceFilePutData({
          ctx,
          workspaceIdentifier: opts.workspace,
          dest,
          data,
          parents: opts.parents !== false,
        });
        return {
          ...result,
          src,
        };
      });
    },
  );

file
  .command("get <src> <dest>")
  .description("download a workspace file to a local path")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--no-parents", "do not create destination parent directories")
  .action(
    async (
      src: string,
      dest: string,
      opts: { workspace?: string; parents?: boolean },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.get",
            payload: {
              workspace: opts.workspace,
              src,
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          const data = asObject(response.data);
          const encoded = typeof data.content_base64 === "string" ? data.content_base64 : "";
          const buffer = Buffer.from(encoded, "base64");
          if (opts.parents !== false) {
            await mkdirLocal(dirname(dest), { recursive: true });
          }
          await writeFileLocal(dest, buffer);
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file get",
            {
              workspace_id: data.workspace_id ?? null,
              src,
              dest,
              bytes: buffer.length,
              status: data.status ?? "downloaded",
            },
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file get", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file get daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file get", async (ctx) => {
        const data = await workspaceFileGetData({
          ctx,
          workspaceIdentifier: opts.workspace,
          src,
        });
        const encoded = typeof data.content_base64 === "string" ? data.content_base64 : "";
        const buffer = Buffer.from(encoded, "base64");
        if (opts.parents !== false) {
          await mkdirLocal(dirname(dest), { recursive: true });
        }
        await writeFileLocal(dest, buffer);
        return {
          workspace_id: data.workspace_id ?? null,
          src,
          dest,
          bytes: buffer.length,
          status: data.status ?? "downloaded",
        };
      });
    },
  );

file
  .command("rm <path>")
  .description("remove a path in a workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("-r, --recursive", "remove directories recursively")
  .option("-f, --force", "do not fail if path is missing")
  .action(
    async (
      path: string,
      opts: { workspace?: string; recursive?: boolean; force?: boolean },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.rm",
            payload: {
              workspace: opts.workspace,
              path,
              recursive: !!opts.recursive,
              force: !!opts.force,
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file rm",
            response.data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file rm", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file rm daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file rm", async (ctx) => {
        return await workspaceFileRmData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          recursive: !!opts.recursive,
          force: !!opts.force,
        });
      });
    },
  );

file
  .command("mkdir <path>")
  .description("create a directory in a workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--no-parents", "do not create parent directories")
  .action(
    async (
      path: string,
      opts: { workspace?: string; parents?: boolean },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.mkdir",
            payload: {
              workspace: opts.workspace,
              path,
              parents: opts.parents !== false,
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file mkdir",
            response.data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file mkdir", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file mkdir daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file mkdir", async (ctx) => {
        return await workspaceFileMkdirData({
          ctx,
          workspaceIdentifier: opts.workspace,
          path,
          parents: opts.parents !== false,
        });
      });
    },
  );

file
  .command("rg <pattern> [path]")
  .description("search workspace files using ripgrep")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--timeout <seconds>", "ripgrep timeout seconds", "30")
  .option("--max-bytes <bytes>", "max combined output bytes", "20000000")
  .option("--rg-option <arg>", "additional ripgrep option (repeatable)", (value, prev: string[] = []) => [...prev, value], [])
  .action(
    async (
      pattern: string,
      path: string | undefined,
      opts: {
        workspace?: string;
        timeout?: string;
        maxBytes?: string;
        rgOption?: string[];
      },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      const timeoutMs = Math.max(1, (Number(opts.timeout ?? "30") || 30) * 1000);
      const maxBytes = Math.max(1024, Number(opts.maxBytes ?? "20000000") || 20000000);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.rg",
            payload: {
              workspace: opts.workspace,
              pattern,
              path,
              timeout_ms: timeoutMs,
              max_bytes: maxBytes,
              rg_options: opts.rgOption ?? [],
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          const data = asObject(response.data);
          const stdout = typeof data.stdout === "string" ? data.stdout : "";
          const stderr = typeof data.stderr === "string" ? data.stderr : "";
          const exit_code = Number(data.exit_code ?? 1);
          if (!globals.json && globals.output !== "json") {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (exit_code !== 0) process.exitCode = exit_code;
            return;
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file rg",
            data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file rg", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file rg daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file rg", async (ctx) => {
        const data = await workspaceFileRgData({
          ctx,
          workspaceIdentifier: opts.workspace,
          pattern,
          path,
          timeoutMs,
          maxBytes,
          options: opts.rgOption,
        });
        const stdout = typeof data.stdout === "string" ? data.stdout : "";
        const stderr = typeof data.stderr === "string" ? data.stderr : "";
        const exit_code = Number(data.exit_code ?? 1);

        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (exit_code !== 0) {
            process.exitCode = exit_code;
          }
          return null;
        }
        return data;
      });
    },
  );

file
  .command("fd [pattern] [path]")
  .description("find files in a workspace using fd")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--timeout <seconds>", "fd timeout seconds", "30")
  .option("--max-bytes <bytes>", "max combined output bytes", "20000000")
  .option("--fd-option <arg>", "additional fd option (repeatable)", (value, prev: string[] = []) => [...prev, value], [])
  .action(
    async (
      pattern: string | undefined,
      path: string | undefined,
      opts: {
        workspace?: string;
        timeout?: string;
        maxBytes?: string;
        fdOption?: string[];
      },
      command: Command,
    ) => {
      const globals = globalsFrom(command);
      const timeoutMs = Math.max(1, (Number(opts.timeout ?? "30") || 30) * 1000);
      const maxBytes = Math.max(1024, Number(opts.maxBytes ?? "20000000") || 20000000);
      if (shouldUseDaemonForFileOps(globals)) {
        try {
          const response = await runDaemonRequestFromCommand(command, {
            action: "workspace.file.fd",
            payload: {
              workspace: opts.workspace,
              pattern,
              path,
              timeout_ms: timeoutMs,
              max_bytes: maxBytes,
              fd_options: opts.fdOption ?? [],
            },
          });
          if (!response.ok) {
            throw new Error(response.error ?? "daemon request failed");
          }
          const data = asObject(response.data);
          const stdout = typeof data.stdout === "string" ? data.stdout : "";
          const stderr = typeof data.stderr === "string" ? data.stderr : "";
          const exit_code = Number(data.exit_code ?? 1);
          if (!globals.json && globals.output !== "json") {
            if (stdout) process.stdout.write(stdout);
            if (stderr) process.stderr.write(stderr);
            if (exit_code !== 0) process.exitCode = exit_code;
            return;
          }
          emitSuccess(
            {
              globals,
              apiBaseUrl: response.meta?.api ?? undefined,
              accountId: response.meta?.account_id ?? undefined,
            },
            "workspace file fd",
            data,
          );
          return;
        } catch (err) {
          if (!isDaemonTransportError(err)) {
            emitError({ globals }, "workspace file fd", err);
            process.exitCode = 1;
            return;
          }
          cliDebug("workspace file fd daemon unavailable; falling back to direct mode", {
            err: err instanceof Error ? err.message : `${err}`,
          });
        }
      }
      await withContext(command, "workspace file fd", async (ctx) => {
        const data = await workspaceFileFdData({
          ctx,
          workspaceIdentifier: opts.workspace,
          pattern,
          path,
          timeoutMs,
          maxBytes,
          options: opts.fdOption,
        });
        const stdout = typeof data.stdout === "string" ? data.stdout : "";
        const stderr = typeof data.stderr === "string" ? data.stderr : "";
        const exit_code = Number(data.exit_code ?? 1);

        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (exit_code !== 0) {
            process.exitCode = exit_code;
          }
          return null;
        }
        return data;
      });
    },
  );

file
  .command("check")
  .description("run sanity checks for workspace file operations")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--path-prefix <path>", "temporary workspace path prefix", ".cocalc-cli-check")
  .option("--timeout <seconds>", "timeout seconds for rg/fd checks", "30")
  .option("--max-bytes <bytes>", "max combined output bytes for rg/fd checks", "20000000")
  .option("--keep", "keep temporary check files in the workspace")
  .option("--bench", "run repeated checks and include timing benchmark summaries")
  .option("--bench-runs <n>", "number of benchmark runs when --bench is used", "3")
  .action(
    async (
      opts: {
        workspace?: string;
        pathPrefix?: string;
        timeout?: string;
        maxBytes?: string;
        keep?: boolean;
        bench?: boolean;
        benchRuns?: string;
      },
      command: Command,
    ) => {
      let globals: GlobalOptions = {};
      let ctx: CommandContext | undefined;
      try {
        globals = globalsFrom(command);
        ctx = await contextForGlobals(globals);
        const timeoutMs = Math.max(1, (Number(opts.timeout ?? "30") || 30) * 1000);
        const maxBytes = Math.max(1024, Number(opts.maxBytes ?? "20000000") || 20000000);
        if (opts.bench) {
          const benchRuns = parsePositiveInteger(opts.benchRuns, 3, "--bench-runs");
          const report = await runWorkspaceFileCheckBench({
            ctx,
            workspaceIdentifier: opts.workspace,
            pathPrefix: opts.pathPrefix,
            timeoutMs,
            maxBytes,
            keep: !!opts.keep,
            runs: benchRuns,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            emitSuccess(ctx, "workspace file check", report);
          } else if (!ctx.globals.quiet) {
            printArrayTable(report.run_results.map((x) => ({ ...x })));
            printArrayTable(report.step_stats.map((x) => ({ ...x })));
            console.log(
              `summary: ${report.ok_runs}/${report.runs} successful runs (${report.failed_runs} failed)`,
            );
            console.log(
              `timing_ms: avg=${report.avg_duration_ms} min=${report.min_duration_ms} max=${report.max_duration_ms} total=${report.total_duration_ms}`,
            );
            console.log(`workspace_id: ${report.workspace_id}`);
          }
          if (!report.ok) {
            process.exitCode = 1;
          }
        } else {
          const report = await runWorkspaceFileCheck({
            ctx,
            workspaceIdentifier: opts.workspace,
            pathPrefix: opts.pathPrefix,
            timeoutMs,
            maxBytes,
            keep: !!opts.keep,
          });

          if (ctx.globals.json || ctx.globals.output === "json") {
            emitSuccess(ctx, "workspace file check", report);
          } else if (!ctx.globals.quiet) {
            printArrayTable(report.results.map((x) => ({ ...x })));
            console.log(
              `summary: ${report.passed}/${report.total} passed (${report.failed} failed, ${report.skipped} skipped)`,
            );
            console.log(`workspace_id: ${report.workspace_id}`);
            console.log(`temp_path: ${report.temp_path}${report.kept ? " (kept)" : ""}`);
          }

          if (!report.ok) {
            process.exitCode = 1;
          }
        }
      } catch (error) {
        emitError(
          { globals, apiBaseUrl: ctx?.apiBaseUrl, accountId: ctx?.accountId },
          "workspace file check",
          error,
        );
        process.exitCode = 1;
      } finally {
        closeCommandContext(ctx);
      }
    },
  );

const backup = workspace.command("backup").description("workspace backups");

backup
  .command("create")
  .description("create a backup (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait for completion")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace backup create", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const op = await ctx.hub.projects.createBackup({
        project_id: ws.project_id,
      });
      if (!opts.wait) {
        return {
          workspace_id: ws.project_id,
          op_id: op.op_id,
          status: "queued",
        };
      }
      const summary = await waitForLro(ctx, op.op_id, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (summary.timedOut) {
        throw new Error(`backup timed out (op=${op.op_id}, last_status=${summary.status})`);
      }
      if (summary.status !== "succeeded") {
        throw new Error(`backup failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
      }
      return {
        workspace_id: ws.project_id,
        op_id: op.op_id,
        status: summary.status,
      };
    });
  });

backup
  .command("list")
  .description("list backups (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--indexed-only", "only list indexed backups")
  .option("--limit <n>", "max rows", "100")
  .action(
    async (opts: { workspace?: string; indexedOnly?: boolean; limit?: string }, command: Command) => {
      await withContext(command, "workspace backup list", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const backups = (await ctx.hub.projects.getBackups({
          project_id: ws.project_id,
          indexed_only: !!opts.indexedOnly,
        })) as Array<{ id: string; time: string | Date; summary?: Record<string, any> }>;
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "100") || 100));
        return (backups ?? []).slice(0, limitNum).map((b) => ({
          workspace_id: ws.project_id,
          backup_id: b.id,
          time: toIso(b.time),
          summary: b.summary ?? null,
        }));
      });
    },
  );

backup
  .command("files")
  .description("list files for one backup (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--backup-id <id>", "backup id")
  .option("--path <path>", "path inside backup")
  .action(
    async (opts: { workspace?: string; backupId: string; path?: string }, command: Command) => {
      await withContext(command, "workspace backup files", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const files = (await ctx.hub.projects.getBackupFiles({
          project_id: ws.project_id,
          id: opts.backupId,
          path: opts.path,
        })) as Array<{ name: string; isDir: boolean; mtime: number; size: number }>;
        return (files ?? []).map((f) => ({
          workspace_id: ws.project_id,
          backup_id: opts.backupId,
          name: f.name,
          is_dir: !!f.isDir,
          mtime: f.mtime,
          size: f.size,
        }));
      });
    },
  );

backup
  .command("restore")
  .description("restore backup content (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--backup-id <id>", "backup id")
  .option("--path <path>", "source path in backup")
  .option("--dest <path>", "destination path in workspace")
  .option("--wait", "wait for completion")
  .action(
    async (
      opts: { workspace?: string; backupId: string; path?: string; dest?: string; wait?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace backup restore", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const op = await ctx.hub.projects.restoreBackup({
          project_id: ws.project_id,
          id: opts.backupId,
          path: opts.path,
          dest: opts.dest,
        });
        if (!opts.wait) {
          return {
            workspace_id: ws.project_id,
            backup_id: opts.backupId,
            op_id: op.op_id,
            status: "queued",
          };
        }
        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`restore timed out (op=${op.op_id}, last_status=${summary.status})`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(`restore failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
        }
        return {
          workspace_id: ws.project_id,
          backup_id: opts.backupId,
          op_id: op.op_id,
          status: summary.status,
        };
      });
    },
  );

const snapshot = workspace.command("snapshot").description("workspace snapshots");

snapshot
  .command("create")
  .description("create a btrfs snapshot (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--name <name>", "snapshot name")
  .action(async (opts: { workspace?: string; name?: string }, command: Command) => {
    await withContext(command, "workspace snapshot create", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await ctx.hub.projects.createSnapshot({
        project_id: ws.project_id,
        name: opts.name,
      });
      return {
        workspace_id: ws.project_id,
        snapshot_name: opts.name ?? "(auto)",
        status: "created",
      };
    });
  });

snapshot
  .command("list")
  .description("list snapshot usage (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace snapshot list", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const snapshots = await ctx.hub.projects.allSnapshotUsage({
        project_id: ws.project_id,
      });
      return snapshots.map((snap) => ({
        workspace_id: ws.project_id,
        name: snap.name,
        used: snap.used,
        exclusive: snap.exclusive,
        quota: snap.quota,
      }));
    });
  });

const proxy = workspace.command("proxy").description("workspace proxy operations");

proxy
  .command("url")
  .description("compute proxy URL for a workspace port (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .action(async (opts: { workspace?: string; port: string; host?: string }, command: Command) => {
      await withContext(command, "workspace proxy url", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier: ws.project_id,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });
        return details;
      });
    },
  );

proxy
  .command("curl")
  .description("request a workspace proxied URL (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .option("--path <path>", "path relative to proxied app", "/")
  .option("--token <token>", "project-host HTTP auth token")
  .option("--expect <mode>", "expected outcome: ok|denied|any", "any")
  .action(
    async (
      opts: {
        workspace?: string;
        port: string;
        host?: string;
        path?: string;
        token?: string;
        expect?: "ok" | "denied" | "any";
      },
      command: Command,
    ) => {
      await withContext(command, "workspace proxy curl", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier: ws.project_id,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });

        const relativePath = (opts.path ?? "/").replace(/^\/+/, "");
        const requestUrl = relativePath ? `${details.url}${relativePath}` : details.url;
        const authCookie = buildCookieHeader(ctx.apiBaseUrl, ctx.globals);

        const timeoutMs = ctx.timeoutMs;
        let response: Response;
        let finalUrl = requestUrl;

        if (opts.token) {
          const bootstrapUrl = new URL(requestUrl);
          bootstrapUrl.searchParams.set(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM, opts.token);
          const bootstrap = await fetchWithTimeout(
            bootstrapUrl.toString(),
            {
              redirect: "manual",
              ...(authCookie
                ? {
                    headers: {
                      Cookie: authCookie,
                    },
                  }
                : undefined),
            },
            timeoutMs,
          );
          response = bootstrap;
          finalUrl = bootstrapUrl.toString();

          if (isRedirect(bootstrap.status)) {
            const cookie = extractCookie(
              bootstrap.headers.get("set-cookie"),
              "cocalc_project_host_http_session",
            );
            const location = bootstrap.headers.get("location");
            if (cookie && location) {
              finalUrl = new URL(location, bootstrapUrl.toString()).toString();
              const combinedCookie = authCookie ? `${authCookie}; ${cookie}` : cookie;
              response = await fetchWithTimeout(
                finalUrl,
                {
                  headers: {
                    Cookie: combinedCookie,
                  },
                  redirect: "manual",
                },
                timeoutMs,
              );
            }
          }
        } else {
          response = await fetchWithTimeout(
            requestUrl,
            {
              redirect: "manual",
              ...(authCookie
                ? {
                    headers: {
                      Cookie: authCookie,
                    },
                  }
                : undefined),
            },
            timeoutMs,
          );
        }

        const body = await response.text();
        const expectMode = opts.expect ?? "any";
        if (expectMode === "ok" && (response.status < 200 || response.status >= 400)) {
          throw new Error(`expected success response, got status ${response.status}`);
        }
        if (expectMode === "denied" && response.status < 300) {
          throw new Error(`expected denied (non-2xx) response, got status ${response.status}`);
        }

        return {
          workspace_id: details.workspace_id,
          host_id: details.host_id,
          local_proxy: details.local_proxy,
          url: finalUrl,
          status: response.status,
          body_preview: body.slice(0, 1024),
        };
      });
    },
  );


  return workspace;
}
