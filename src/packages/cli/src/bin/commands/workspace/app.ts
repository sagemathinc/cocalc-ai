/**
 * Workspace app server lifecycle commands.
 *
 * Phase 0 intentionally keeps this JSON-first and deterministic for agent flows.
 */
import { dirname } from "node:path";
import { Command } from "commander";

import type { WorkspaceCommandDeps } from "../workspace";

type PortableAppSpec = Record<string, any> & { id: string };

type PortableAppSpecBundle = {
  version: 1;
  kind: "cocalc-app-spec-bundle";
  exported_at: string;
  workspace_id: string;
  apps: PortableAppSpec[];
  skipped?: Array<{ id: string; path?: string; error: string }>;
};

function parsePositiveIntOrThrow(value: string | undefined, context: string): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return n;
}

function parseTcpPortOrThrow(
  value: string | undefined,
  context: string,
): number | undefined {
  const n = parsePositiveIntOrThrow(value, context);
  if (n == null) return undefined;
  if (n > 65535) {
    throw new Error(`${context} must be between 1 and 65535`);
  }
  return n;
}

function shellQuoteArg(arg: string): string {
  if (arg === "") return '""';
  return /[^A-Za-z0-9_./:=@-]/.test(arg) ? JSON.stringify(arg) : arg;
}

function buildSshCommand(args: string[]): string {
  return `ssh ${args.map(shellQuoteArg).join(" ")}`;
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function asPortableSpec(spec: unknown, context: string): PortableAppSpec {
  if (spec == null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${context} must be an app spec object`);
  }
  const id = `${(spec as any).id ?? ""}`.trim();
  if (!id) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  return spec as PortableAppSpec;
}

function createPortableBundle(
  workspaceId: string,
  apps: PortableAppSpec[],
  skipped?: Array<{ id: string; path?: string; error: string }>,
): PortableAppSpecBundle {
  return {
    version: 1,
    kind: "cocalc-app-spec-bundle",
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    apps,
    skipped: skipped?.length ? skipped : undefined,
  };
}

function parseImportPayload(input: unknown): {
  format: "single" | "bundle";
  specs: PortableAppSpec[];
  source_workspace_id?: string;
} {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("import payload must be a JSON object");
  }
  const obj = input as Record<string, any>;
  if (Array.isArray(obj.apps)) {
    return {
      format: "bundle",
      specs: obj.apps.map((spec, idx) => asPortableSpec(spec, `apps[${idx}]`)),
      source_workspace_id:
        typeof obj.workspace_id === "string" && obj.workspace_id.trim()
          ? obj.workspace_id.trim()
          : undefined,
    };
  }
  return {
    format: "single",
    specs: [asPortableSpec(obj, "spec")],
  };
}

async function readJsonFileOrStdin(
  path: string,
  readFileLocal: WorkspaceCommandDeps["readFileLocal"],
  readAllStdin: WorkspaceCommandDeps["readAllStdin"],
): Promise<unknown> {
  const raw =
    path === "-" ? await readAllStdin() : await readFileLocal(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse JSON from ${path === "-" ? "stdin" : path}: ${err}`);
  }
}

