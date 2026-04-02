/**
 * Project app server lifecycle commands.
 *
 * Phase 0 intentionally keeps this JSON-first and deterministic for agent flows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";

import type { ProjectCommandDeps } from "../project";

type PortableAppSpec = Record<string, any> & { id: string };

type PortableAppSpecBundle = {
  version: 1;
  kind: "cocalc-app-spec-bundle";
  exported_at: string;
  project_id: string;
  apps: PortableAppSpec[];
  skipped?: Array<{ id: string; path?: string; error: string }>;
};

type AppForwardCommandResult = {
  project_id: string;
  app_id: string;
  title: string | null;
  kind: "service" | "static";
  state: string;
  ready: boolean | null;
  ssh_transport: "cloudflare-tcp" | "cloudflare-access-tcp" | "direct";
  ssh_server: string | null;
  remote_port: number;
  local_host: string;
  local_port: number;
  local_url: string;
  command: string;
  ssh_args: string[];
  key_created: boolean;
  key_path: string | null;
  key_installed: boolean;
  key_already_present: boolean;
  note: string;
};

type ManagedAppForwardResult = {
  project_id: string;
  app_id: string;
  title: string | null;
  kind: "service" | "static";
  state: string;
  ready: boolean | null;
  ssh_transport: "cloudflare-tcp" | "cloudflare-access-tcp" | "direct";
  ssh_server: string | null;
  ssh_alias: string;
  ssh_config_path: string;
  remote_port: number;
  local_host: string;
  local_port: number;
  local_url: string;
  forward_id: number | null;
  forward_name: string;
  forward_state: string | null;
  reused: boolean;
  key_created: boolean;
  key_path: string | null;
  key_installed: boolean;
  key_already_present: boolean;
  reflect_home: string;
  session_db: string;
  note: string;
};

type ManagedAppForwardRow = {
  id: number;
  name: string | null;
  project_id: string;
  app_id: string | null;
  local_host: string;
  local_port: number;
  local_url: string;
  remote_port: number;
  state: string | null;
  desired_state: string | null;
  monitor_pid: number | null;
  last_error: string | null;
};

type AppTemplateRow = {
  id: string;
  title: string;
  category: string;
  description?: string;
  homepage?: string;
  template_source?: string;
  template_scope?: "builtin" | "remote" | "project-local";
  source_path?: string;
};

function parsePositiveIntOrThrow(
  value: string | undefined,
  context: string,
): number | undefined {
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

function sanitizeForwardToken(value: string): string {
  const trimmed = `${value}`.trim().toLowerCase();
  const normalized = trimmed
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "app";
}

function managedProjectSshAlias(projectId: string): string {
  return `cocalc-project-${projectId}`;
}

function managedAppForwardName(
  projectId: string,
  appId: string,
  localPort: number,
): string {
  return `cocalc-app-forward-${projectId.slice(0, 8)}-${sanitizeForwardToken(appId)}-${localPort}`;
}

function managedAppForwardPrefix(projectId: string, appId?: string): string {
  const prefix = `cocalc-app-forward-${projectId.slice(0, 8)}-`;
  if (!appId) return prefix;
  return `${prefix}${sanitizeForwardToken(appId)}-`;
}

function localUrlForForward(localHost: string, localPort: number): string {
  return `http://${localHost === "0.0.0.0" ? "127.0.0.1" : localHost}:${localPort}`;
}

function isReflectForwardRunning(state: string | null | undefined): boolean {
  return state === "running" || state === "starting";
}

function formatManagedAppForwardRow(row: any): ManagedAppForwardRow {
  const name = `${row.name ?? ""}`.trim() || null;
  const match =
    name?.match(/^cocalc-app-forward-([a-f0-9]{8})-([a-z0-9._-]+)-(\d+)$/i) ??
    null;
  const localHost =
    `${row.local_host ?? row.local?.split(":")[0] ?? "127.0.0.1"}`.trim() ||
    "127.0.0.1";
  const localPort = Number.parseInt(
    `${row.local_port ?? row.local?.split(":").slice(-1)[0] ?? 0}`,
    10,
  );
  return {
    id: Number(row.id),
    name,
    project_id: `${row.project_id ?? ""}`.trim() || (match?.[1] ?? ""),
    app_id: match?.[2] ?? null,
    local_host: localHost,
    local_port: localPort,
    local_url: localUrlForForward(localHost, localPort),
    remote_port: Number.parseInt(`${row.remote_port ?? 0}`, 10),
    state: row.state ?? row.actual_state ?? null,
    desired_state: row.desired_state ?? null,
    monitor_pid:
      row.monitor_pid == null || row.monitor_pid === ""
        ? null
        : Number.parseInt(`${row.monitor_pid}`, 10),
    last_error: row.last_error ?? null,
  };
}

function filterManagedAppForwardRows(
  rows: unknown[],
  projectId: string,
  appId?: string,
): ManagedAppForwardRow[] {
  const prefix = managedAppForwardPrefix(projectId, appId);
  return rows
    .map((row) => ({
      ...formatManagedAppForwardRow(row),
      project_id: projectId,
    }))
    .filter((row) => row.name?.startsWith(prefix));
}

function printManagedAppForwardRowsHuman(rows: ManagedAppForwardRow[]): void {
  if (!rows.length) {
    console.log("(no managed app forwards)");
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      console.log("");
    }
    const title = row.app_id
      ? `${row.app_id} (#${row.id})`
      : `forward #${row.id}`;
    console.log(`${title}  ${row.state ?? "unknown"}`);
    console.log(`  Local:   ${row.local_url}`);
    console.log(`  Remote:  ${row.remote_port}`);
    if (row.monitor_pid != null) {
      console.log(`  PID:     ${row.monitor_pid}`);
    }
    if (row.last_error) {
      console.log(`  Error:   ${row.last_error}`);
    }
  }
}

function printAppTemplateRowsHuman(rows: AppTemplateRow[]): void {
  if (!rows.length) {
    console.log("(no app templates)");
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (index > 0) {
      console.log("");
    }
    const parts = [row.id];
    if (row.category) parts.push(row.category);
    if (row.template_scope) parts.push(row.template_scope);
    console.log(parts.join("  "));
    console.log(`  Title:   ${row.title}`);
    if (row.description) {
      console.log(`  About:   ${row.description}`);
    }
    if (row.homepage) {
      console.log(`  Docs:    ${row.homepage}`);
    }
    if (row.template_source) {
      console.log(`  Source:  ${row.template_source}`);
    }
    if (row.source_path) {
      console.log(`  Path:    ${row.source_path}`);
    }
  }
}

function ensureManagedProjectSshConfigEntry({
  configPath,
  alias,
  route,
  keyPath,
  cloudflaredBinary,
  removeProjectSshConfigBlock,
  projectSshConfigBlockMarkers,
}: {
  configPath: string;
  alias: string;
  route: {
    ssh_transport: "cloudflare-tcp" | "cloudflare-access-tcp" | "direct";
    ssh_username: string;
    cloudflare_hostname: string | null;
    ssh_host: string | null;
    ssh_port: number | null;
  };
  keyPath: string | null;
  cloudflaredBinary: string | null;
  removeProjectSshConfigBlock: (
    content: string,
    alias: string,
  ) => { content: string };
  projectSshConfigBlockMarkers: (alias: string) => {
    start: string;
    end: string;
  };
}): void {
  const hostName =
    route.ssh_transport !== "direct"
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
  if (route.ssh_transport !== "direct") {
    if (!cloudflaredBinary) {
      throw new Error(
        "cloudflared is required for managed Cloudflare SSH forwarding",
      );
    }
    lines.push(`  ProxyCommand ${cloudflaredBinary} access ssh --hostname %h`);
  } else if (route.ssh_port != null) {
    lines.push(`  Port ${route.ssh_port}`);
  }
  lines.push("  StrictHostKeyChecking accept-new");
  lines.push("  ServerAliveInterval 15");
  lines.push("  ServerAliveCountMax 2");
  if (keyPath) {
    lines.push(`  IdentityFile ${keyPath}`);
    lines.push("  IdentitiesOnly yes");
  }

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
}

async function resolveAppForwardCommand(
  ctx: any,
  deps: ProjectCommandDeps,
  opts: {
    project?: string;
    appId: string;
    direct?: boolean;
    localPort?: string;
    localHost?: string;
    timeout?: string;
    keyPath?: string;
    installKey?: boolean;
  },
): Promise<AppForwardCommandResult> {
  const {
    resolveProjectProjectApi,
    resolveProjectSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    durationToMs,
  } = deps;
  const { project: ws, api } = await resolveProjectProjectApi(
    ctx,
    opts.project,
  );
  const spec = await api.apps.getAppSpec(opts.appId);
  if (spec.kind !== "service") {
    throw new Error(
      `app '${opts.appId}' is ${spec.kind}; only service apps with a TCP port support SSH forwarding`,
    );
  }
  const timeout = opts.timeout ? durationToMs(opts.timeout) : undefined;
  const status = await api.apps.ensureRunning(opts.appId, {
    timeout,
    interval: 500,
  });
  if (!Number.isInteger(status.port) || status.port! <= 0) {
    throw new Error(
      `app '${opts.appId}' is running without a concrete port; cannot generate SSH forward command`,
    );
  }
  const remotePort = status.port!;
  const localPort =
    parseTcpPortOrThrow(opts.localPort, "--local-port") ?? remotePort;
  const localHost = `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";
  const route = await resolveProjectSshConnection(ctx, ws.project_id, {
    direct: !!opts.direct,
  });

  let keyInfo: any = null;
  let keyInstall: Record<string, unknown> | null = null;
  if (opts.installKey !== false) {
    keyInfo = await ensureSyncKeyPair(opts.keyPath);
    keyInstall = await installSyncPublicKey({
      ctx,
      projectIdentifier: ws.project_id,
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
  if (route.transport !== "direct") {
    const cloudflareHostname = route.cloudflare_hostname;
    if (!cloudflareHostname) {
      throw new Error("project ssh route is missing cloudflare hostname");
    }
    const cloudflared =
      `${process.env.COCALC_CLI_CLOUDFLARED ?? "cloudflared"}`.trim() ||
      "cloudflared";
    const proxyCommand = `${cloudflared} access ssh --hostname ${cloudflareHostname}`;
    sshArgs.push("-o", `ProxyCommand=${proxyCommand}`);
    sshTarget = `${route.ssh_username}@${cloudflareHostname}`;
    sshServer = `${cloudflareHostname}:443`;
  } else {
    if (!route.ssh_host) {
      throw new Error("project ssh route is missing host endpoint");
    }
    if (route.ssh_port != null) {
      sshArgs.push("-p", String(route.ssh_port));
    }
    sshTarget = `${route.ssh_username}@${route.ssh_host}`;
  }
  sshArgs.push(sshTarget, "-N");

  const localUrl = `http://${localHost === "0.0.0.0" ? "127.0.0.1" : localHost}:${localPort}`;
  return {
    project_id: ws.project_id,
    app_id: opts.appId,
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
    ssh_args: sshArgs,
    key_created: keyInfo?.created ?? false,
    key_path: keyInfo?.private_key_path ?? null,
    key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
    key_already_present: keyInstall
      ? Boolean((keyInstall as any).already_present)
      : false,
    note: "Run this command on your local machine to create a private tunnel directly to the app port.",
  };
}

async function createManagedAppForward(
  ctx: any,
  deps: ProjectCommandDeps,
  opts: {
    project?: string;
    appId: string;
    direct?: boolean;
    localPort?: string;
    localHost?: string;
    timeout?: string;
    keyPath?: string;
    installKey?: boolean;
    compress?: boolean;
    sshConfig?: string;
  },
): Promise<ManagedAppForwardResult> {
  const {
    resolveProjectProjectApi,
    resolveProjectSshConnection,
    ensureSyncKeyPair,
    installSyncPublicKey,
    durationToMs,
    normalizeProjectSshConfigPath,
    normalizeProjectSshHostAlias,
    removeProjectSshConfigBlock,
    projectSshConfigBlockMarkers,
    resolveCloudflaredBinary,
    runReflectSyncCli,
    listReflectForwards,
    parseCreatedForwardId,
    reflectSyncHomeDir,
    reflectSyncSessionDbPath,
  } = deps;

  const { project, api } = await resolveProjectProjectApi(ctx, opts.project);
  const spec = await api.apps.getAppSpec(opts.appId);
  if (spec.kind !== "service") {
    throw new Error(
      `app '${opts.appId}' is ${spec.kind}; only service apps with a TCP port support SSH forwarding`,
    );
  }

  const timeout = opts.timeout ? durationToMs(opts.timeout) : undefined;
  const status = await api.apps.ensureRunning(opts.appId, {
    timeout,
    interval: 500,
  });
  if (!Number.isInteger(status.port) || status.port! <= 0) {
    throw new Error(
      `app '${opts.appId}' is running without a concrete port; cannot create an SSH forward`,
    );
  }

  const remotePort = status.port!;
  const localPort =
    parseTcpPortOrThrow(opts.localPort, "--local-port") ?? remotePort;
  const localHost = `${opts.localHost ?? "127.0.0.1"}`.trim() || "127.0.0.1";
  const route = await resolveProjectSshConnection(ctx, project.project_id, {
    direct: !!opts.direct,
  });

  let keyInfo: any = null;
  let keyInstall: Record<string, unknown> | null = null;
  if (opts.installKey !== false) {
    keyInfo = await ensureSyncKeyPair(opts.keyPath);
    keyInstall = await installSyncPublicKey({
      ctx,
      projectIdentifier: project.project_id,
      publicKey: keyInfo.public_key,
    });
  }

  const sshAlias = normalizeProjectSshHostAlias(
    managedProjectSshAlias(project.project_id),
  );
  const sshConfigPath = normalizeProjectSshConfigPath(opts.sshConfig);
  const cloudflaredBinary =
    route.transport !== "direct" ? resolveCloudflaredBinary() : null;
  ensureManagedProjectSshConfigEntry({
    configPath: sshConfigPath,
    alias: sshAlias,
    route: {
      ssh_transport: route.transport,
      ssh_username: route.ssh_username,
      cloudflare_hostname: route.cloudflare_hostname,
      ssh_host: route.ssh_host,
      ssh_port: route.ssh_port,
    },
    keyPath: keyInfo?.private_key_path ?? null,
    cloudflaredBinary,
    removeProjectSshConfigBlock,
    projectSshConfigBlockMarkers,
  });

  const forwardName = managedAppForwardName(
    project.project_id,
    opts.appId,
    localPort,
  );
  const existingRows = filterManagedAppForwardRows(
    await listReflectForwards(),
    project.project_id,
    opts.appId,
  );
  const existing = existingRows.find((row) => row.name === forwardName) ?? null;
  let forwardId: number | null = null;
  let forwardState: string | null = existing?.state ?? null;
  let reused = false;

  if (existing && isReflectForwardRunning(existing.state)) {
    forwardId = existing.id;
    reused = true;
  } else {
    if (existing) {
      await runReflectSyncCli(["forward", "terminate", String(existing.id)]);
    }
    const created = await runReflectSyncCli([
      "forward",
      "create",
      `${localHost}:${localPort}`,
      `${sshAlias}:${remotePort}`,
      "--name",
      forwardName,
      ...(opts.compress ? ["--compress"] : []),
    ]);
    forwardId = parseCreatedForwardId(`${created.stdout}\n${created.stderr}`);
    const refreshed = filterManagedAppForwardRows(
      await listReflectForwards(),
      project.project_id,
      opts.appId,
    ).find((row) => row.name === forwardName);
    if (refreshed) {
      forwardId = refreshed.id;
      forwardState = refreshed.state ?? null;
    } else {
      forwardState = "running";
    }
  }

  return {
    project_id: project.project_id,
    app_id: opts.appId,
    title: status.title ?? spec.title ?? null,
    kind: spec.kind,
    state: status.state,
    ready: status.ready ?? null,
    ssh_transport: route.transport,
    ssh_server:
      route.transport !== "direct"
        ? route.cloudflare_hostname
          ? `${route.cloudflare_hostname}:443`
          : null
        : (route.ssh_server ?? null),
    ssh_alias: sshAlias,
    ssh_config_path: sshConfigPath,
    remote_port: remotePort,
    local_host: localHost,
    local_port: localPort,
    local_url: localUrlForForward(localHost, localPort),
    forward_id: forwardId,
    forward_name: forwardName,
    forward_state: forwardState,
    reused,
    key_created: keyInfo?.created ?? false,
    key_path: keyInfo?.private_key_path ?? null,
    key_installed: keyInstall ? Boolean((keyInstall as any).installed) : false,
    key_already_present: keyInstall
      ? Boolean((keyInstall as any).already_present)
      : false,
    reflect_home: reflectSyncHomeDir(),
    session_db: reflectSyncSessionDbPath(),
    note: "The forward is managed locally via reflect-sync. Re-run this command to reuse it, or stop it with 'cocalc project app forward-stop'.",
  };
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
  projectId: string,
  apps: PortableAppSpec[],
  skipped?: Array<{ id: string; path?: string; error: string }>,
): PortableAppSpecBundle {
  return {
    version: 1,
    kind: "cocalc-app-spec-bundle",
    exported_at: new Date().toISOString(),
    project_id: projectId,
    apps,
    skipped: skipped?.length ? skipped : undefined,
  };
}

function parseImportPayload(input: unknown): {
  format: "single" | "bundle";
  specs: PortableAppSpec[];
  source_project_id?: string;
} {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("import payload must be a JSON object");
  }
  const obj = input as Record<string, any>;
  if (Array.isArray(obj.apps)) {
    return {
      format: "bundle",
      specs: obj.apps.map((spec, idx) => asPortableSpec(spec, `apps[${idx}]`)),
      source_project_id:
        typeof obj.project_id === "string" && obj.project_id.trim()
          ? obj.project_id.trim()
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
  readFileLocal: ProjectCommandDeps["readFileLocal"],
  readAllStdin: ProjectCommandDeps["readAllStdin"],
): Promise<unknown> {
  const raw =
    path === "-" ? await readAllStdin() : await readFileLocal(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse JSON from ${path === "-" ? "stdin" : path}: ${err}`,
    );
  }
}

async function writeJsonFile(
  path: string,
  value: unknown,
  mkdirLocal: ProjectCommandDeps["mkdirLocal"],
  writeFileLocal: ProjectCommandDeps["writeFileLocal"],
): Promise<void> {
  await mkdirLocal(dirname(path), { recursive: true });
  await writeFileLocal(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function registerProjectAppCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectProjectApi,
    resolveProjectFromArgOrContext,
    readFileLocal,
    readAllStdin,
    mkdirLocal,
    writeFileLocal,
    listReflectForwards,
    terminateReflectForwards,
  } = deps;

  const app = project
    .command("app")
    .description("project app server specs and lifecycle");

  app
    .command("list")
    .description("list app specs with runtime status")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project app list", async (ctx) => {
        const { project: ws, api } = await resolveProjectProjectApi(
          ctx,
          opts.project,
        );
        const rows = await api.apps.listAppStatuses();
        return {
          project_id: ws.project_id,
          items: rows,
        };
      });
    });

  app
    .command("templates")
    .description("list merged app template catalog entries")
    .option("-w, --project <project>", "project id or name")
    .action(async (opts: { project?: string }, command: Command) => {
      await withContext(command, "project app templates", async (ctx) => {
        const { project: ws, api } = await resolveProjectProjectApi(
          ctx,
          opts.project,
        );
        const rows = (await api.apps.listAppTemplates()).map((row) => ({
          id: row.id,
          title: row.title,
          category: row.category,
          description: row.description,
          homepage: row.homepage,
          template_source: row.template_source,
          template_scope: row.template_scope,
          source_path: row.source_path,
        }));
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          printAppTemplateRowsHuman(rows);
          return null;
        }
        return {
          project_id: ws.project_id,
          items: rows,
        };
      });
    });

  app
    .command("get <appId>")
    .description("get one app spec")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app get", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const spec = await api.apps.getAppSpec(appId);
          return {
            project_id: ws.project_id,
            app_id: spec.id,
            spec,
          };
        });
      },
    );

  app
    .command("metrics [appId]")
    .description("show app traffic and usage metrics")
    .option("-w, --project <project>", "project id or name")
    .option("--minutes <n>", "history window in minutes", "60")
    .action(
      async (
        appId: string | undefined,
        opts: { project?: string; minutes?: string },
        command: Command,
      ) => {
        await withContext(command, "project app metrics", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const minutes =
            parsePositiveIntOrThrow(opts.minutes, "minutes") ?? 60;
          if (appId) {
            const item = await api.apps.appMetrics(appId, { minutes });
            return {
              project_id: ws.project_id,
              minutes,
              item,
            };
          }
          const items = await api.apps.listAppMetrics({ minutes });
          return {
            project_id: ws.project_id,
            minutes,
            items,
          };
        });
      },
    );

  app
    .command("forward <appId>")
    .description("create or reuse a managed local SSH tunnel to a service app")
    .option("-w, --project <project>", "project id or name")
    .option(
      "--direct",
      "bypass the Cloudflare ssh hostname and use the direct host ssh endpoint",
    )
    .option(
      "--local-port <port>",
      "local port to bind (default: same as app port)",
    )
    .option("--local-host <host>", "local bind host", "127.0.0.1")
    .option("--timeout <duration>", "ensure-running timeout (e.g. 30s, 2m)")
    .option("--compress", "enable SSH compression for the managed tunnel")
    .option(
      "--ssh-config <path>",
      "ssh config path to use/manage (default: ~/.ssh/config)",
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
        appId: string,
        opts: {
          project?: string;
          direct?: boolean;
          localPort?: string;
          localHost?: string;
          timeout?: string;
          compress?: boolean;
          sshConfig?: string;
          keyPath?: string;
          installKey?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project app forward", async (ctx) => {
          const resolved = await createManagedAppForward(ctx, deps, {
            ...opts,
            appId,
          });
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            console.log(
              `${resolved.reused ? "Reusing" : "Created"} local tunnel for ${resolved.title ?? appId} at ${resolved.local_url}.`,
            );
          }
          return resolved;
        });
      },
    );

  app
    .command("forward-list [appId]")
    .description("list managed local SSH tunnels for apps")
    .option("-w, --project <project>", "project id or name")
    .option("--all", "list all managed app tunnels for the project")
    .action(
      async (
        appId: string | undefined,
        opts: { project?: string; all?: boolean },
        command: Command,
      ) => {
        await withContext(command, "project app forward-list", async (ctx) => {
          const { project } = await resolveProjectProjectApi(ctx, opts.project);
          const rows = filterManagedAppForwardRows(
            await listReflectForwards(),
            project.project_id,
            opts.all ? undefined : appId,
          );
          if (!ctx.globals.json && ctx.globals.output !== "json") {
            printManagedAppForwardRowsHuman(rows);
            return null;
          }
          return rows;
        });
      },
    );

  app
    .command("forward-stop [appId]")
    .description("stop one or more managed local SSH tunnels for apps")
    .option("-w, --project <project>", "project id or name")
    .option("--all", "stop all managed app tunnels for the project")
    .action(
      async (
        appId: string | undefined,
        opts: { project?: string; all?: boolean },
        command: Command,
      ) => {
        await withContext(command, "project app forward-stop", async (ctx) => {
          const { project } = await resolveProjectProjectApi(ctx, opts.project);
          const rows = filterManagedAppForwardRows(
            await listReflectForwards(),
            project.project_id,
            opts.all ? undefined : appId,
          );
          if (!rows.length) {
            return {
              project_id: project.project_id,
              terminated: 0,
              refs: [],
            };
          }
          await terminateReflectForwards(rows.map((row) => String(row.id)));
          return {
            project_id: project.project_id,
            terminated: rows.length,
            refs: rows.map((row) => row.id),
          };
        });
      },
    );

  app
    .command("forward-command <appId>", { hidden: true })
    .description(
      "print a local SSH port-forward command for a managed service app",
    )
    .option("-w, --project <project>", "project id or name")
    .option(
      "--direct",
      "bypass the Cloudflare ssh hostname and use the direct host ssh endpoint",
    )
    .option(
      "--local-port <port>",
      "local port to bind (default: same as app port)",
    )
    .option("--local-host <host>", "local bind host", "127.0.0.1")
    .option("--timeout <duration>", "ensure-running timeout (e.g. 30s, 2m)")
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
        appId: string,
        opts: {
          project?: string;
          direct?: boolean;
          localPort?: string;
          localHost?: string;
          timeout?: string;
          keyPath?: string;
          installKey?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project app forward-command",
          async (ctx) => {
            const resolved = await resolveAppForwardCommand(ctx, deps, {
              ...opts,
              appId,
            });
            return resolved;
          },
        );
      },
    );

  app
    .command("export <appId>")
    .description("export one app spec as JSON")
    .option("-w, --project <project>", "project id or name")
    .option("--file <path>", "write JSON to a local file instead of stdout")
    .action(
      async (
        appId: string,
        opts: { project?: string; file?: string },
        command: Command,
      ) => {
        await withContext(command, "project app export", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const spec = asPortableSpec(await api.apps.getAppSpec(appId), "spec");
          if (!opts.file) {
            return {
              project_id: ws.project_id,
              app_id: spec.id,
              spec,
            };
          }
          await writeJsonFile(opts.file, spec, mkdirLocal, writeFileLocal);
          return {
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .option(
      "--file <path>",
      "write JSON bundle to a local file instead of stdout",
    )
    .action(
      async (opts: { project?: string; file?: string }, command: Command) => {
        await withContext(command, "project app export-all", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const rows = await api.apps.listAppSpecs();
          const apps: PortableAppSpec[] = [];
          const skipped: Array<{ id: string; path?: string; error: string }> =
            [];
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
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--file <path>", "local JSON file path, or '-' for stdin")
    .action(
      async (opts: { project?: string; file: string }, command: Command) => {
        await withContext(command, "project app import", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const parsed = await readJsonFileOrStdin(
            opts.file,
            readFileLocal,
            readAllStdin,
          );
          const { format, specs, source_project_id } =
            parseImportPayload(parsed);
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
            project_id: ws.project_id,
            source_project_id,
            import_format: format,
            imported_count: imported.length,
            imported,
          };
        });
      },
    );

  app
    .command("clone <appId>")
    .description("copy one app spec from one project to another")
    .requiredOption("--from-project <project>", "source project id or name")
    .requiredOption("--to-project <project>", "destination project id or name")
    .action(
      async (
        appId: string,
        opts: { fromProject: string; toProject: string },
        command: Command,
      ) => {
        await withContext(command, "project app clone", async (ctx) => {
          const { project: fromWs, api: fromApi } =
            await resolveProjectProjectApi(ctx, opts.fromProject);
          const { project: toWs, api: toApi } = await resolveProjectProjectApi(
            ctx,
            opts.toProject,
          );
          const spec = asPortableSpec(
            await fromApi.apps.getAppSpec(appId),
            "spec",
          );
          const saved = await toApi.apps.upsertAppSpec(spec);
          return {
            source_project_id: fromWs.project_id,
            destination_project_id: toWs.project_id,
            app_id: saved.id,
            path: saved.path,
            spec: saved.spec,
          };
        });
      },
    );

  app
    .command("clone-all")
    .description("copy all app specs from one project to another")
    .requiredOption("--from-project <project>", "source project id or name")
    .requiredOption("--to-project <project>", "destination project id or name")
    .action(
      async (
        opts: { fromProject: string; toProject: string },
        command: Command,
      ) => {
        await withContext(command, "project app clone-all", async (ctx) => {
          const { project: fromWs, api: fromApi } =
            await resolveProjectProjectApi(ctx, opts.fromProject);
          const { project: toWs, api: toApi } = await resolveProjectProjectApi(
            ctx,
            opts.toProject,
          );
          const rows = await fromApi.apps.listAppSpecs();
          const cloned: Array<{
            app_id: string;
            path: string;
          }> = [];
          const skipped: Array<{ id: string; path?: string; error: string }> =
            [];
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
            source_project_id: fromWs.project_id,
            destination_project_id: toWs.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--file <path>", "local path to JSON app spec")
    .action(
      async (opts: { project?: string; file: string }, command: Command) => {
        await withContext(command, "project app upsert", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
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
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app delete", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const result = await api.apps.deleteApp(appId);
          return {
            project_id: ws.project_id,
            ...result,
          };
        });
      },
    );

  app
    .command("start <appId>")
    .description("start app process")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { project?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "project app start", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          if (opts.wait) {
            const timeout = opts.timeout
              ? deps.durationToMs(opts.timeout)
              : undefined;
            const status = await api.apps.ensureRunning(appId, {
              timeout,
              interval: 500,
            });
            return {
              project_id: ws.project_id,
              ...status,
            };
          }
          const status = await api.apps.startApp(appId);
          return {
            project_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("stop <appId>")
    .description("stop app process")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app stop", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          await api.apps.stopApp(appId);
          const status = await api.apps.statusApp(appId);
          return {
            project_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("refresh <appId>")
    .description("run a static app refresh job immediately")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app refresh", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const status = await api.apps.refreshApp(appId);
          const stdout = Buffer.isBuffer(status.stdout)
            ? status.stdout.toString("utf8")
            : status.stdout;
          const stderr = Buffer.isBuffer(status.stderr)
            ? status.stderr.toString("utf8")
            : status.stderr;
          return {
            project_id: ws.project_id,
            ...status,
            stdout,
            stderr,
          };
        });
      },
    );

  app
    .command("restart <appId>")
    .description("restart app process")
    .option("-w, --project <project>", "project id or name")
    .option("--wait", "wait for running+ready state")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .action(
      async (
        appId: string,
        opts: { project?: string; wait?: boolean; timeout?: string },
        command: Command,
      ) => {
        await withContext(command, "project app restart", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          await api.apps.stopApp(appId);
          const timeout = opts.timeout
            ? deps.durationToMs(opts.timeout)
            : undefined;
          const status = opts.wait
            ? await api.apps.ensureRunning(appId, { timeout, interval: 500 })
            : await api.apps.startApp(appId);
          return {
            project_id: ws.project_id,
            ...status,
          };
        });
      },
    );

  app
    .command("status <appId>")
    .description("get app runtime status")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app status", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const status = await api.apps.statusApp(appId);
          const stdout = Buffer.isBuffer(status.stdout)
            ? status.stdout.toString("utf8")
            : status.stdout;
          const stderr = Buffer.isBuffer(status.stderr)
            ? status.stderr.toString("utf8")
            : status.stderr;
          return {
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .option("--tail <lines>", "tail lines per stream", "200")
    .action(
      async (
        appId: string,
        opts: { project?: string; tail?: string },
        command: Command,
      ) => {
        await withContext(command, "project app logs", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const data = await api.apps.appLogs(appId);
          const tail = parsePositiveIntOrThrow(opts.tail, "--tail") ?? 200;
          const takeTail = (text: string) =>
            text.split(/\r?\n/).slice(-tail).join("\n").trim();
          return {
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .option("--include-managed", "include already managed app ports")
    .option("--limit <n>", "maximum rows to return", "200")
    .action(
      async (
        opts: {
          project?: string;
          includeManaged?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project app detect", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const limit = parsePositiveIntOrThrow(opts.limit, "--limit") ?? 200;
          const items = await api.apps.detectApps({
            include_managed: !!opts.includeManaged,
            limit,
          });
          return {
            project_id: ws.project_id,
            count: items.length,
            items,
          };
        });
      },
    );

  app
    .command("audit <appId>")
    .description("audit app public-readiness for agent and operator workflows")
    .option("-w, --project <project>", "project id or name")
    .option(
      "--public-readiness",
      "run public-readiness audit mode (currently the default and only mode)",
      true,
    )
    .action(
      async (
        appId: string,
        opts: {
          project?: string;
          publicReadiness?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project app audit", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          if (opts.publicReadiness === false) {
            throw new Error("only --public-readiness mode is supported");
          }
          const audit = await api.apps.auditAppPublicReadiness(appId);
          return {
            project_id: ws.project_id,
            mode: "public-readiness",
            ...audit,
          };
        });
      },
    );

  app
    .command("expose <appId>")
    .description("enable public app access with required TTL")
    .option("-w, --project <project>", "project id or name")
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
          project?: string;
          ttl: string;
          frontAuth?: "token" | "none";
          randomSubdomain?: boolean;
          subdomainLabel?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project app expose", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
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
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .action(
      async (appId: string, opts: { project?: string }, command: Command) => {
        await withContext(command, "project app unexpose", async (ctx) => {
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const status = await api.apps.unexposeApp(appId);
          return {
            project_id: ws.project_id,
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
    .option("-w, --project <project>", "project id or name")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          project?: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "project app ensure-running",
          async (ctx) => {
            const { project: ws, api } = await resolveProjectProjectApi(
              ctx,
              opts.project,
            );
            const timeout = opts.timeout
              ? deps.durationToMs(opts.timeout)
              : undefined;
            const interval =
              parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
            const status = await api.apps.ensureRunning(appId, {
              timeout,
              interval,
            });
            return {
              project_id: ws.project_id,
              ...status,
            };
          },
        );
      },
    );

  app
    .command("wait <appId>")
    .description("wait for app runtime state")
    .option("-w, --project <project>", "project id or name")
    .requiredOption("--state <state>", "running or stopped")
    .option("--timeout <duration>", "wait timeout (e.g. 30s, 2m)")
    .option("--interval-ms <ms>", "poll interval in milliseconds", "500")
    .action(
      async (
        appId: string,
        opts: {
          project?: string;
          state: string;
          timeout?: string;
          intervalMs?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "project app wait", async (ctx) => {
          const desired = `${opts.state}`.trim().toLowerCase();
          if (desired !== "running" && desired !== "stopped") {
            throw new Error("--state must be running or stopped");
          }
          const { project: ws, api } = await resolveProjectProjectApi(
            ctx,
            opts.project,
          );
          const timeout = opts.timeout
            ? deps.durationToMs(opts.timeout)
            : undefined;
          const interval =
            parsePositiveIntOrThrow(opts.intervalMs, "--interval-ms") ?? 500;
          const ok = await api.apps.waitForAppState(appId, desired, {
            timeout,
            interval,
          });
          return {
            project_id: ws.project_id,
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
      await withContext(command, "project app open-mode-help", async () => {
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
      await withContext(
        command,
        "project app bootstrap-example",
        async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx);
          return {
            project_id: ws.project_id,
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
        },
      );
    });
}
