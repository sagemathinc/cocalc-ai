#!/usr/bin/env node

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";
import { AsciiTable3 } from "ascii-table3";
import { Command } from "commander";

import pkg from "../../package.json";

import { issueProjectHostAuthToken as issueProjectHostAuthTokenJwt } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import { isValidUUID } from "@cocalc/util/misc";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";

const cliDebugEnabled =
  process.env.COCALC_CLI_DEBUG === "1" || process.env.COCALC_CLI_DEBUG === "true";
if (!cliDebugEnabled) {
  // Keep CLI stdout clean (especially for --json) even when DEBUG is set globally.
  process.env.SMC_TEST ??= "1";
  process.env.DEBUG_CONSOLE ??= "no";
  process.env.DEBUG_FILE ??= "";
}

type GlobalOptions = {
  json?: boolean;
  output?: "table" | "json" | "yaml";
  accountId?: string;
  api?: string;
  timeout?: string;
  pollMs?: string;
};

type CommandContext = {
  globals: GlobalOptions;
  accountId: string;
  timeoutMs: number;
  pollMs: number;
  apiBaseUrl: string;
};

type WorkspaceRow = {
  project_id: string;
  title: string;
  host_id: string | null;
};

type HostRow = {
  id: string;
  name: string;
  public_url: string | null;
  internal_url: string | null;
  ssh_server: string | null;
  metadata: Record<string, any> | null;
  tier?: number | null;
};

type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  timedOut?: boolean;
};

const TERMINAL_LRO_STATUSES = new Set(["succeeded", "failed", "canceled", "expired"]);

function requireAccount(accountId?: string): string {
  if (!accountId) {
    throw new Error("must be signed in");
  }
  return accountId;
}

async function getDbPool() {
  const mod = await import("@cocalc/database/pool");
  return mod.default();
}

async function listAdminAccountIds(): Promise<string[]> {
  const mod = await import("@cocalc/server/accounts/admins");
  return mod.default();
}

async function apiCreateProject(args: {
  account_id?: string;
  title?: string;
  host_id?: string;
  start?: boolean;
}): Promise<string> {
  const mod = await import("@cocalc/server/conat/api/projects");
  return await mod.createProject(args);
}

async function apiStartWorkspace(args: {
  account_id: string;
  project_id: string;
  wait?: boolean;
}): Promise<{ op_id: string }> {
  const mod = await import("@cocalc/server/conat/api/projects");
  return await mod.start(args);
}

async function apiMoveWorkspace(args: {
  account_id: string;
  project_id: string;
  dest_host_id: string;
}): Promise<{ op_id: string }> {
  const mod = await import("@cocalc/server/conat/api/projects");
  return await mod.moveProject(args);
}

async function apiCopyPathBetweenWorkspaces(args: {
  account_id?: string;
  src: { project_id: string; path: string };
  dest: { project_id: string; path: string };
}): Promise<{ op_id: string }> {
  const mod = await import("@cocalc/server/conat/api/projects");
  return await mod.copyPathBetweenProjects(args);
}

async function apiCreateSnapshot(args: {
  account_id?: string;
  project_id: string;
  name?: string;
}): Promise<void> {
  const mod = await import("@cocalc/server/conat/api/projects");
  await mod.createSnapshot(args);
}

async function apiAllSnapshotUsage(args: {
  account_id?: string;
  project_id: string;
}): Promise<
  {
    name: string;
    used: number;
    exclusive: number;
    quota: number;
  }[]
> {
  const mod = await import("@cocalc/server/conat/api/projects");
  return await mod.allSnapshotUsage(args);
}

async function apiExecInWorkspace(args: {
  account_id: string;
  project_id: string;
  execOpts: {
    command: string;
    args?: string[];
    bash?: boolean;
    timeout?: number;
    err_on_exit?: boolean;
    path?: string;
  };
}): Promise<{
  stdout?: string;
  stderr?: string;
  exit_code: number;
  command?: string;
  time?: number;
}> {
  const mod = await import("@cocalc/server/projects/exec");
  return await mod.default(args);
}

function isLocalHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  if (address.startsWith("172.")) {
    const octet = Number.parseInt(address.split(".")[1] ?? "", 10);
    return octet >= 16 && octet <= 31;
  }
  return false;
}

