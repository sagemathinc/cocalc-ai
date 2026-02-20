import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";

type SyncKeyInfo = any;
type WorkspaceRuntimeLogRow = any;
type ProjectCollaboratorRow = any;
type MyCollaboratorRow = any;
type ProjectCollabInviteRow = any;
type ProjectCollabInviteDirection = any;
type ProjectCollabInviteStatus = any;
type ProjectCollabInviteAction = any;
type ProjectCollabInviteBlockRow = any;
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
    normalizeSyncKeyBasePath,
    syncKeyPublicPath,
    readSyncPublicKey,
    resolveWorkspaceSshTarget,
    runReflectSyncCli,
    parseCreatedForwardId,
    listReflectForwards,
    reflectSyncHomeDir,
    reflectSyncSessionDbPath,
    formatReflectForwardRow,
    forwardsForWorkspace,
    terminateReflectForwards,
    readAllStdin,
    buildCodexSessionConfig,
    workspaceCodexExecData,
    streamCodexHumanMessage,
    workspaceCodexAuthStatusData,
    durationToMs,
    workspaceCodexDeviceAuthStartData,
    workspaceCodexDeviceAuthStatusData,
    workspaceCodexDeviceAuthCancelData,
    workspaceCodexAuthUploadFileData,
    normalizeUserSearchName,
    resolveAccountByIdentifier,
    serializeInviteRow,
    compactInviteRow,
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

const sync = workspace.command("sync").description("workspace sync and forwarding operations");

const syncKey = sync.command("key").description("manage ssh keys for workspace sync");

syncKey
  .command("ensure")
  .description("ensure a local ssh keypair exists for sync/forwarding")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(async (opts: { keyPath?: string }, command: Command) => {
    await runLocalCommand(command, "workspace sync key ensure", async () => {
      const key = await ensureSyncKeyPair(opts.keyPath);
      return {
        private_key_path: key.private_key_path,
        public_key_path: key.public_key_path,
        created: key.created,
      };
    });
  });

syncKey
  .command("show")
  .description("show the local ssh public key used for sync/forwarding")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(async (opts: { keyPath?: string }, command: Command) => {
    await runLocalCommand(command, "workspace sync key show", async () => {
      const keyBasePath = normalizeSyncKeyBasePath(opts.keyPath);
      const publicKeyPath = syncKeyPublicPath(keyBasePath);
      if (!existsSync(publicKeyPath)) {
        throw new Error(
          `ssh public key not found at ${publicKeyPath}; run 'cocalc ws sync key ensure'`,
        );
      }
      return {
        public_key_path: publicKeyPath,
        public_key: readSyncPublicKey(keyBasePath),
      };
    });
  });

syncKey
  .command("install")
  .description("install a local ssh public key into workspace .ssh/authorized_keys")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option("--no-ensure", "require key to already exist locally")
  .action(
    async (
      opts: { workspace?: string; keyPath?: string; ensure?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace sync key install", async (ctx) => {
        const keyBasePath = normalizeSyncKeyBasePath(opts.keyPath);
        const key =
          opts.ensure === false
            ? {
                private_key_path: keyBasePath,
                public_key_path: syncKeyPublicPath(keyBasePath),
                public_key: readSyncPublicKey(keyBasePath),
                created: false,
              }
            : await ensureSyncKeyPair(keyBasePath);
        const installed = await installSyncPublicKey({
          ctx,
          workspaceIdentifier: opts.workspace,
          publicKey: key.public_key,
        });
        return {
          ...installed,
          private_key_path: key.private_key_path,
          public_key_path: key.public_key_path,
          key_created: key.created,
        };
      });
    },
  );

const syncForward = sync
  .command("forward")
  .description("manage workspace port forwards via reflect-sync");

