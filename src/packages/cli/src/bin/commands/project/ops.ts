/**
 * Project operational access commands.
 *
 * Covers ssh connectivity, local ssh config integration, runtime log streaming,
 * and endpoint/proxy checks needed for debugging and operator workflows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type SyncKeyInfo = any;
type ProjectRuntimeLogRow = any;

export function registerProjectOpsCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    runSshCheck,
    isLikelySshAuthFailure,
    runSsh,
    resolveCloudflaredBinary,
    normalizeProjectSshHostAlias,
    normalizeProjectSshConfigPath,
    projectSshConfigBlockMarkers,
    removeProjectSshConfigBlock,
    runLocalCommand,
    resolveProjectFromArgOrContext,
    emitProjectFileCatHumanContent,
    resolveHost,
    waitForLro,
    waitForProjectPlacement,
    resolveProject,
  } = deps;

project
  .command("ssh [sshArgs...]")
  .description(
    "connect to a project over ssh (defaults to context); pass remote command after '--'",
  )
  .option("-w, --project <project>", "project id or name")
  .option(
    "--direct",
    "bypass the Cloudflare ssh hostname and connect to the host ssh endpoint directly",
  )
  .option("--check", "verify ssh connectivity/authentication non-interactively")
  .option("--require-auth", "with --check, require successful auth (not just reachable ssh endpoint)")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option(
    "--no-install-key",
    "skip automatic local ssh key ensure + project authorized_keys install",
  )
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(
    async (
      sshArgs: string[],
      opts: {
        project?: string;
        direct?: boolean;
        check?: boolean;
        requireAuth?: boolean;
        keyPath?: string;
        installKey?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "project ssh", async (ctx) => {
        if (opts.check && sshArgs.length > 0) {
          throw new Error("--check does not accept ssh arguments");
        }
        const route = await resolveProjectSshConnection(ctx, opts.project, {
          direct: !!opts.direct,
        });

        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.installKey !== false) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            projectIdentifier: route.project.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const baseArgs: string[] = [];
        if (keyInfo?.private_key_path) {
          baseArgs.push("-i", keyInfo.private_key_path, "-o", "IdentitiesOnly=yes");
        }
        let sshServer = route.ssh_server;
        if (route.transport !== "direct") {
          const cloudflareHostname = route.cloudflare_hostname;
          if (!cloudflareHostname) {
            throw new Error("project ssh route is missing cloudflare hostname");
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
            throw new Error("project ssh route is missing host endpoint");
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
                project_id: route.project.project_id,
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
            project_id: route.project.project_id,
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
          project_id: route.project.project_id,
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

project
  .command("ssh-info")
  .description("print ssh connection info for a project (defaults to context)")
  .option("-w, --project <project>", "project id or name")
  .option(
    "--direct",
    "bypass the Cloudflare ssh hostname and show the direct host ssh endpoint",
  )
  .action(
    async (
      opts: { project?: string; direct?: boolean },
      command: Command,
    ) => {
      await withContext(command, "project ssh-info", async (ctx) => {
        const route = await resolveProjectSshConnection(ctx, opts.project, {
          direct: !!opts.direct,
        });
        const baseArgs: string[] = [];
        let sshServer = route.ssh_server;
        if (route.transport !== "direct") {
          const cloudflareHostname = route.cloudflare_hostname;
          if (!cloudflareHostname) {
            throw new Error("project ssh route is missing cloudflare hostname");
          }
          const cloudflared = `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
            "cloudflared";
          const proxyCommand = `${cloudflared} access ssh --hostname ${cloudflareHostname}`;
          baseArgs.push("-o", `ProxyCommand=${proxyCommand}`);
          baseArgs.push(`${route.ssh_username}@${cloudflareHostname}`);
          sshServer = `${cloudflareHostname}:443`;
        } else {
          if (!route.ssh_host) {
            throw new Error("project ssh route is missing host endpoint");
          }
          if (route.ssh_port != null) {
            baseArgs.push("-p", String(route.ssh_port));
          }
          baseArgs.push(`${route.ssh_username}@${route.ssh_host}`);
        }
        const commandLine = `ssh ${baseArgs.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ")}`;
        return {
          project_id: route.project.project_id,
          ssh_transport: route.transport,
          ssh_server: sshServer,
          command: commandLine,
        };
      });
    },
  );

const projectSshConfig = project
  .command("ssh-config")
  .description("manage local OpenSSH config entries for project ssh");

projectSshConfig
  .command("add")
  .description(
    "add/update a managed ~/.ssh/config entry for project ssh (Host defaults to exactly -w value)",
  )
  .requiredOption("-w, --project <project>", "project id or name")
  .option("--alias <alias>", "Host alias in ssh config (defaults to exactly -w value)")
  .option("--config <path>", "ssh config path (default: ~/.ssh/config)")
  .option("--direct", "write direct-host ssh route instead of Cloudflare route")
  .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
  .option(
    "--no-install-key",
    "skip automatic local ssh key ensure + project authorized_keys install",
  )
  .action(
    async (
      opts: {
        project: string;
        alias?: string;
        config?: string;
        direct?: boolean;
        keyPath?: string;
        installKey?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "project ssh-config add", async (ctx) => {
        const alias = normalizeProjectSshHostAlias(opts.alias ?? opts.project);
        const route = await resolveProjectSshConnection(ctx, opts.project, {
          direct: !!opts.direct,
        });
        const configPath = normalizeProjectSshConfigPath(opts.config);

        let keyInfo: SyncKeyInfo | null = null;
        let keyInstall: Record<string, unknown> | null = null;
        if (opts.installKey !== false) {
          keyInfo = await ensureSyncKeyPair(opts.keyPath);
          keyInstall = await installSyncPublicKey({
            ctx,
            projectIdentifier: route.project.project_id,
            publicKey: keyInfo.public_key,
          });
        }

        const hostName =
          route.transport !== "direct"
            ? `${route.cloudflare_hostname ?? ""}`.trim()
            : `${route.ssh_host ?? ""}`.trim();
        if (!hostName) {
          throw new Error("project ssh route is missing host endpoint");
        }

        const lines = [
          `Host ${alias}`,
          `  HostName ${hostName}`,
          `  User ${route.ssh_username}`,
        ];
        if (route.transport !== "direct") {
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
        const markers = projectSshConfigBlockMarkers(alias);
        const block = `${markers.start}\n${lines.join("\n")}\n${markers.end}\n`;

        mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
        const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        const stripped = removeProjectSshConfigBlock(existing, alias).content.trimEnd();
        const next = stripped ? `${stripped}\n\n${block}` : block;
        writeFileSync(configPath, next, { encoding: "utf8", mode: 0o600 });

        return {
          project_id: route.project.project_id,
          project_title: route.project.title,
          alias,
          config_path: configPath,
          ssh_transport: route.transport,
          ssh_server:
            route.transport !== "direct"
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

projectSshConfig
  .command("remove")
  .description("remove a managed project ssh entry from ~/.ssh/config")
  .requiredOption("-w, --project <project>", "project id or name")
  .option("--alias <alias>", "Host alias in ssh config (defaults to exactly -w value)")
  .option("--config <path>", "ssh config path (default: ~/.ssh/config)")
  .action(
    async (
      opts: {
        project: string;
        alias?: string;
        config?: string;
      },
      command: Command,
    ) => {
      await runLocalCommand(command, "project ssh-config remove", async () => {
        const alias = normalizeProjectSshHostAlias(opts.alias ?? opts.project);
        const configPath = normalizeProjectSshConfigPath(opts.config);
        if (!existsSync(configPath)) {
          return {
            alias,
            config_path: configPath,
            removed: false,
          };
        }
        const existing = readFileSync(configPath, "utf8");
        const stripped = removeProjectSshConfigBlock(existing, alias);
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

project
  .command("logs")
  .description("show project runtime logs from project-host (prints nothing if not running)")
  .option("-w, --project <project>", "project id or name")
  .option("--tail <n>", "number of log lines", "200")
  .action(
    async (
      opts: { project?: string; tail?: string },
      command: Command,
    ) => {
      await withContext(command, "project logs", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        const tail = Number(opts.tail ?? "200");
        if (!Number.isFinite(tail) || tail <= 0) {
          throw new Error("--tail must be a positive integer");
        }
        const log = (await ctx.hub.projects.getRuntimeLog({
          project_id: ws.project_id,
          lines: Math.floor(tail),
        })) as ProjectRuntimeLogRow;
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (log.text) {
            emitProjectFileCatHumanContent(log.text);
          }
          return null;
        }
        return log;
      });
    },
  );

project
  .command("move")
  .description("move a project to another host (defaults to context)")
  .option("-w, --project <project>", "project id or name")
  .requiredOption("--host <host>", "destination host id or name")
  .option("--wait", "wait for completion")
  .action(
    async (opts: { project?: string; host: string; wait?: boolean }, command: Command) => {
      await withContext(command, "project move", async (ctx) => {
        const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
        const host = await resolveHost(ctx, opts.host);
        const op = await ctx.hub.projects.moveProject({
          project_id: ws.project_id,
          dest_host_id: host.id,
        });

        if (!opts.wait) {
          return {
            project_id: ws.project_id,
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
            project_id: ws.project_id,
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
          project_id: ws.project_id,
          dest_host_id: host.id,
          op_id: op.op_id,
          status: summary.status,
          warning:
            "move LRO did not report succeeded, but destination placement was verified",
        };
      });
    },
  );

project
  .command("copy-path")
  .description("copy a path between projects")
  .requiredOption("--src-project <project>", "source project")
  .requiredOption("--src <path>", "source path")
  .requiredOption("--dest-project <project>", "destination project")
  .requiredOption("--dest <path>", "destination path")
  .option("--wait", "wait for completion")
  .action(
    async (
      opts: {
        srcProject: string;
        src: string;
        destProject: string;
        dest: string;
        wait?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "project copy-path", async (ctx) => {
        const srcWs = await resolveProject(ctx, opts.srcProject);
        const destWs = await resolveProject(ctx, opts.destProject);
        const op = await ctx.hub.projects.copyPathBetweenProjects({
          src: { project_id: srcWs.project_id, path: opts.src },
          dest: { project_id: destWs.project_id, path: opts.dest },
        });

        if (!opts.wait) {
          return {
            src_project_id: srcWs.project_id,
            src_path: opts.src,
            dest_project_id: destWs.project_id,
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
          src_project_id: srcWs.project_id,
          src_path: opts.src,
          dest_project_id: destWs.project_id,
          dest_path: opts.dest,
          op_id: op.op_id,
          status: summary.status,
        };
      });
    },
  );
}