function detectLanIp(): string | undefined {
  const nets = networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      candidates.push(addr.address);
    }
  }
  return candidates.find(isPrivateIpv4) ?? candidates[0];
}

function resolveOnPremHostLocal(fallbackHost?: string | null): string {
  const explicit =
    process.env.COCALC_PUBLIC_HOST ??
    process.env.COCALC_LAUNCHPAD_HOST ??
    process.env.COCALC_ONPREM_HOST;
  const raw =
    explicit ??
    process.env.HOST ??
    process.env.COCALC_HUB_HOSTNAME ??
    fallbackHost ??
    "localhost";
  const value = String(raw).trim();
  if (!value) return "localhost";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      return new URL(value).hostname || "localhost";
    } catch {
      return "localhost";
    }
  }
  if (!explicit && isLocalHost(value)) {
    return detectLanIp() ?? value;
  }
  return value;
}

function durationToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const raw = value.trim().toLowerCase();
  if (!raw) return fallbackMs;
  const match = raw.match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`invalid duration '${value}'`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  return amount * mult[unit];
}

function normalizeUrl(url: string): string {
  const trimmed = `${url}`.trim();
  if (!trimmed) throw new Error("empty url");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  return `http://${trimmed.replace(/\/+$/, "")}`;
}

function defaultApiBaseUrl(): string {
  const raw =
    process.env.COCALC_API_URL ??
    process.env.BASE_URL ??
    `http://127.0.0.1:${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`;
  return normalizeUrl(raw);
}

function parseSshServer(sshServer: string): { host: string; port?: number } {
  const value = sshServer.trim();
  if (!value) {
    throw new Error("host has no ssh_server configured");
  }
  if (value.startsWith("[")) {
    const match = value.match(/^\[(.*)\]:(\d+)$/);
    if (match) {
      return { host: match[1], port: Number(match[2]) };
    }
    return { host: value };
  }
  const match = value.match(/^(.*):(\d+)$/);
  if (match) {
    return { host: match[1], port: Number(match[2]) };
  }
  return { host: value };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  return value as Record<string, unknown>;
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function printKeyValueTable(data: Record<string, unknown>): void {
  const table = new AsciiTable3("Result");
  table.setHeading("Field", "Value");
  for (const [key, value] of Object.entries(data)) {
    table.addRow(key, formatValue(value));
  }
  console.log(table.toString());
}

function printArrayTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const cols = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  const table = new AsciiTable3("Result");
  table.setHeading(...cols);
  for (const row of rows) {
    table.addRow(...cols.map((col) => formatValue(row[col])));
  }
  console.log(table.toString());
}