syncForward
  .command("create")
  .description("forward a workspace port to localhost (reflect-sync managed)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--remote-port <port>", "workspace port to expose locally")
  .option("--local-port <port>", "local port (default: same as remote port)")
  .option("--local-host <host>", "local bind host", "127.0.0.1")
  .option("--name <name>", "forward name")
  .option("--compress", "enable ssh compression")
  .option("--ensure-key", "ensure local ssh key exists before creating forward")
  .option("--install-key", "install local ssh public key into workspace before creating forward")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .action(
    async (
      opts: {
        workspace?: string;
        remotePort: string;
        localPort?: string;
        localHost?: string;
        name?: string;
        compress?: boolean;
        ensureKey?: boolean;
        installKey?: boolean;
        keyPath?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace sync forward create", async (ctx) => {
        const remotePort = Number(opts.remotePort);
        if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
          throw new Error("--remote-port must be an integer between 1 and 65535");
        }
        const localPort = opts.localPort == null ? remotePort : Number(opts.localPort);
        if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
          throw new Error("--local-port must be an integer between 1 and 65535");
        }
        const localHost = `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";

        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.ensureKey || opts.installKey) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
        }
        if (opts.installKey) {
          keyInfo ??= await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            workspaceIdentifier: target.workspace.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const remoteEndpoint = `${target.ssh_target}:${remotePort}`;
        const localEndpoint = `${localHost}:${localPort}`;
        const forwardName =
          opts.name ??
          `ws-${target.workspace.project_id.slice(0, 8)}-${remotePort}-to-${localPort}`;
        const createArgs = ["forward", "create", remoteEndpoint, localEndpoint];
        if (forwardName.trim()) {
          createArgs.push("--name", forwardName);
        }
        if (opts.compress) {
          createArgs.push("--compress");
        }
        const created = await runReflectSyncCli(createArgs);
        const createdId = parseCreatedForwardId(`${created.stdout}\n${created.stderr}`);
        const rows = await listReflectForwards();
        const createdRow =
          createdId == null ? null : rows.find((row) => Number(row.id) === createdId) ?? null;

        return {
          workspace_id: target.workspace.project_id,
          workspace_title: target.workspace.title,
          ssh_server: target.ssh_server,
          reflect_home: reflectSyncHomeDir(),
          session_db: reflectSyncSessionDbPath(),
          forward_id: createdRow?.id ?? createdId,
          name: createdRow?.name ?? forwardName,
          local: createdRow
            ? `${createdRow.local_host}:${createdRow.local_port}`
            : localEndpoint,
          remote_port: createdRow?.remote_port ?? remotePort,
          state: createdRow?.actual_state ?? "running",
          key_created: keyInfo?.created ?? null,
          key_path: keyInfo?.private_key_path ?? null,
          key_installed: keyInstall ? keyInstall.installed : null,
          key_already_present: keyInstall ? keyInstall.already_present : null,
        };
      });
    },
  );

syncForward
  .command("list")
  .description("list workspace forwards managed by reflect-sync")
  .option("-w, --workspace <workspace>", "workspace id or name (defaults to context)")
  .option("--all", "list all local forwards (ignore workspace context)")
  .action(
    async (
      opts: { workspace?: string; all?: boolean },
      command: Command,
    ) => {
      if (opts.all) {
        await runLocalCommand(command, "workspace sync forward list", async () => {
          const rows = await listReflectForwards();
          return rows.map((row) => formatReflectForwardRow(row));
        });
        return;
      }
      await withContext(command, "workspace sync forward list", async (ctx) => {
        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        const rows = await listReflectForwards();
        return forwardsForWorkspace(rows, target.workspace.project_id).map((row) =>
          formatReflectForwardRow(row),
        );
      });
    },
  );

syncForward
  .command("terminate [forward...]")
  .alias("stop")
  .description("terminate one or more forwards")
  .option("-w, --workspace <workspace>", "workspace id or name (defaults to context)")
  .option("--all", "terminate all local forwards")
  .action(
    async (
      forwardRefs: string[],
      opts: { workspace?: string; all?: boolean },
      command: Command,
    ) => {
      const refs = (forwardRefs ?? []).map((x) => `${x}`.trim()).filter(Boolean);
      if (refs.length > 0) {
        await runLocalCommand(command, "workspace sync forward terminate", async () => {
          await terminateReflectForwards(refs);
          return {
            terminated: refs.length,
            refs,
          };
        });
        return;
      }
      if (opts.all) {
        await runLocalCommand(command, "workspace sync forward terminate", async () => {
          const rows = await listReflectForwards();
          const ids = rows.map((row) => String(row.id));
          await terminateReflectForwards(ids);
          return {
            terminated: ids.length,
            refs: ids,
            scope: "all",
          };
        });
        return;
      }
      await withContext(command, "workspace sync forward terminate", async (ctx) => {
        const target = await resolveWorkspaceSshTarget(ctx, opts.workspace);
        const rows = forwardsForWorkspace(await listReflectForwards(), target.workspace.project_id);
        const ids = rows.map((row) => String(row.id));
        await terminateReflectForwards(ids);
        return {
          workspace_id: target.workspace.project_id,
          terminated: ids.length,
          refs: ids,
        };
      });
    },
  );

const codex = workspace.command("codex").description("workspace codex operations");

codex
  .command("exec [prompt...]")
  .description("run a codex turn in a workspace using project-host containerized codex exec")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--stdin", "append stdin to prompt text")
  .option("--stream", "stream codex progress to stderr while running")
  .option("--jsonl", "emit raw codex stream messages as JSONL on stdout")
  .option("--session-id <id>", "reuse an existing codex session id")
  .option("--model <model>", "codex model name")
  .option("--reasoning <level>", "reasoning level (low|medium|high|extra_high)")
  .option(
    "--session-mode <mode>",
    "session mode (auto|read-only|workspace-write|full-access)",
  )
  .option("--workdir <path>", "working directory inside workspace")
  .action(
    async (
      promptArgs: string[],
      opts: {
        workspace?: string;
        stdin?: boolean;
        stream?: boolean;
        jsonl?: boolean;
        sessionId?: string;
        model?: string;
        reasoning?: string;
        sessionMode?: string;
        workdir?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace codex exec", async (ctx) => {
        const parts: string[] = [];
        const inlinePrompt = (promptArgs ?? []).join(" ").trim();
        if (inlinePrompt) {
          parts.push(inlinePrompt);
        }
        if (opts.stdin) {
          const stdinText = (await readAllStdin()).trim();
          if (stdinText) {
            parts.push(stdinText);
          }
        }
        const prompt = parts.join("\n\n").trim();
        if (!prompt) {
          throw new Error("prompt is required (pass text or use --stdin)");
        }
        const wantsJsonOutput = ctx.globals.json || ctx.globals.output === "json";
        const streamJsonl = !!opts.jsonl || (!!opts.stream && wantsJsonOutput);
        const streamHuman = !streamJsonl && (!!opts.stream || !!ctx.globals.verbose);
        const config = buildCodexSessionConfig({
          model: opts.model,
          reasoning: opts.reasoning,
          sessionMode: opts.sessionMode,
          workdir: opts.workdir,
        });
        const result = await workspaceCodexExecData({
          ctx,
          workspaceIdentifier: opts.workspace,
          prompt,
          sessionId: opts.sessionId,
          config,
          onMessage: (message) => {
            if (streamJsonl) {
              process.stdout.write(`${JSON.stringify(message)}\n`);
            } else if (streamHuman) {
              streamCodexHumanMessage(message);
            }
          },
        });
        if (opts.jsonl) {
          return null;
        }
        if (ctx.globals.json || ctx.globals.output === "json") {
          return result;
        }
        return result.final_response;
      });
    },
  );

const codexAuth = codex.command("auth").description("workspace codex authentication");

codexAuth
  .command("status")
  .description("show effective codex auth/payment source status for a workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace codex auth status", async (ctx) => {
      return await workspaceCodexAuthStatusData({
        ctx,
        workspaceIdentifier: opts.workspace,
      });
    });
  });

const codexAuthSubscription = codexAuth
  .command("subscription")
  .description("manage ChatGPT subscription auth for codex");

codexAuthSubscription
  .command("login")
  .description("start device auth login flow (waits for completion by default)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--no-wait", "return immediately after starting the login flow")
  .option("--poll-ms <duration>", "poll interval while waiting", "1500ms")
  .action(
    async (
      opts: { workspace?: string; wait?: boolean; pollMs?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription login", async (ctx) => {
        const pollMs = Math.max(200, durationToMs(opts.pollMs, 1_500));
        return await workspaceCodexDeviceAuthStartData({
          ctx,
          workspaceIdentifier: opts.workspace,
          wait: opts.wait !== false,
          pollMs,
        });
      });
    },
  );

codexAuthSubscription
  .command("status")
  .description("check a subscription device-auth login session")
  .requiredOption("--id <id>", "device auth session id")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      opts: { id: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription status", async (ctx) => {
        return await workspaceCodexDeviceAuthStatusData({
          ctx,
          workspaceIdentifier: opts.workspace,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("cancel")
  .description("cancel a pending subscription device-auth login session")
  .requiredOption("--id <id>", "device auth session id")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      opts: { id: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription cancel", async (ctx) => {
        return await workspaceCodexDeviceAuthCancelData({
          ctx,
          workspaceIdentifier: opts.workspace,
          id: opts.id,
        });
      });
    },
  );

codexAuthSubscription
  .command("upload <authJsonPath>")
  .description("upload an auth.json file for subscription auth")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(
    async (
      authJsonPath: string,
      opts: { workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth subscription upload", async (ctx) => {
        return await workspaceCodexAuthUploadFileData({
          ctx,
          workspaceIdentifier: opts.workspace,
          localPath: authJsonPath,
        });
      });
    },
  );

const codexAuthApiKey = codexAuth
  .command("api-key")
  .description("manage OpenAI API keys used for codex auth");

codexAuthApiKey
  .command("status")
  .description("show OpenAI API key status for account and workspace")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace codex auth api-key status", async (ctx) => {
      const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      const status = await ctx.hub.system.getOpenAiApiKeyStatus({
        project_id: workspace.project_id,
      });
      return {
        workspace_id: workspace.project_id,
        workspace_title: workspace.title,
        account_api_key_configured: !!status?.account,
        account_api_key_updated: toIso(status?.account?.updated),
        account_api_key_last_used: toIso(status?.account?.last_used),
        workspace_api_key_configured: !!status?.project,
        workspace_api_key_updated: toIso(status?.project?.updated),
        workspace_api_key_last_used: toIso(status?.project?.last_used),
      };
    });
  });

codexAuthApiKey
  .command("set")
  .description("set an OpenAI API key for workspace (default) or account scope")
  .requiredOption("--api-key <key>", "OpenAI API key")
  .option("--scope <scope>", "workspace|account", "workspace")
  .option("-w, --workspace <workspace>", "workspace id or name (for workspace scope)")
  .action(
    async (
      opts: {
        apiKey: string;
        scope?: string;
        workspace?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth api-key set", async (ctx) => {
        const scope = `${opts.scope ?? "workspace"}`.trim().toLowerCase();
        const apiKey = `${opts.apiKey ?? ""}`.trim();
        if (!apiKey) {
          throw new Error("--api-key must be non-empty");
        }
        if (scope !== "workspace" && scope !== "account") {
          throw new Error("scope must be 'workspace' or 'account'");
        }
        if (scope === "workspace") {
          const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
          const result = await ctx.hub.system.setOpenAiApiKey({
            project_id: workspace.project_id,
            api_key: apiKey,
          });
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            credential_id: result.id,
            created: result.created,
            status: "saved",
          };
        }
        const result = await ctx.hub.system.setOpenAiApiKey({
          api_key: apiKey,
        });
        return {
          scope,
          credential_id: result.id,
          created: result.created,
          status: "saved",
        };
      });
    },
  );

codexAuthApiKey
  .command("delete")
  .description("delete OpenAI API key at workspace (default) or account scope")
  .option("--scope <scope>", "workspace|account", "workspace")
  .option("-w, --workspace <workspace>", "workspace id or name (for workspace scope)")
  .action(
    async (
      opts: { scope?: string; workspace?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace codex auth api-key delete", async (ctx) => {
        const scope = `${opts.scope ?? "workspace"}`.trim().toLowerCase();
        if (scope !== "workspace" && scope !== "account") {
          throw new Error("scope must be 'workspace' or 'account'");
        }
        if (scope === "workspace") {
          const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
          const result = await ctx.hub.system.deleteOpenAiApiKey({
            project_id: workspace.project_id,
          });
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            revoked: result.revoked,
          };
        }
        const result = await ctx.hub.system.deleteOpenAiApiKey({});
        return {
          scope,
          revoked: result.revoked,
        };
      });
    },
  );

const collab = workspace
  .command("collab")
  .description("workspace collaborator operations");

collab
  .command("search <query>")
  .description("search for existing accounts by name/email/account id")
  .option("--limit <n>", "max rows", "20")
  .action(
    async (query: string, opts: { limit?: string }, command: Command) => {
      await withContext(command, "workspace collab search", async (ctx) => {
        const limit = Math.max(1, Math.min(100, Number(opts.limit ?? "20") || 20));
        const rows = await ctx.hub.system.userSearch({
          query,
          limit,
          ...(query.includes("@") ? { only_email: true } : undefined),
        });
        return (rows ?? []).map((row) => ({
          account_id: row.account_id,
          name: normalizeUserSearchName(row),
          first_name: row.first_name ?? null,
          last_name: row.last_name ?? null,
          email_address: row.email_address ?? null,
          last_active: row.last_active ?? null,
          created: row.created ?? null,
        }));
      });
    },
  );

collab
  .command("list")
  .description("list collaborators for a workspace or all your collaborators")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--limit <n>", "max rows for account-wide listing", "500")
  .action(
    async (
      opts: { workspace?: string; limit?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace collab list", async (ctx) => {
        if (opts.workspace) {
          const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
          const rows = (await ctx.hub.projects.listCollaborators({
            project_id: workspace.project_id,
          })) as ProjectCollaboratorRow[];
          return (rows ?? []).map((row) => ({
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            account_id: row.account_id,
            group: row.group,
            name:
              `${row.name ?? ""}`.trim() ||
              `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
              null,
            first_name: row.first_name ?? null,
            last_name: row.last_name ?? null,
            email_address: row.email_address ?? null,
            last_active: toIso(row.last_active),
          }));
        }
        const limit = Math.max(1, Math.min(1000, Number(opts.limit ?? "500") || 500));
        const rows = (await ctx.hub.projects.listMyCollaborators({
          limit,
        })) as MyCollaboratorRow[];
        return (rows ?? []).map((row) => ({
          account_id: row.account_id,
          name:
            `${row.name ?? ""}`.trim() ||
            `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
            null,
          first_name: row.first_name ?? null,
          last_name: row.last_name ?? null,
          email_address: row.email_address ?? null,
          last_active: toIso(row.last_active),
          shared_projects: row.shared_projects ?? 0,
        }));
      });
    },
  );

collab
  .command("add")
  .description("invite (default) or directly add a collaborator to a workspace")
  .requiredOption("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--user <user>", "target account id, username, or email")
  .option("--message <message>", "optional invite message")
  .option("--direct", "directly add collaborator instead of creating an invite (admin only)")
  .action(
    async (
      opts: {
        workspace: string;
        user: string;
        message?: string;
        direct?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace collab add", async (ctx) => {
        const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const target = await resolveAccountByIdentifier(ctx, opts.user);
        const result = (await ctx.hub.projects.createCollabInvite({
          project_id: workspace.project_id,
          invitee_account_id: target.account_id,
          message: opts.message,
          direct: !!opts.direct,
        })) as {
          created: boolean;
          invite: ProjectCollabInviteRow;
        };
        return {
          workspace_id: workspace.project_id,
          workspace_title: workspace.title,
          target_account_id: target.account_id,
          target_name: normalizeUserSearchName(target),
          created: result.created,
          invite: serializeInviteRow(result.invite),
        };
      });
    },
  );

collab
  .command("remove")
  .description("remove a collaborator from a workspace")
  .requiredOption("-w, --workspace <workspace>", "workspace id or name")
  .requiredOption("--user <user>", "target account id, username, or email")
  .action(
    async (
      opts: { workspace: string; user: string },
      command: Command,
    ) => {
      await withContext(command, "workspace collab remove", async (ctx) => {
        const workspace = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
        const target = await resolveAccountByIdentifier(ctx, opts.user);
        await ctx.hub.projects.removeCollaborator({
          opts: {
            project_id: workspace.project_id,
            account_id: target.account_id,
          },
        });
        return {
          workspace_id: workspace.project_id,
          workspace_title: workspace.title,
          target_account_id: target.account_id,
          target_name: normalizeUserSearchName(target),
          status: "removed",
        };
      });
    },
  );

const invite = workspace
  .command("invite")
  .description("manage workspace collaboration invites");

invite
  .command("list")
  .description("list collaboration invites")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option(
    "--direction <direction>",
    "inbound, outbound, or all",
    "all",
  )
  .option(
    "--status <status>",
    "pending, accepted, declined, blocked, expired, canceled",
    "pending",
  )
  .option("--limit <n>", "max rows", "200")
  .option("--full", "include full invite metadata")
  .action(
    async (
      opts: {
        workspace?: string;
        direction?: ProjectCollabInviteDirection;
        status?: ProjectCollabInviteStatus;
        limit?: string;
        full?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "workspace invite list", async (ctx) => {
        const workspace = opts.workspace
          ? await resolveWorkspaceFromArgOrContext(ctx, opts.workspace)
          : null;
        const limit = Math.max(1, Math.min(1000, Number(opts.limit ?? "200") || 200));
        const rows = (await ctx.hub.projects.listCollabInvites({
          project_id: workspace?.project_id,
          direction: opts.direction,
          status: opts.status,
          limit,
        })) as ProjectCollabInviteRow[];
        if (opts.full) {
          return (rows ?? []).map((row) => ({
            ...serializeInviteRow(row),
            workspace_id: row.project_id,
            workspace_title: row.project_title ?? null,
          }));
        }
        return (rows ?? []).map((row) => compactInviteRow(row, ctx.accountId));
      });
    },
  );

async function respondWorkspaceInvite(
  command: Command,
  inviteId: string,
  action: ProjectCollabInviteAction,
): Promise<void> {
  await withContext(command, `workspace invite ${action}`, async (ctx) => {
    const row = (await ctx.hub.projects.respondCollabInvite({
      invite_id: inviteId,
      action,
    })) as ProjectCollabInviteRow;
    return serializeInviteRow(row);
  });
}

invite
  .command("accept <inviteId>")
  .description("accept an invite")
  .action(async (inviteId: string, command: Command) => {
    await respondWorkspaceInvite(command, inviteId, "accept");
  });

invite
  .command("decline <inviteId>")
  .description("decline an invite")
  .action(async (inviteId: string, command: Command) => {
    await respondWorkspaceInvite(command, inviteId, "decline");
  });

invite
  .command("block <inviteId>")
  .description("block inviter and mark invite as blocked")
  .action(async (inviteId: string, command: Command) => {
    await respondWorkspaceInvite(command, inviteId, "block");
  });

invite
  .command("revoke <inviteId>")
  .description("revoke (cancel) an outstanding invite you sent")
  .action(async (inviteId: string, command: Command) => {
    await respondWorkspaceInvite(command, inviteId, "revoke");
  });

invite
  .command("blocks")
  .description("list accounts you have blocked from inviting you")
  .option("--limit <n>", "max rows", "200")
  .action(async (opts: { limit?: string }, command: Command) => {
    await withContext(command, "workspace invite blocks", async (ctx) => {
      const limit = Math.max(1, Math.min(1000, Number(opts.limit ?? "200") || 200));
      const rows = (await ctx.hub.projects.listCollabInviteBlocks({
        limit,
      })) as ProjectCollabInviteBlockRow[];
      return (rows ?? []).map((row) => ({
        blocker_account_id: row.blocker_account_id,
        blocked_account_id: row.blocked_account_id,
        blocked_name:
          `${row.blocked_name ?? ""}`.trim() ||
          `${row.blocked_first_name ?? ""} ${row.blocked_last_name ?? ""}`.trim() ||
          null,
        blocked_email_address: row.blocked_email_address ?? null,
        created: toIso(row.created),
        updated: toIso(row.updated),
      }));
    });
  });

invite
  .command("unblock")
  .description("unblock a previously blocked inviter")
  .requiredOption("--user <user>", "blocked account id, username, or email")
  .action(async (opts: { user: string }, command: Command) => {
    await withContext(command, "workspace invite unblock", async (ctx) => {
      const user = await resolveAccountByIdentifier(ctx, opts.user);
      return (await ctx.hub.projects.unblockCollabInviteSender({
        blocked_account_id: user.account_id,
      })) as {
        unblocked: boolean;
        blocker_account_id: string;
        blocked_account_id: string;
      };
    });
  });

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