async function writeJsonFile(
  path: string,
  value: unknown,
  mkdirLocal: WorkspaceCommandDeps["mkdirLocal"],
  writeFileLocal: WorkspaceCommandDeps["writeFileLocal"],
): Promise<void> {
  await mkdirLocal(dirname(path), { recursive: true });
  await writeFileLocal(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function registerWorkspaceAppCommands(
  workspace: Command,
  deps: WorkspaceCommandDeps,
): void {
  const {
    withContext,
    resolveWorkspaceProjectApi,
    resolveWorkspaceFromArgOrContext,
    resolveWorkspaceSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    readFileLocal,
    readAllStdin,
    mkdirLocal,
    writeFileLocal,
  } = deps;

  const app = workspace
    .command("app")
    .description("workspace app server specs and lifecycle");

  app
    .command("list")
    .description("list app specs with runtime status")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(async (opts: { workspace?: string }, command: Command) => {
      await withContext(command, "workspace app list", async (ctx) => {
        const { workspace: ws, api } = await resolveWorkspaceProjectApi(
          ctx,
          opts.workspace,
        );
        const rows = await api.apps.listAppStatuses();
        return {
          workspace_id: ws.project_id,
          items: rows,
        };
      });
    });

  app
    .command("get <appId>")
    .description("get one app spec")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app get", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = await api.apps.getAppSpec(appId);
          return {
            workspace_id: ws.project_id,
            app_id: spec.id,
            spec,
          };
        });
      },
    );

  app
    .command("metrics [appId]")
    .description("show app traffic and usage metrics")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--minutes <n>", "history window in minutes", "60")
    .action(
      async (
        appId: string | undefined,
        opts: { workspace?: string; minutes?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app metrics", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const minutes = parsePositiveIntOrThrow(
            opts.minutes,
            "minutes",
          ) ?? 60;
          if (appId) {
            const item = await api.apps.appMetrics(appId, { minutes });
            return {
              workspace_id: ws.project_id,
              minutes,
              item,
            };
          }
          const items = await api.apps.listAppMetrics({ minutes });
          return {
            workspace_id: ws.project_id,
            minutes,
            items,
          };
        });
      },
    );

  app
    .command("forward-command <appId>")
    .description("print a local SSH port-forward command for a managed service app")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--direct", "bypass Cloudflare Access and use the direct host ssh endpoint")
    .option("--local-port <port>", "local port to bind (default: same as app port)")
    .option("--local-host <host>", "local bind host", "127.0.0.1")
    .option("--timeout <duration>", "ensure-running timeout (e.g. 30s, 2m)")
    .option("--key-path <path>", "ssh key base path (default: ~/.ssh/id_ed25519)")
    .option(
      "--no-install-key",
      "skip automatic local ssh key ensure + workspace authorized_keys install",
    )
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          direct?: boolean;
          localPort?: string;
          localHost?: string;
          timeout?: string;
          keyPath?: string;
          installKey?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app forward-command", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = await api.apps.getAppSpec(appId);
          if (spec.kind !== "service") {
            throw new Error(
              `app '${appId}' is ${spec.kind}; only service apps with a TCP port support SSH forwarding`,
            );
          }
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const status = await api.apps.ensureRunning(appId, {
            timeout,
            interval: 500,
          });
          if (!Number.isInteger(status.port) || status.port! <= 0) {
            throw new Error(
              `app '${appId}' is running without a concrete port; cannot generate SSH forward command`,
            );
          }
          const remotePort = status.port!;
          const localPort = parseTcpPortOrThrow(opts.localPort, "--local-port") ?? remotePort;
          const localHost = `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";
          const route = await resolveWorkspaceSshConnection(ctx, ws.project_id, {
            direct: !!opts.direct,
          });

          let keyInfo: any = null;
          let keyInstall: Record<string, unknown> | null = null;
          if (opts.installKey !== false) {
            keyInfo = await ensureSyncKeyPair(opts.keyPath);
            keyInstall = await installSyncPublicKey({
              ctx,
              workspaceIdentifier: ws.project_id,
              publicKey: keyInfo.public_key,
            });
          }

          const sshArgs: string[] = [
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-L",
            `${localHost}:${localPort}:127.0.0.1:${remotePort}`,
          ];
          if (keyInfo?.private_key_path) {
            sshArgs.push("-i", keyInfo.private_key_path, "-o", "IdentitiesOnly=yes");
          }

          let sshServer = route.ssh_server;
          let sshTarget: string;
          let cloudflareLoginHint: string | null = null;
          if (route.transport === "cloudflare-access-tcp") {
            const cloudflareHostname = route.cloudflare_hostname;
            if (!cloudflareHostname) {
              throw new Error("workspace ssh route is missing cloudflare hostname");
            }
            const cloudflared =
              `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() || "cloudflared";
            const proxyCommand = `${cloudflared} access ssh --hostname ${cloudflareHostname}`;
            sshArgs.push("-o", `ProxyCommand=${proxyCommand}`);
            sshTarget = `${route.ssh_username}@${cloudflareHostname}`;
            sshServer = `${cloudflareHostname}:443`;
            cloudflareLoginHint = `cloudflared access login https://${cloudflareHostname}`;
          } else {
            if (!route.ssh_host) {
              throw new Error("workspace ssh route is missing host endpoint");
            }
            if (route.ssh_port != null) {
              sshArgs.push("-p", String(route.ssh_port));
            }
            sshTarget = `${route.ssh_username}@${route.ssh_host}`;
          }
          sshArgs.push(sshTarget, "-N");

          const localUrl = `http://${localHost === "0.0.0.0" ? "127.0.0.1" : localHost}:${localPort}`;
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            title: status.title ?? spec.title ?? null,
            kind: spec.kind,
            state: status.state,
            ready: status.ready ?? null,
            ssh_transport: route.transport,
            ssh_server: sshServer,
            remote_port: remotePort,
            local_host: localHost,
            local_port: localPort,
            local_url: localUrl,
            command: buildSshCommand(sshArgs),
            cloudflare_access_login: cloudflareLoginHint,
            key_created: keyInfo?.created ?? false,
            key_path: keyInfo?.private_key_path ?? null,
            key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
            key_already_present: keyInstall
              ? Boolean((keyInstall as any).already_present)
              : false,
            note:
              "Run this command on your local machine to create a private tunnel directly to the app port.",
          };
        });
      },
    );

  app
    .command("export <appId>")
    .description("export one app spec as JSON")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--file <path>", "write JSON to a local file instead of stdout")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; file?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app export", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = asPortableSpec(await api.apps.getAppSpec(appId), "spec");
          if (!opts.file) {
            return {
              workspace_id: ws.project_id,
              app_id: spec.id,
              spec,
            };
          }
          await writeJsonFile(opts.file, spec, mkdirLocal, writeFileLocal);
          return {
            workspace_id: ws.project_id,
            app_id: spec.id,
            file: opts.file,
            exported: true,
          };
        });
      },
    );

  app
    .command("export-all")
    .description("export all app specs as one JSON bundle")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--file <path>", "write JSON bundle to a local file instead of stdout")
    .action(
      async (
        opts: { workspace?: string; file?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app export-all", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const rows = await api.apps.listAppSpecs();
          const apps: PortableAppSpec[] = [];
          const skipped: Array<{ id: string; path?: string; error: string }> = [];
          for (const row of rows) {
            if (row.spec) {
              apps.push(asPortableSpec(row.spec, `spec:${row.id}`));
              continue;
            }
            skipped.push({
              id: row.id,
              path: row.path,
              error: row.error ?? "spec unavailable",
            });
          }
          const bundle = createPortableBundle(ws.project_id, apps, skipped);
          if (!opts.file) {
            return bundle;
          }
          await writeJsonFile(opts.file, bundle, mkdirLocal, writeFileLocal);
          return {
            workspace_id: ws.project_id,
            file: opts.file,
            exported: apps.length,
            skipped,
          };
        });
      },
    );

  app
    .command("import")
    .description("import one app spec or an app bundle from local JSON")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--file <path>", "local JSON file path, or '-' for stdin")
    .action(
      async (
        opts: { workspace?: string; file: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app import", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const parsed = await readJsonFileOrStdin(
            opts.file,
            readFileLocal,
            readAllStdin,
          );
          const { format, specs, source_workspace_id } = parseImportPayload(parsed);
          const imported: Array<{
            app_id: string;
            path: string;
            spec: unknown;
          }> = [];
          for (const spec of specs) {
            const saved = await api.apps.upsertAppSpec(spec);
            imported.push({
              app_id: saved.id,
              path: saved.path,
              spec: saved.spec,
            });
          }
          return {
            workspace_id: ws.project_id,
            source_workspace_id,
            import_format: format,
            imported_count: imported.length,
            imported,
          };
        });
      },
    );

  app
    .command("clone <appId>")
    .description("copy one app spec from one workspace to another")
    .requiredOption("--from-workspace <workspace>", "source workspace id or name")
    .requiredOption("--to-workspace <workspace>", "destination workspace id or name")
    .action(
      async (
        appId: string,
        opts: { fromWorkspace: string; toWorkspace: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app clone", async (ctx) => {
          const { workspace: fromWs, api: fromApi } = await resolveWorkspaceProjectApi(
            ctx,
            opts.fromWorkspace,
          );
          const { workspace: toWs, api: toApi } = await resolveWorkspaceProjectApi(
            ctx,
            opts.toWorkspace,
          );
          const spec = asPortableSpec(await fromApi.apps.getAppSpec(appId), "spec");
          const saved = await toApi.apps.upsertAppSpec(spec);
          return {
            source_workspace_id: fromWs.project_id,
            destination_workspace_id: toWs.project_id,
            app_id: saved.id,
            path: saved.path,
            spec: saved.spec,
          };
        });
      },
    );

  app
    .command("clone-all")
    .description("copy all app specs from one workspace to another")
    .requiredOption("--from-workspace <workspace>", "source workspace id or name")
    .requiredOption("--to-workspace <workspace>", "destination workspace id or name")
    .action(
      async (
        opts: { fromWorkspace: string; toWorkspace: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app clone-all", async (ctx) => {
          const { workspace: fromWs, api: fromApi } = await resolveWorkspaceProjectApi(
            ctx,
            opts.fromWorkspace,
          );
          const { workspace: toWs, api: toApi } = await resolveWorkspaceProjectApi(
            ctx,
            opts.toWorkspace,
          );
          const rows = await fromApi.apps.listAppSpecs();
          const cloned: Array<{
            app_id: string;
            path: string;
          }> = [];
          const skipped: Array<{ id: string; path?: string; error: string }> = [];
          for (const row of rows) {
            if (!row.spec) {
              skipped.push({
                id: row.id,
                path: row.path,
                error: row.error ?? "spec unavailable",
              });
              continue;
            }
            const saved = await toApi.apps.upsertAppSpec(row.spec);
            cloned.push({
              app_id: saved.id,
              path: saved.path,
            });
          }
          return {
            source_workspace_id: fromWs.project_id,
            destination_workspace_id: toWs.project_id,
            cloned_count: cloned.length,
            cloned,
            skipped,
          };
        });
      },
    );

  app
    .command("upsert")
    .description("create/update app spec from a local JSON file")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--file <path>", "local path to JSON app spec")
    .action(
      async (
        opts: { workspace?: string; file: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app upsert", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const raw = await readFileLocal(opts.file, "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            throw new Error(
              `failed to parse --file as JSON (${opts.file}): ${err}; phase-0 app specs are JSON`,
            );
          }
          const saved = await api.apps.upsertAppSpec(parsed);
          return {
            workspace_id: ws.project_id,
            app_id: saved.id,
            path: saved.path,
            spec: saved.spec,
          };
        });
      },
    );

  app
    .command("delete <appId>")
    .description("delete app spec")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app delete", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const result = await api.apps.deleteApp(appId);
          return {
            workspace_id: ws.project_id,
            ...result,
          };
        });
      },
    );

  app
    .command("start <appId>")
    .description("start app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app start", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          if (opts.wait) {
            const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
            const status = await api.apps.ensureRunning(appId, {
              timeout,
              interval: 500,
            });
            return {
              workspace_id: ws.project_id,
              ...status,
            };
          }
          const status = await api.apps.startApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("stop <appId>")
    .description("stop app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app stop", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          await api.apps.stopApp(appId);
          const status = await api.apps.statusApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("restart <appId>")
    .description("restart app process")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app restart", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          await api.apps.stopApp(appId);
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const status = opts.wait
            ? await api.apps.ensureRunning(appId, { timeout, interval: 500 })
            : await api.apps.startApp(appId);
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("status <appId>")
    .description("get app runtime status")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app status", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const status = await api.apps.statusApp(appId);
          const stdout = Buffer.isBuffer(status.stdout)
            ? status.stdout.toString("utf8")
            : status.stdout;
          const stderr = Buffer.isBuffer(status.stderr)
            ? status.stderr.toString("utf8")
            : status.stderr;
          return {
            workspace_id: ws.project_id,
            ...status,
            stdout,
            stderr,
          };
        });
      },
    );

  app
    .command("logs <appId>")
    .description("show captured app stdout/stderr")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--tail <lines>", "tail lines per stream", "200")
    .action(
      async (
        appId: string,
        opts: { workspace?: string; tail?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app logs", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const data = await api.apps.appLogs(appId);
          const tail = parsePositiveIntOrThrow(opts.tail, "--tail") ?? 200;
          const takeTail = (text: string) =>
            text
              .split(/\r?\n/)
              .slice(-tail)
              .join("\n")
              .trim();
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            state: data.state,
            stdout: takeTail(data.stdout ?? ""),
            stderr: takeTail(data.stderr ?? ""),
          };
        });
      },
    );

  app
    .command("detect")
    .description("detect listening ports that could be proxied as app servers")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--include-managed", "include already managed app ports")
    .option("--limit <n>", "maximum rows to return", "200")
    .action(
      async (
        opts: {
          workspace?: string;
          includeManaged?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app detect", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const limit = parsePositiveIntOrThrow(opts.limit, "--limit") ?? 200;
          const items = await api.apps.detectApps({
            include_managed: !!opts.includeManaged,
            limit,
          });
          return {
            workspace_id: ws.project_id,
            count: items.length,
            items,
          };
        });
      },
    );

  app
    .command("audit <appId>")
    .description("audit app public-readiness for agent and operator workflows")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--public-readiness",
      "run public-readiness audit mode (currently the default and only mode)",
      true,
    )
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          publicReadiness?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app audit", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          if (opts.publicReadiness === false) {
            throw new Error("only --public-readiness mode is supported");
          }
          const audit = await api.apps.auditAppPublicReadiness(appId);
          return {
            workspace_id: ws.project_id,
            mode: "public-readiness",
            ...audit,
          };
        });
      },
    );

  app
    .command("expose <appId>")
    .description("enable public app access with required TTL")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--ttl <duration>", "public exposure TTL (e.g. 10m, 2h)")
    .option(
      "--front-auth <mode>",
      "front auth mode: token|none (default: token)",
      "token",
    )
    .option(
      "--random-subdomain",
      "request random subdomain label metadata",
      true,
    )
    .option(
      "--subdomain-label <label>",
      "explicit public subdomain label (used as <label>-suffix.<domain>)",
    )
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          ttl: string;
          frontAuth?: "token" | "none";
          randomSubdomain?: boolean;
          subdomainLabel?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app expose", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const spec = await api.apps.getAppSpec(appId);
          const ttlMs = deps.durationToMs(opts.ttl);
          const ttl_s = Math.max(60, Math.floor(ttlMs / 1000));
          const auth_front = opts.frontAuth === "none" ? "none" : "token";
          const status = await api.apps.exposeApp({
            id: appId,
            ttl_s,
            auth_front,
            random_subdomain: opts.randomSubdomain !== false,
            subdomain_label: `${opts.subdomainLabel ?? ""}`.trim() || undefined,
          });
          const relative = `/${ws.project_id}${normalizePrefix(spec.proxy?.base_path ?? `/apps/${appId}`)}`;
          const base = `${ctx.apiBaseUrl}`.replace(/\/+$/, "");
          const exposure = status.exposure;
          const url = new URL(
            exposure?.public_url ? exposure.public_url : `${base}${relative}`,
          );
          if (auth_front === "token" && exposure?.token) {
            url.searchParams.set("cocalc_app_token", exposure.token);
          }
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            ttl_s,
            relative_url: relative,
            url_public: url.toString(),
            exposure,
            warnings: status.warnings ?? [],
          };
        });
      },
    );

  app
    .command("unexpose <appId>")
    .description("disable public app access")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .action(
      async (
        appId: string,
        opts: { workspace?: string },
        command: Command,
      ) => {
        await withContext(command, "workspace app unexpose", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const status = await api.apps.unexposeApp(appId);
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            exposure: status.exposure,
            state: status.state,
          };
        });
      },
    );

  app
    .command("ensure-running <appId>")
    .description("start app and wait until ready")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app ensure-running", async (ctx) => {
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const interval = parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
          const status = await api.apps.ensureRunning(appId, {
            timeout,
            interval,
          });
          return {
            workspace_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("wait <appId>")
    .description("wait for app runtime state")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .requiredOption("--state <state>", "running or stopped")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          workspace?: string;
          state: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "workspace app wait", async (ctx) => {
          const desired = `${opts.state}`.trim().toLowerCase();
          if (desired !== "running" && desired !== "stopped") {
            throw new Error("--state must be running or stopped");
          }
          const { workspace: ws, api } = await resolveWorkspaceProjectApi(
            ctx,
            opts.workspace,
          );
          const timeout = opts.timeout ? deps.durationToMs(opts.timeout) : undefined;
          const interval = parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
          const ok = await api.apps.waitForAppState(appId, desired, {
            timeout,
            interval,
          });
          return {
            workspace_id: ws.project_id,
            app_id: appId,
            state: desired,
            reached: ok,
          };
        });
      },
    );

  app
    .command("open-mode-help")
    .description("explain service proxy open modes: proxy vs port")
    .action(async (_opts: Record<string, never>, command: Command) => {
      await withContext(command, "workspace app open-mode-help", async () => {
        return {
          modes: [
            {
              name: "proxy",
              summary:
                "Default. Request path is stripped to app-relative path before forwarding.",
              use_when:
                "App supports base-path proxying with forwarded prefix/base URL headers.",
            },
            {
              name: "port",
              summary:
                "Port-style passthrough URL shape. Use when strict base-path proxying fails.",
              use_when:
                "App only works when accessed via explicit port route semantics.",
            },
          ],
          fallback_options: [
            "Public Cloudflare exposure for the managed app.",
            "SSH port forwarding for direct non-proxied access.",
          ],
        };
      });
    });

  app
    .command("bootstrap-example")
    .description("emit example JSON app spec")
    .action(async (_opts: Record<string, never>, command: Command) => {
      await withContext(command, "workspace app bootstrap-example", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx);
        return {
          workspace_id: ws.project_id,
          example: {
            version: 1,
            id: "my-app",
            title: "My App",
            kind: "service",
            command: {
              exec: "python3",
              args: ["-m", "http.server", "--bind", "127.0.0.1", "8000"],
            },
            network: {
              listen_host: "127.0.0.1",
              port: 8000,
              protocol: "http",
            },
            proxy: {
              base_path: "/apps/my-app",
              strip_prefix: true,
              websocket: true,
              open_mode: "proxy",
              readiness_timeout_s: 30,
            },
            wake: {
              enabled: true,
              keep_warm_s: 1800,
              startup_timeout_s: 90,
            },
          },
          notes: {
            open_mode:
              "proxy strips the app base path before forwarding; port keeps port-route semantics for hard-to-proxy apps.",
          },
        };
      });
    });
}
