#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { URL } from "node:url";
import { AsciiTable3 } from "ascii-table3";
import { Command } from "commander";

import pkg from "../../package.json";

import { connect as connectConat, type Client as ConatClient } from "@cocalc/conat/core/client";
import callHub from "@cocalc/conat/hub/call-hub";
import { projectApiClient } from "@cocalc/conat/project/api";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";
import { FALLBACK_ACCOUNT_UUID, basePathCookieName, isValidUUID } from "@cocalc/util/misc";

const cliDebugEnabled =
  process.env.COCALC_CLI_DEBUG === "1" || process.env.COCALC_CLI_DEBUG === "true";
if (!cliDebugEnabled) {
  // Keep CLI stdout/stderr clean (especially with --json) even if DEBUG is globally enabled.
  process.env.SMC_TEST ??= "1";
  process.env.DEBUG_CONSOLE ??= "no";
  process.env.DEBUG_FILE ??= "";

  // conat/core/client currently emits this warning via console.log on auth failures;
  // suppress it so CLI JSON output remains parseable.
  const origLog = console.log.bind(console);
  console.log = (...args: any[]) => {
    const first = args[0];
    if (typeof first === "string" && first.startsWith("WARNING: inbox not available --")) {
      return;
    }
    origLog(...args);
  };
}

type GlobalOptions = {
  json?: boolean;
  output?: "table" | "json" | "yaml";
  accountId?: string;
  account_id?: string;
  api?: string;
  timeout?: string;
  pollMs?: string;
  apiKey?: string;
  cookie?: string;
  bearer?: string;
  hubPassword?: string;
};

type RemoteConnection = {
  client: ConatClient;
  user?: Record<string, unknown> | null;
};

type CommandContext = {
  globals: GlobalOptions;
  accountId: string;
  timeoutMs: number;
  pollMs: number;
  apiBaseUrl: string;
  remote: RemoteConnection;
};

type WorkspaceRow = {
  project_id: string;
  title: string;
  host_id: string | null;
  state?: { state?: string } | null;
  last_edited?: string | Date | null;
  deleted?: string | Date | boolean | null;
};

type HostRow = {
  id: string;
  name: string;
  public_ip?: string | null;
  machine?: Record<string, any> | null;
};

type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  timedOut?: boolean;
};

type LroSummary = {
  op_id: string;
  status: string;
  error?: string | null;
};

const TERMINAL_LRO_STATUSES = new Set(["succeeded", "failed", "canceled", "expired"]);

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

function getExplicitAccountId(globals: GlobalOptions): string | undefined {
  return globals.accountId ?? globals.account_id;
}

function normalizeSecretValue(raw: string | undefined): string | undefined {
  const value = `${raw ?? ""}`.trim();
  if (!value) return undefined;
  if (existsSync(value)) {
    try {
      const data = readFileSync(value, "utf8").trim();
      if (data) return data;
    } catch {
      // fall through and use raw value
    }
  }
  return value;
}

function cookieNameFor(baseUrl: string, name: string): string {
  const pathname = new URL(baseUrl).pathname || "/";
  const basePath = pathname.replace(/\/+$/, "") || "/";
  return basePathCookieName({ basePath, name });
}

function buildCookieHeader(baseUrl: string, globals: GlobalOptions): string | undefined {
  const parts: string[] = [];
  if (globals.cookie?.trim()) {
    parts.push(globals.cookie.trim());
  }

  const apiKey = globals.apiKey ?? process.env.COCALC_API_KEY;
  if (apiKey?.trim()) {
    const scopedName = cookieNameFor(baseUrl, "api_key");
    parts.push(`${scopedName}=${apiKey}`);
    if (scopedName !== "api_key") {
      parts.push(`api_key=${apiKey}`);
    }
  }

  const hubPassword = normalizeSecretValue(globals.hubPassword ?? process.env.COCALC_HUB_PASSWORD);
  if (hubPassword?.trim()) {
    const scopedName = cookieNameFor(baseUrl, "hub_password");
    parts.push(`${scopedName}=${hubPassword}`);
    if (scopedName !== "hub_password") {
      parts.push(`hub_password=${hubPassword}`);
    }
  }

  if (!parts.length) return undefined;
  return parts.join("; ");
}

