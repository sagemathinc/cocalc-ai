/**
 * Project operational access commands.
 *
 * Covers ssh connectivity, local ssh config integration, runtime log streaming,
 * and endpoint/proxy checks needed for debugging and operator workflows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";

import { PROJECT_LOG_STREAM_NAME } from "@cocalc/conat/hub/api/projects";
import { astream } from "@cocalc/conat/sync/astream";
import type {
  ProjectLogPage,
  ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import type { LroStatus } from "../../core/lro";
import type { ProjectCommandDeps } from "../project";

type SyncKeyInfo = any;
type ProjectRuntimeLogRow = any;
type ProjectLogStreamEntry = {
  mesg: unknown;
  seq: number;
  time: number;
};
type ProjectLogStreamLike = {
  getAll: () => AsyncGenerator<ProjectLogStreamEntry, void, unknown>;
};

export function getMovePlacementFallbackTimeoutMs(
  summary: Pick<LroStatus, "status" | "timedOut">,
  timeoutMs: number,
): number {
  if (summary.timedOut) {
    return timeoutMs;
  }
  // An explicit failed/canceled move can still leave placement eventually
  // updated, but waiting the full command timeout here wedges automation.
  return Math.min(timeoutMs, 10_000);
}

export function assertProjectRehomeConfirmed({
  project_id,
  dest_bay_id,
  yes,
}: {
  project_id: string;
  dest_bay_id: string;
  yes?: boolean;
}): void {
  if (!yes) {
    throw new Error(
      `refusing to rehome project '${project_id}' to bay '${dest_bay_id}' without --yes`,
    );
  }
}

function normalizeProjectLogTime(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function compareProjectLogRows(a: ProjectLogRow, b: ProjectLogRow): number {
  const at = normalizeProjectLogTime(a.time)?.getTime() ?? 0;
  const bt = normalizeProjectLogTime(b.time)?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return `${b.id}`.localeCompare(`${a.id}`);
}

function normalizeProjectLogRow(
  project_id: string,
  entry: ProjectLogStreamEntry,
): ProjectLogRow | null {
  const row = entry.mesg as Partial<ProjectLogRow> | null | undefined;
  const id = `${row?.id ?? ""}`.trim();
  const account_id = `${row?.account_id ?? ""}`.trim();
  if (!id || !account_id) {
    return null;
  }
  return {
    id,
    project_id: `${row?.project_id ?? project_id}`.trim() || project_id,
    account_id,
    time: normalizeProjectLogTime(row?.time) ?? new Date(entry.time),
    event: row?.event ?? {},
  };
}

export async function readProjectLogPage({
  stream,
  project_id,
  limit,
}: {
  stream: ProjectLogStreamLike;
  project_id: string;
  limit: number;
}): Promise<ProjectLogPage> {
  const latestById = new Map<string, ProjectLogRow>();
  for await (const entry of stream.getAll()) {
    const row = normalizeProjectLogRow(project_id, entry);
    if (row) {
      latestById.set(row.id, row);
    }
  }
  const entries = Array.from(latestById.values()).sort(compareProjectLogRows);
  return {
    entries: entries.slice(0, limit),
    has_more: entries.length > limit,
  };
}

function formatProjectLogEvent(event: ProjectLogRow["event"]): string {
  if (typeof event === "string") {
    return event;
  }
  if (event == null) {
    return "";
  }
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}

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
    resolveProjectConatClient,
    printArrayTable,
    parsePositiveInteger,
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
    .option(
      "--check",
      "verify ssh connectivity/authentication non-interactively",
    )
    .option(
      "--require-auth",
      "with --check, require successful auth (not just reachable ssh endpoint)",
    )
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
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
            baseArgs.push(
              "-i",
              keyInfo.private_key_path,
              "-o",
              "IdentitiesOnly=yes",
            );
          }
          baseArgs.push(
            "-o",
            "BatchMode=yes",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "PreferredAuthentications=publickey",
          );
          let sshServer = route.ssh_server;
          if (route.transport !== "direct") {
            const cloudflareHostname = route.cloudflare_hostname;
            if (!cloudflareHostname) {
              throw new Error(
                "project ssh route is missing cloudflare hostname",
              );
            }
            const cloudflared = opts.check
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
              throw new Error(
                `ssh check failed (exit ${result.code})${suffix}`,
              );
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
              key_installed: keyInstall
                ? Boolean((keyInstall as any).installed)
                : false,
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
            key_installed: keyInstall
              ? Boolean((keyInstall as any).installed)
              : false,
            key_already_present: keyInstall
              ? Boolean((keyInstall as any).already_present)
              : false,
          };
        });
      },
    );

  project
    .command("ssh-info")
    .description(
      "print ssh connection info for a project (defaults to context)",
    )
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
          const baseArgs: string[] = [
            "-o",
            "BatchMode=yes",
            "-o",
            "PreferredAuthentications=publickey",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
          ];
          let sshServer = route.ssh_server;
          if (route.transport !== "direct") {
            const cloudflareHostname = route.cloudflare_hostname;
            if (!cloudflareHostname) {
              throw new Error(
                "project ssh route is missing cloudflare hostname",
              );
            }
            const cloudflared =
              `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
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
    .option(
      "--alias <alias>",
      "Host alias in ssh config (defaults to exactly -w value)",
    )
    .option("--config <path>", "ssh config path (default: ~/.ssh/config)")
    .option(
      "--direct",
      "write direct-host ssh route instead of Cloudflare route",
    )
    .option(
      "--key-path <path>",
      "ssh key base path (default: ~/.ssh/id_ed25519)",
    )
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
          const alias = normalizeProjectSshHostAlias(
            opts.alias ?? opts.project,
          );
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
            const cloudflared =
              `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
              "cloudflared";
            lines.push(
              `  ProxyCommand ${cloudflared} access ssh --hostname %h`,
            );
          } else if (route.ssh_port != null) {
            lines.push(`  Port ${route.ssh_port}`);
          }
          if (keyInfo?.private_key_path) {
            lines.push(`  IdentityFile ${keyInfo.private_key_path}`);
            lines.push("  IdentitiesOnly yes");
          }
          lines.push("  BatchMode yes");
          lines.push("  PreferredAuthentications publickey");
          lines.push("  PasswordAuthentication no");
          lines.push("  KbdInteractiveAuthentication no");
          const markers = projectSshConfigBlockMarkers(alias);
          const block = `${markers.start}\n${lines.join("\n")}\n${markers.end}\n`;

          mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
          const existing = existsSync(configPath)
            ? readFileSync(configPath, "utf8")
            : "";
          const stripped = removeProjectSshConfigBlock(
            existing,
            alias,
          ).content.trimEnd();
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
            key_installed: keyInstall
              ? Boolean((keyInstall as any).installed)
              : false,
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
    .option(
      "--alias <alias>",
      "Host alias in ssh config (defaults to exactly -w value)",
    )
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
        await runLocalCommand(
          command,
          "project ssh-config remove",
          async () => {
            const alias = normalizeProjectSshHostAlias(
              opts.alias ?? opts.project,
            );
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
          },
        );
      },
    );

  project
    .command("logs")
    .description(
      "show project runtime logs from project-host (prints nothing if not running)",
    )
    .option("-w, --project <project>", "project id or name")
    .option("--tail <n>", "number of log lines", "200")
    .action(
      async (opts: { project?: string; tail?: string }, command: Command) => {
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
    .command("log")
    .description("show project activity log from the project-log stream")
    .option("-w, --project <project>", "project id or name")
    .option("--limit <n>", "number of log entries", "200")
    .action(
      async (opts: { project?: string; limit?: string }, command: Command) => {
        await withContext(command, "project log", async (ctx) => {
          const { project: ws, client } = await resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const limit = parsePositiveInteger(opts.limit, 200, "--limit");
          const stream = astream<ProjectLogRow>({
            client,
            project_id: ws.project_id,
            name: PROJECT_LOG_STREAM_NAME,
          });
          try {
            const page = await readProjectLogPage({
              stream,
              project_id: ws.project_id,
              limit,
            });
            if (!ctx.globals.json && ctx.globals.output !== "json") {
              printArrayTable(
                page.entries.map((row) => ({
                  time: row.time?.toISOString?.() ?? row.time ?? null,
                  account_id: row.account_id,
                  event: formatProjectLogEvent(row.event),
                  id: row.id,
                })),
              );
              return null;
            }
            return {
              project_id: ws.project_id,
              ...page,
            };
          } finally {
            stream.close();
          }
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
      async (
        opts: { project?: string; host: string; wait?: boolean },
        command: Command,
      ) => {
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

          const placementOk = await waitForProjectPlacement(
            ctx,
            ws.project_id,
            host.id,
            {
              timeoutMs: getMovePlacementFallbackTimeoutMs(
                summary,
                ctx.timeoutMs,
              ),
              pollMs: ctx.pollMs,
            },
          );

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
    .command("rehome")
    .description("move project control-plane ownership to another bay")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--bay <bay>", "destination bay id")
    .option("--reason <reason>", "operator reason, e.g. maintenance or load")
    .option("--campaign <id>", "operator campaign/drain identifier")
    .option("-y, --yes", "confirm the project ownership transfer")
    .action(
      async (
        opts: {
          project?: string;
          bay: string;
          reason?: string;
          campaign?: string;
          yes?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project rehome", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const destBayId = `${opts.bay ?? ""}`.trim();
          if (!destBayId) {
            throw new Error("--bay is required");
          }
          assertProjectRehomeConfirmed({
            project_id: ws.project_id,
            dest_bay_id: destBayId,
            yes: opts.yes,
          });
          return await ctx.hub.projects.rehomeProject({
            project_id: ws.project_id,
            dest_bay_id: destBayId,
            reason: opts.reason,
            campaign_id: opts.campaign,
          });
        });
      },
    );

  project
    .command("rehome-reconcile")
    .description("retry a source-bay project rehome operation")
    .requiredOption("--op-id <id>", "project rehome operation id")
    .action(async (opts: { opId: string }, command: Command) => {
      await withContext(command, "project rehome-reconcile", async (ctx) => {
        const opId = `${opts.opId ?? ""}`.trim();
        if (!opId) {
          throw new Error("--op-id is required");
        }
        return await ctx.hub.projects.reconcileProjectRehome({
          op_id: opId,
        });
      });
    });

  project
    .command("rehome-drain")
    .description("batch rehome projects off the current/source bay")
    .requiredOption("--dest-bay <bay>", "destination bay id")
    .option("--source-bay <bay>", "source bay id; defaults to current bay")
    .option("--limit <n>", "maximum projects to process", "25")
    .option("--campaign <id>", "operator campaign/drain identifier")
    .option("--reason <reason>", "operator reason, e.g. maintenance or load")
    .option("--write", "apply changes instead of dry run", false)
    .action(
      async (
        opts: {
          destBay: string;
          sourceBay?: string;
          limit?: string;
          campaign?: string;
          reason?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project rehome-drain", async (ctx) => {
          const limit = Number(opts.limit ?? "25");
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("--limit must be a positive integer");
          }
          return await ctx.hub.projects.drainProjectRehome({
            source_bay_id: opts.sourceBay?.trim() || undefined,
            dest_bay_id: opts.destBay.trim(),
            limit,
            dry_run: opts.write !== true,
            campaign_id: opts.campaign,
            reason: opts.reason,
          });
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
            throw new Error(
              `copy timed out (op=${op.op_id}, last_status=${summary.status})`,
            );
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `copy failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
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