function emitSuccess(ctx: CommandContext, commandName: string, data: unknown): void {
  if (ctx.globals.json || ctx.globals.output === "json") {
    const payload = {
      ok: true,
      command: commandName,
      data,
      meta: {
        api: ctx.apiBaseUrl,
        account_id: ctx.accountId,
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (Array.isArray(data) && data.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
    printArrayTable(data as Record<string, unknown>[]);
    return;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    printKeyValueTable(asObject(data));
    return;
  }
  if (data != null) {
    console.log(String(data));
  }
}

function emitError(
  ctx: { globals?: GlobalOptions; apiBaseUrl?: string; accountId?: string },
  commandName: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : `${error}`;
  let api = ctx.apiBaseUrl;
  if (!api && ctx.globals?.api) {
    try {
      api = normalizeUrl(ctx.globals.api);
    } catch {
      api = ctx.globals.api;
    }
  }
  const accountId = ctx.accountId ?? ctx.globals?.accountId;
  if (ctx.globals?.json || ctx.globals?.output === "json") {
    const payload = {
      ok: false,
      command: commandName,
      error: {
        code: "command_failed",
        message,
      },
      meta: {
        api,
        account_id: accountId,
      },
    };
    console.error(JSON.stringify(payload, null, 2));
    return;
  }
  console.error(`ERROR: ${message}`);
}

async function resolveAccountId(globals: GlobalOptions): Promise<string> {
  if (globals.accountId) return globals.accountId;
  if (process.env.COCALC_ACCOUNT_ID) return process.env.COCALC_ACCOUNT_ID;
  const ids = await listAdminAccountIds();
  if (!ids.length) {
    throw new Error("unable to determine account_id; pass --account-id");
  }
  return ids[0];
}

function globalsFrom(command: unknown): GlobalOptions {
  const cmd = command as any;
  if (cmd && typeof cmd === "object") {
    if (typeof cmd.optsWithGlobals === "function") {
      return cmd.optsWithGlobals() as GlobalOptions;
    }
    if (typeof cmd.opts === "function") {
      return cmd.opts() as GlobalOptions;
    }
    if (cmd.parent && typeof cmd.parent.optsWithGlobals === "function") {
      return cmd.parent.optsWithGlobals() as GlobalOptions;
    }
    if (cmd.parent && typeof cmd.parent.opts === "function") {
      return cmd.parent.opts() as GlobalOptions;
    }
  }
  if (typeof program?.opts === "function") {
    return program.opts() as GlobalOptions;
  }
  return {};
}

async function contextForGlobals(globals: GlobalOptions): Promise<CommandContext> {
  const accountId = await resolveAccountId(globals);
  return {
    globals,
    accountId,
    timeoutMs: durationToMs(globals.timeout, 600_000),
    pollMs: durationToMs(globals.pollMs, 1_000),
    apiBaseUrl: globals.api ? normalizeUrl(globals.api) : defaultApiBaseUrl(),
  };
}

async function withContext(
  command: unknown,
  commandName: string,
  fn: (ctx: CommandContext) => Promise<unknown>,
): Promise<void> {
  let globals: GlobalOptions = {};
  try {
    globals = globalsFrom(command);
    const ctx = await contextForGlobals(globals);
    const data = await fn(ctx);
    emitSuccess(ctx, commandName, data);
  } catch (error) {
    emitError({ globals }, commandName, error);
    process.exitCode = 1;
  }
}

async function resolveWorkspace(identifier: string): Promise<WorkspaceRow> {
  const pool = await getDbPool();
  if (isValidUUID(identifier)) {
    const { rows } = await pool.query<WorkspaceRow>(
      "SELECT project_id, title, host_id FROM projects WHERE project_id=$1 AND deleted IS NOT true",
      [identifier],
    );
    if (rows[0]) return rows[0];
  }

  const { rows } = await pool.query<WorkspaceRow>(
    "SELECT project_id, title, host_id FROM projects WHERE title=$1 AND deleted IS NOT true ORDER BY created DESC LIMIT 3",
    [identifier],
  );
  if (!rows.length) {
    throw new Error(`workspace '${identifier}' not found`);
  }
  if (rows.length > 1) {
    throw new Error(
      `workspace name '${identifier}' is ambiguous: ${rows.map((x) => x.project_id).join(", ")}`,
    );
  }
  return rows[0];
}

async function resolveHost(identifier: string): Promise<HostRow> {
  const pool = await getDbPool();
  if (isValidUUID(identifier)) {
    const { rows } = await pool.query<HostRow>(
      "SELECT id, name, public_url, internal_url, ssh_server, metadata, tier FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [identifier],
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query<HostRow>(
    "SELECT id, name, public_url, internal_url, ssh_server, metadata, tier FROM project_hosts WHERE name=$1 AND deleted IS NULL ORDER BY created DESC LIMIT 3",
    [identifier],
  );
  if (!rows.length) {
    throw new Error(`host '${identifier}' not found`);
  }
  if (rows.length > 1) {
    throw new Error(
      `host name '${identifier}' is ambiguous: ${rows.map((x) => x.id).join(", ")}`,
    );
  }
  return rows[0];
}

async function requireHostById(hostId: string): Promise<HostRow> {
  const pool = await getDbPool();
  const { rows } = await pool.query<HostRow>(
    "SELECT id, name, public_url, internal_url, ssh_server, metadata, tier FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [hostId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  return row;
}

function hostAllowsDirectAccess(host: HostRow, accountId: string): boolean {
  const owner = host.metadata?.owner ?? "";
  const collaborators = Array.isArray(host.metadata?.collaborators)
    ? host.metadata?.collaborators
    : [];
  return owner === accountId || collaborators.includes(accountId) || host.tier != null;
}

async function assertCanAccessHost(host: HostRow, accountId: string): Promise<void> {
  if (hostAllowsDirectAccess(host, accountId)) {
    return;
  }
  const pool = await getDbPool();
  const { rowCount } = await pool.query(
    `
      SELECT 1
      FROM projects
      WHERE host_id=$1
        AND deleted IS NOT true
        AND users ? $2::text
      LIMIT 1
    `,
    [host.id, accountId],
  );
  if (!rowCount) {
    throw new Error("not authorized");
  }
}

async function resolveHostConnectionLocal({
  account_id,
  host_id,
}: {
  account_id?: string;
  host_id: string;
}): Promise<HostConnectionInfo> {
  const owner = requireAccount(account_id);
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const host = await requireHostById(host_id);
  await assertCanAccessHost(host, owner);

  const machine = host.metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";

  let connect_url: string | null = null;
  let ssh_server: string | null = host.ssh_server ?? null;
  let local_proxy = false;
  let ready = false;
  if (isLocalSelfHost) {
    local_proxy = true;
    ready = !!host.metadata?.self_host?.http_tunnel_port;
    const sshPort = host.metadata?.self_host?.ssh_tunnel_port;
    if (sshPort) {
      const sshHost = resolveOnPremHostLocal();
      ssh_server = `${sshHost}:${sshPort}`;
    }
  } else {
    connect_url = host.public_url ?? host.internal_url ?? null;
    ready = !!connect_url;
  }

  return {
    host_id: host.id,
    name: host.name ?? null,
    ssh_server,
    connect_url,
    local_proxy,
    ready,
  };
}

async function assertAccountNotBanned(accountId: string): Promise<void> {
  const pool = await getDbPool();
  const { rows } = await pool.query<{ banned: boolean | null }>(
    "SELECT banned FROM accounts WHERE account_id=$1::UUID",
    [accountId],
  );
  if (rows[0]?.banned) {
    throw new Error("account is banned");
  }
}

async function assertCanIssueProjectHostToken({
  accountId,
  hostId,
  projectId,
}: {
  accountId: string;
  hostId: string;
  projectId?: string;
}): Promise<void> {
  const host = await requireHostById(hostId);
  if (projectId) {
    const pool = await getDbPool();
    const { rows } = await pool.query<{
      host_id: string;
      group: string | null;
    }>(
      `
        SELECT host_id, users -> $2::text ->> 'group' AS "group"
        FROM projects
        WHERE project_id=$1
          AND deleted IS NOT true
        LIMIT 1
      `,
      [projectId, accountId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("project not found");
    }
    if (row.host_id !== hostId) {
      throw new Error("project is not assigned to the requested host");
    }
    if (row.group === "owner" || row.group === "collaborator") {
      return;
    }
  }
  await assertCanAccessHost(host, accountId);
}

async function issueProjectHostAuthTokenLocal({
  account_id,
  host_id,
  project_id,
  ttl_seconds,
}: {
  account_id?: string;
  host_id: string;
  project_id?: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  const accountId = requireAccount(account_id);
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  await assertAccountNotBanned(accountId);
  await assertCanIssueProjectHostToken({
    accountId,
    hostId: host_id,
    projectId: project_id,
  });

  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    account_id: accountId,
    host_id,
    ttl_seconds,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id, token, expires_at };
}

async function waitForLro(
  opId: string,
  {
    timeoutMs,
    pollMs,
  }: {
    timeoutMs: number;
    pollMs: number;
  },
): Promise<LroStatus> {
  const pool = await getDbPool();
  const start = Date.now();
  let lastStatus = "unknown";
  let lastError: string | null | undefined;
  while (Date.now() - start <= timeoutMs) {
    const { rows } = await pool.query<{ status: string | null; error: string | null }>(
      "SELECT status, error FROM long_running_operations WHERE op_id=$1",
      [opId],
    );
    const row = rows[0];
    const status = row?.status ?? "unknown";
    lastStatus = status;
    lastError = row?.error;
    if (TERMINAL_LRO_STATUSES.has(status)) {
      return { op_id: opId, status, error: row?.error };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    op_id: opId,
    status: lastStatus,
    error: lastError,
    timedOut: true,
  };
}

async function waitForProjectPlacement(
  projectId: string,
  hostId: string,
  {
    timeoutMs,
    pollMs,
  }: {
    timeoutMs: number;
    pollMs: number;
  },
): Promise<boolean> {
  const pool = await getDbPool();
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const { rows } = await pool.query<{ host_id: string | null }>(
      "SELECT host_id FROM projects WHERE project_id=$1",
      [projectId],
    );
    if (rows[0]?.host_id === hostId) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function runSsh(args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function extractCookie(setCookie: string | null, cookieName: string): string | undefined {
  if (!setCookie) return undefined;
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}=([^;]+)`);
  const match = setCookie.match(re);
  if (!match?.[1]) return undefined;
  return `${cookieName}=${match[1]}`;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProxyUrl({
  ctx,
  workspaceIdentifier,
  port,
  hostIdentifier,
}: {
  ctx: CommandContext;
  workspaceIdentifier: string;
  port: number;
  hostIdentifier?: string;
}): Promise<{
  workspace_id: string;
  host_id: string;
  url: string;
  local_proxy: boolean;
}> {
  const workspace = await resolveWorkspace(workspaceIdentifier);
  const host = hostIdentifier
    ? await resolveHost(hostIdentifier)
    : workspace.host_id
      ? await resolveHost(workspace.host_id)
      : null;
  if (!host) {
    throw new Error("workspace has no assigned host; specify --host or start/move the workspace first");
  }

  const connection = await resolveHostConnectionLocal({
    account_id: ctx.accountId,
    host_id: host.id,
  });

  let base = connection.connect_url ? normalizeUrl(connection.connect_url) : "";
  if (!base && connection.local_proxy) {
    base = ctx.apiBaseUrl;
  }
  if (!base) {
    base =
      (host.public_url ? normalizeUrl(host.public_url) : "") ||
      (host.internal_url ? normalizeUrl(host.internal_url) : "");
  }
  if (!base) {
    const publicIp = host.metadata?.runtime?.public_ip ?? host.metadata?.machine?.metadata?.public_ip;
    if (publicIp) {
      base = normalizeUrl(String(publicIp));
    }
  }
  if (!base) {
    throw new Error("unable to determine host base url");
  }

  return {
    workspace_id: workspace.project_id,
    host_id: host.id,
    local_proxy: !!connection.local_proxy,
    url: `${base}/${workspace.project_id}/proxy/${port}/`,
  };
}

const program = new Command();

program
  .name("cocalc")
  .description("CoCalc CLI (Phase 0)")
  .version(pkg.version)
  .option("--json", "output machine-readable JSON")
  .option("--output <format>", "output format (table|json|yaml)", "table")
  .option("--account-id <uuid>", "account id to use for API calls")
  .option("--api <url>", "hub base URL (used for proxy URL composition)")
  .option("--timeout <duration>", "wait timeout (default: 600s)", "600s")
  .option("--poll-ms <duration>", "poll interval (default: 1s)", "1s")
  .showHelpAfterError();

const workspace = program.command("workspace").alias("ws").description("workspace operations");

workspace
  .command("create [name]")
  .description("create a workspace")
  .option("--host <host>", "host id or name")
  .action(async (name: string | undefined, opts: { host?: string }, command: Command) => {
    await withContext(command, "workspace create", async (ctx) => {
      const host = opts.host ? await resolveHost(opts.host) : null;
      const workspaceId = await apiCreateProject({
        account_id: ctx.accountId,
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
  .command("start <workspace>")
  .description("start a workspace")
  .option("--wait", "wait for completion")
  .action(async (workspaceIdentifier: string, opts: { wait?: boolean }, command: Command) => {
    await withContext(command, "workspace start", async (ctx) => {
      const ws = await resolveWorkspace(workspaceIdentifier);
      const op = await apiStartWorkspace({
        account_id: ctx.accountId,
        project_id: ws.project_id,
        wait: false,
      });
      if (opts.wait) {
        const summary = await waitForLro(op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`timeout waiting for start op ${op.op_id}; last status=${summary.status}`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(
            `start failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
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
  .command("exec <workspace> [command...]")
  .description("execute a command in a workspace")
  .option("--timeout <seconds>", "command timeout seconds", "60")
  .option("--path <path>", "working path inside workspace")
  .option("--bash", "treat command as a bash command string")
  .action(
    async (
      workspaceIdentifier: string,
      commandArgs: string[],
      opts: { timeout?: string; path?: string; bash?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace exec", async (ctx) => {
        if (!commandArgs.length) {
          throw new Error("command is required");
        }
        const ws = await resolveWorkspace(workspaceIdentifier);
        const timeout = Number(opts.timeout ?? "60");
        const [first, ...rest] = commandArgs;
        const execOpts = opts.bash
          ? {
              command: commandArgs.join(" "),
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
        const result = await apiExecInWorkspace({
          account_id: ctx.accountId,
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
  .command("ssh <workspace> [sshArgs...]")
  .description("print or open an ssh connection to a workspace")
  .option("--connect", "open ssh instead of printing the target")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(
    async (
      workspaceIdentifier: string,
      sshArgs: string[],
      opts: { connect?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace ssh", async (ctx) => {
        const ws = await resolveWorkspace(workspaceIdentifier);
        if (!ws.host_id) {
          throw new Error("workspace has no assigned host");
        }
        const connection = await resolveHostConnectionLocal({
          account_id: ctx.accountId,
          host_id: ws.host_id,
        });
        if (!connection.ssh_server) {
          throw new Error("host has no ssh server endpoint");
        }
        const parsed = parseSshServer(connection.ssh_server);
        const target = `${ws.project_id}@${parsed.host}`;
        const baseArgs: string[] = [];
        if (parsed.port != null) {
          baseArgs.push("-p", String(parsed.port));
        }
        baseArgs.push(target);

        const commandLine = `ssh ${baseArgs.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ")}`;

        const shouldConnect = !!opts.connect || sshArgs.length > 0;
        if (!shouldConnect) {
          return {
            workspace_id: ws.project_id,
            ssh_server: connection.ssh_server,
            command: commandLine,
          };
        }

        const code = await runSsh([...baseArgs, ...sshArgs]);
        if (code !== 0) {
          process.exitCode = code;
        }
        return {
          workspace_id: ws.project_id,
          ssh_server: connection.ssh_server,
          exit_code: code,
        };
      });
    },
  );

workspace
  .command("move <workspace>")
  .description("move a workspace to another host")
  .requiredOption("--host <host>", "destination host id or name")
  .option("--wait", "wait for completion")
  .action(
    async (
      workspaceIdentifier: string,
      opts: { host: string; wait?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace move", async (ctx) => {
        const ws = await resolveWorkspace(workspaceIdentifier);
        const host = await resolveHost(opts.host);
        const op = await apiMoveWorkspace({
          account_id: ctx.accountId,
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

        const summary = await waitForLro(op.op_id, {
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

        const placementOk = await waitForProjectPlacement(ws.project_id, host.id, {
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
        const srcWs = await resolveWorkspace(opts.srcWorkspace);
        const destWs = await resolveWorkspace(opts.destWorkspace);
        const op = await apiCopyPathBetweenWorkspaces({
          account_id: ctx.accountId,
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

        const summary = await waitForLro(op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`copy timed out (op=${op.op_id}, last_status=${summary.status})`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(
            `copy failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
          );
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

const snapshot = workspace.command("snapshot").description("workspace snapshots");

snapshot
  .command("create <workspace>")
  .description("create a btrfs snapshot")
  .option("--name <name>", "snapshot name")
  .action(
    async (
      workspaceIdentifier: string,
      opts: { name?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace snapshot create", async (ctx) => {
        const ws = await resolveWorkspace(workspaceIdentifier);
        await apiCreateSnapshot({
          account_id: ctx.accountId,
          project_id: ws.project_id,
          name: opts.name,
        });
        return {
          workspace_id: ws.project_id,
          snapshot_name: opts.name ?? "(auto)",
          status: "created",
        };
      });
    },
  );

snapshot
  .command("list <workspace>")
  .description("list snapshot usage")
  .action(async (workspaceIdentifier: string, command: Command) => {
    await withContext(command, "workspace snapshot list", async (ctx) => {
      const ws = await resolveWorkspace(workspaceIdentifier);
      const snapshots = await apiAllSnapshotUsage({
        account_id: ctx.accountId,
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
  .command("url <workspace>")
  .description("compute proxy URL for a workspace port")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .action(
    async (
      workspaceIdentifier: string,
      opts: { port: string; host?: string },
      command: Command,
    ) => {
      await withContext(command, "workspace proxy url", async (ctx) => {
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });
        return details;
      });
    },
  );

proxy
  .command("curl <workspace>")
  .description("request a workspace proxied URL")
  .requiredOption("--port <port>", "port number")
  .option("--host <host>", "host override")
  .option("--path <path>", "path relative to proxied app", "/")
  .option("--token <token>", "project-host HTTP auth token")
  .option("--expect <mode>", "expected outcome: ok|denied|any", "any")
  .action(
    async (
      workspaceIdentifier: string,
      opts: {
        port: string;
        host?: string;
        path?: string;
        token?: string;
        expect?: "ok" | "denied" | "any";
      },
      command: Command,
    ) => {
      await withContext(command, "workspace proxy curl", async (ctx) => {
        const details = await resolveProxyUrl({
          ctx,
          workspaceIdentifier,
          port: Number(opts.port),
          hostIdentifier: opts.host,
        });

        const relativePath = (opts.path ?? "/").replace(/^\/+/, "");
        const requestUrl = relativePath ? `${details.url}${relativePath}` : details.url;

        const timeoutMs = ctx.timeoutMs;
        let response: Response;
        let finalUrl = requestUrl;

        if (opts.token) {
          const bootstrapUrl = new URL(requestUrl);
          bootstrapUrl.searchParams.set(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM, opts.token);
          const bootstrap = await fetchWithTimeout(
            bootstrapUrl.toString(),
            { redirect: "manual" },
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
              response = await fetchWithTimeout(
                finalUrl,
                {
                  headers: {
                    Cookie: cookie,
                  },
                  redirect: "manual",
                },
                timeoutMs,
              );
            }
          }
        } else {
          response = await fetchWithTimeout(requestUrl, { redirect: "manual" }, timeoutMs);
        }

        const body = await response.text();
        const expectMode = opts.expect ?? "any";
        if (expectMode === "ok" && (response.status < 200 || response.status >= 400)) {
          throw new Error(`expected success response, got status ${response.status}`);
        }
        if (
          expectMode === "denied" &&
          !(response.status >= 400 && response.status < 500)
        ) {
          throw new Error(`expected denied (4xx) response, got status ${response.status}`);
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

const host = program.command("host").description("host operations");

host
  .command("resolve-connection <host>")
  .description("resolve host connection info")
  .action(async (hostIdentifier: string, command: Command) => {
    await withContext(command, "host resolve-connection", async (ctx) => {
      const h = await resolveHost(hostIdentifier);
      const info = await resolveHostConnectionLocal({
        account_id: ctx.accountId,
        host_id: h.id,
      });
      return info;
    });
  });

host
  .command("issue-http-token")
  .description("issue a project-host HTTP auth token")
  .requiredOption("--host <host>", "host id or name")
  .option("--workspace <workspace>", "workspace id or name")
  .option("--ttl <seconds>", "token TTL in seconds")
  .action(
    async (
      opts: { host: string; workspace?: string; ttl?: string },
      command: Command,
    ) => {
      await withContext(command, "host issue-http-token", async (ctx) => {
        const h = await resolveHost(opts.host);
        const ws = opts.workspace ? await resolveWorkspace(opts.workspace) : null;
        const ttl = opts.ttl ? Number(opts.ttl) : undefined;
        const token = await issueProjectHostAuthTokenLocal({
          account_id: ctx.accountId,
          host_id: h.id,
          project_id: ws?.project_id,
          ttl_seconds: ttl,
        });
        return {
          host_id: token.host_id,
          workspace_id: ws?.project_id ?? null,
          token: token.token,
          expires_at: token.expires_at,
        };
      });
    },
  );

program.parseAsync(process.argv).catch((error) => {
  emitError({ globals: globalsFrom(program as unknown as Command) }, "cocalc", error);
  process.exit(1);
});