function hasHubPassword(globals: GlobalOptions): boolean {
  return !!normalizeSecretValue(globals.hubPassword ?? process.env.COCALC_HUB_PASSWORD);
}

async function connectRemote({
  globals,
  apiBaseUrl,
  timeoutMs,
}: {
  globals: GlobalOptions;
  apiBaseUrl: string;
  timeoutMs: number;
}): Promise<RemoteConnection> {
  const extraHeaders: Record<string, string> = {};
  const cookie = buildCookieHeader(apiBaseUrl, globals);
  if (cookie) {
    extraHeaders.Cookie = cookie;
  }
  const bearer = globals.bearer ?? process.env.COCALC_BEARER_TOKEN;
  if (bearer?.trim()) {
    extraHeaders.Authorization = `Bearer ${bearer.trim()}`;
  }

  const client = connectConat({
    address: apiBaseUrl,
    noCache: true,
    ...(Object.keys(extraHeaders).length ? { extraHeaders } : undefined),
  });

  await client.waitUntilSignedIn({ timeout: timeoutMs });

  return {
    client,
    user: (client.info as any)?.user,
  };
}

async function resolveDefaultAdminAccountId({
  remote,
  timeoutMs,
}: {
  remote: RemoteConnection;
  timeoutMs: number;
}): Promise<string | undefined> {
  const candidates = Array.from(
    new Set(
      [process.env.COCALC_ACCOUNT_ID, FALLBACK_ACCOUNT_UUID].filter(
        (x): x is string => typeof x === "string" && isValidUUID(x),
      ),
    ),
  );

  async function accountExists(account_id: string): Promise<boolean> {
    try {
      const result = (await callHub({
        client: remote.client,
        account_id,
        name: "db.userQuery",
        args: [
          {
            query: { accounts: [{ account_id: null }] },
            options: [{ limit: 1 }],
          },
        ],
        timeout: timeoutMs,
      })) as { accounts?: Array<{ account_id?: string }> };
      return (
        result?.accounts?.[0]?.account_id != null &&
        isValidUUID(result.accounts[0].account_id)
      );
    } catch {
      return false;
    }
  }

  async function isAdminAccount(account_id: string): Promise<boolean> {
    try {
      await callHub({
        client: remote.client,
        account_id,
        name: "system.userSearch",
        args: [{ query: "a", limit: 1, admin: true }],
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function discoverAccounts(account_id: string): Promise<string[]> {
    const out = new Set<string>();
    const probes = ["a", "e", "i", "o", "u", "w", "s", "n", "t", "r", "1"];
    for (const query of probes) {
      try {
        const rows = (await callHub({
          client: remote.client,
          account_id,
          name: "system.userSearch",
          args: [{ query, limit: 25 }],
          timeout: timeoutMs,
        })) as Array<{ account_id?: string }>;
        for (const row of rows ?? []) {
          const id = row?.account_id;
          if (typeof id === "string" && isValidUUID(id)) {
            out.add(id);
          }
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out);
  }

  const existingCandidates: string[] = [];
  for (const candidate of candidates) {
    if (await accountExists(candidate)) {
      existingCandidates.push(candidate);
      if (await isAdminAccount(candidate)) {
        return candidate;
      }
    }
  }

  for (const candidate of candidates) {
    for (const discovered of await discoverAccounts(candidate)) {
      if (existingCandidates.includes(discovered)) {
        continue;
      }
      if (await accountExists(discovered)) {
        existingCandidates.push(discovered);
        if (await isAdminAccount(discovered)) {
          return discovered;
        }
      }
    }
  }

  return existingCandidates[0] ?? candidates[0];
}

function resolveAccountIdFromRemote(remote: RemoteConnection): string | undefined {
  const value = remote.user?.account_id;
  if (typeof value === "string" && isValidUUID(value)) {
    return value;
  }
  return undefined;
}

async function contextForGlobals(globals: GlobalOptions): Promise<CommandContext> {
  const timeoutMs = durationToMs(globals.timeout, 600_000);
  const pollMs = durationToMs(globals.pollMs, 1_000);
  const apiBaseUrl = globals.api ? normalizeUrl(globals.api) : defaultApiBaseUrl();
  const remote = await connectRemote({ globals, apiBaseUrl, timeoutMs });

  let accountId =
    getExplicitAccountId(globals) ??
    process.env.COCALC_ACCOUNT_ID ??
    resolveAccountIdFromRemote(remote);

  if (!accountId && hasHubPassword(globals)) {
    accountId = await resolveDefaultAdminAccountId({ remote, timeoutMs });
  }

  if (!accountId || !isValidUUID(accountId)) {
    throw new Error(
      "unable to determine account_id; pass --account-id or authenticate with an account api key/cookie",
    );
  }

  return {
    globals,
    accountId,
    timeoutMs,
    pollMs,
    apiBaseUrl,
    remote,
  };
}

async function withContext(
  command: unknown,
  commandName: string,
  fn: (ctx: CommandContext) => Promise<unknown>,
): Promise<void> {
  let globals: GlobalOptions = {};
  let ctx: CommandContext | undefined;
  try {
    globals = globalsFrom(command);
    ctx = await contextForGlobals(globals);
    const data = await fn(ctx);
    emitSuccess(ctx, commandName, data);
  } catch (error) {
    emitError(
      { globals, apiBaseUrl: ctx?.apiBaseUrl, accountId: ctx?.accountId },
      commandName,
      error,
    );
    process.exitCode = 1;
  } finally {
    try {
      ctx?.remote.client.close();
    } catch {
      // ignore
    }
  }
}

async function hubCallAccount<T>(
  ctx: CommandContext,
  name: string,
  args: any[] = [],
  timeout?: number,
): Promise<T> {
  return (await callHub({
    client: ctx.remote.client,
    account_id: ctx.accountId,
    name,
    args,
    timeout: timeout ?? ctx.timeoutMs,
  })) as T;
}

async function userQueryTable<T>(
  ctx: CommandContext,
  table: string,
  row: Record<string, unknown>,
  options: any[] = [],
): Promise<T[]> {
  const query = {
    [table]: [row],
  };
  const result = await hubCallAccount<Record<string, T[]>>(ctx, "db.userQuery", [
    {
      query,
      options,
    },
  ]);
  const rows = result?.[table];
  return Array.isArray(rows) ? rows : [];
}

function toIso(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function workspaceState(value: WorkspaceRow["state"]): string {
  return typeof value?.state === "string" ? value.state : "";
}

function isDeleted(value: WorkspaceRow["deleted"]): boolean {
  return value != null && value !== false;
}

async function queryProjects({
  ctx,
  project_id,
  title,
  host_id,
  limit,
}: {
  ctx: CommandContext;
  project_id?: string;
  title?: string;
  host_id?: string | null;
  limit: number;
}): Promise<WorkspaceRow[]> {
  const row: Record<string, unknown> = {
    project_id: null,
    title: null,
    host_id: null,
    state: null,
    last_edited: null,
    deleted: null,
  };
  if (project_id != null) {
    row.project_id = project_id;
  }
  if (title != null) {
    row.title = title;
  }
  if (host_id != null) {
    row.host_id = host_id;
  }
  const rows = await userQueryTable<WorkspaceRow>(ctx, "projects_all", row, [
    { limit, order_by: "-last_edited" },
  ]);
  return rows.filter((x) => !isDeleted(x.deleted));
}

async function resolveWorkspace(ctx: CommandContext, identifier: string): Promise<WorkspaceRow> {
  if (isValidUUID(identifier)) {
    const rows = await queryProjects({
      ctx,
      project_id: identifier,
      limit: 3,
    });
    if (rows[0]) return rows[0];
  }

  const rows = await queryProjects({
    ctx,
    title: identifier,
    limit: 25,
  });
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

async function resolveHost(ctx: CommandContext, identifier: string): Promise<HostRow> {
  const hosts = await hubCallAccount<HostRow[]>(ctx, "hosts.listHosts", [
    { include_deleted: false, catalog: true },
  ]);
  if (!Array.isArray(hosts) || !hosts.length) {
    throw new Error("no hosts are visible to this account");
  }

  if (isValidUUID(identifier)) {
    const match = hosts.find((x) => x.id === identifier);
    if (match) {
      return match;
    }
    throw new Error(`host '${identifier}' not found`);
  }

  const matches = hosts.filter((x) => x.name === identifier);
  if (!matches.length) {
    throw new Error(`host '${identifier}' not found`);
  }
  if (matches.length > 1) {
    throw new Error(`host name '${identifier}' is ambiguous: ${matches.map((x) => x.id).join(", ")}`);
  }
  return matches[0];
}

async function waitForLro(
  ctx: CommandContext,
  opId: string,
  {
    timeoutMs,
    pollMs,
  }: {
    timeoutMs: number;
    pollMs: number;
  },
): Promise<LroStatus> {
  const started = Date.now();
  let lastStatus = "unknown";
  let lastError: string | null | undefined;

  while (Date.now() - started <= timeoutMs) {
    const summary = await hubCallAccount<LroSummary | undefined>(ctx, "lro.get", [{ op_id: opId }]);
    const status = summary?.status ?? "unknown";
    lastStatus = status;
    lastError = summary?.error;

    if (TERMINAL_LRO_STATUSES.has(status)) {
      return { op_id: opId, status, error: summary?.error ?? null };
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
  ctx: CommandContext,
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
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const rows = await queryProjects({
      ctx,
      project_id: projectId,
      limit: 1,
    });
    if (rows[0]?.host_id === hostId) {
      return true;
    }
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
  const workspace = await resolveWorkspace(ctx, workspaceIdentifier);
  const host = hostIdentifier
    ? await resolveHost(ctx, hostIdentifier)
    : workspace.host_id
      ? await resolveHost(ctx, workspace.host_id)
      : null;
  if (!host) {
    throw new Error("workspace has no assigned host; specify --host or start/move the workspace first");
  }

  const connection = await hubCallAccount<HostConnectionInfo>(ctx, "hosts.resolveHostConnection", [
    { host_id: host.id },
  ]);

  let base = connection.connect_url ? normalizeUrl(connection.connect_url) : "";
  if (!base && connection.local_proxy) {
    base = ctx.apiBaseUrl;
  }
  if (!base) {
    const machine = host.machine as Record<string, any> | undefined;
    const publicIp = host.public_ip ?? machine?.metadata?.public_ip;
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
  .option("--account_id <uuid>", "alias for --account-id")
  .option("--api <url>", "hub base URL")
  .option("--timeout <duration>", "wait timeout (default: 600s)", "600s")
  .option("--poll-ms <duration>", "poll interval (default: 1s)", "1s")
  .option("--api-key <key>", "account api key (also read from COCALC_API_KEY)")
  .option("--cookie <cookie>", "raw Cookie header value")
  .option("--bearer <token>", "bearer token for conat authorization")
  .option("--hub-password <password-or-file>", "hub system password for local dev")
  .showHelpAfterError();

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
  .command("create [name]")
  .description("create a workspace")
  .option("--host <host>", "host id or name")
  .action(async (name: string | undefined, opts: { host?: string }, command: Command) => {
    await withContext(command, "workspace create", async (ctx) => {
      const host = opts.host ? await resolveHost(ctx, opts.host) : null;
      const workspaceId = await hubCallAccount<string>(ctx, "projects.createProject", [
        {
          title: name ?? "New Workspace",
          host_id: host?.id,
          start: false,
        },
      ]);
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
      const ws = await resolveWorkspace(ctx, workspaceIdentifier);
      const op = await hubCallAccount<{ op_id: string }>(ctx, "projects.start", [
        {
          project_id: ws.project_id,
          wait: false,
        },
      ]);

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
        const ws = await resolveWorkspace(ctx, workspaceIdentifier);
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

        const projectApi = projectApiClient({
          project_id: ws.project_id,
          client: ctx.remote.client,
          timeout: ctx.timeoutMs,
        });
        const result = await projectApi.system.exec(execOpts as any);

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
        const ws = await resolveWorkspace(ctx, workspaceIdentifier);
        if (!ws.host_id) {
          throw new Error("workspace has no assigned host");
        }

        const connection = await hubCallAccount<HostConnectionInfo>(ctx, "hosts.resolveHostConnection", [
          { host_id: ws.host_id },
        ]);

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
        const ws = await resolveWorkspace(ctx, workspaceIdentifier);
        const host = await resolveHost(ctx, opts.host);
        const op = await hubCallAccount<{ op_id: string }>(ctx, "projects.moveProject", [
          {
            project_id: ws.project_id,
            dest_host_id: host.id,
          },
        ]);

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
        const op = await hubCallAccount<{ op_id: string }>(ctx, "projects.copyPathBetweenProjects", [
          {
            src: { project_id: srcWs.project_id, path: opts.src },
            dest: { project_id: destWs.project_id, path: opts.dest },
          },
        ]);

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

const snapshot = workspace.command("snapshot").description("workspace snapshots");

snapshot
  .command("create <workspace>")
  .description("create a btrfs snapshot")
  .option("--name <name>", "snapshot name")
  .action(async (workspaceIdentifier: string, opts: { name?: string }, command: Command) => {
    await withContext(command, "workspace snapshot create", async (ctx) => {
      const ws = await resolveWorkspace(ctx, workspaceIdentifier);
      await hubCallAccount<void>(ctx, "projects.createSnapshot", [
        {
          project_id: ws.project_id,
          name: opts.name,
        },
      ]);
      return {
        workspace_id: ws.project_id,
        snapshot_name: opts.name ?? "(auto)",
        status: "created",
      };
    });
  });

snapshot
  .command("list <workspace>")
  .description("list snapshot usage")
  .action(async (workspaceIdentifier: string, command: Command) => {
    await withContext(command, "workspace snapshot list", async (ctx) => {
      const ws = await resolveWorkspace(ctx, workspaceIdentifier);
      const snapshots = await hubCallAccount<SnapshotUsage[]>(ctx, "projects.allSnapshotUsage", [
        {
          project_id: ws.project_id,
        },
      ]);
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
        if (expectMode === "denied" && !(response.status >= 400 && response.status < 500)) {
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
      const h = await resolveHost(ctx, hostIdentifier);
      return await hubCallAccount<HostConnectionInfo>(ctx, "hosts.resolveHostConnection", [
        { host_id: h.id },
      ]);
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
        const h = await resolveHost(ctx, opts.host);
        const ws = opts.workspace ? await resolveWorkspace(ctx, opts.workspace) : null;
        const ttl = opts.ttl ? Number(opts.ttl) : undefined;
        const token = await hubCallAccount<{ host_id: string; token: string; expires_at: number }>(
          ctx,
          "hosts.issueProjectHostAuthToken",
          [
            {
              host_id: h.id,
              project_id: ws?.project_id,
              ttl_seconds: ttl,
            },
          ],
        );
        return {
          host_id: token.host_id,
          workspace_id: ws?.project_id ?? null,
          token: token.token,
          expires_at: token.expires_at,
        };
      });
    },
  );

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    emitError(
      { globals: globalsFrom(program as unknown as Command) },
      "cocalc",
      error,
    );
    process.exitCode = 1;
  } finally {
    // Conat/socket transports can keep handles open in short-lived CLI use.
    // Force termination so commands behave like normal Unix CLIs.
    process.exit(process.exitCode ?? 0);
  }
}

void main();
