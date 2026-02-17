#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirLocal, readFile as readFileLocal, writeFile as writeFileLocal } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { AsciiTable3 } from "ascii-table3";
import { Command } from "commander";

import pkg from "../../package.json";

import { connect as connectConat, type Client as ConatClient } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import callHub from "@cocalc/conat/hub/call-hub";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import type { LroScopeType, LroSummary as HubLroSummary } from "@cocalc/conat/hub/api/lro";
import type { SnapshotUsage } from "@cocalc/conat/files/file-server";
import { fsClient, fsSubject, type FilesystemClient } from "@cocalc/conat/files/fs";
import { FALLBACK_ACCOUNT_UUID, basePathCookieName, isValidUUID } from "@cocalc/util/misc";
import {
  applyAuthProfile,
  authConfigPath,
  loadAuthConfig,
  sanitizeProfileName,
  saveAuthConfig,
  selectedProfileName,
  type AuthProfile,
  type GlobalAuthOptions,
} from "../core/auth-config";
import {
  durationToMs,
  extractCookie,
  isRedirect,
  normalizeUrl,
  parseSshServer,
} from "../core/utils";

const cliVerboseFlag = process.argv.includes("--verbose");
const cliDebugEnabled =
  cliVerboseFlag ||
  process.env.COCALC_CLI_DEBUG === "1" ||
  process.env.COCALC_CLI_DEBUG === "true";

// conat/core/client may emit this warning via console.log on auth failures.
// Keep it off stdout so table/json output remains parseable.
const origLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const first = args[0];
  if (typeof first === "string" && first.startsWith("WARNING: inbox not available --")) {
    if (cliDebugEnabled) {
      console.error(...args);
    }
    return;
  }
  origLog(...args);
};

if (!cliDebugEnabled) {
  // Keep CLI stdout/stderr clean (especially with --json) even if DEBUG is globally enabled.
  process.env.SMC_TEST ??= "1";
  process.env.DEBUG_CONSOLE ??= "no";
  process.env.DEBUG_FILE ??= "";
} else {
  // Enable module-level debug logging to stderr when verbose mode is requested.
  process.env.DEBUG ??= "cocalc:*";
  process.env.DEBUG_CONSOLE ??= "yes";
  process.env.DEBUG_FILE ??= "";
}

type GlobalOptions = GlobalAuthOptions & {
  json?: boolean;
  output?: "table" | "json" | "yaml";
  quiet?: boolean;
  verbose?: boolean;
  timeout?: string;
  pollMs?: string;
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
  status?: string | null;
  region?: string | null;
  size?: string | null;
  gpu?: boolean;
  scope?: string | null;
  last_seen?: string | null;
  public_ip?: string | null;
  machine?: Record<string, any> | null;
};

type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  timedOut?: boolean;
};

type LroStatusSummary = {
  op_id: string;
  status: string;
  error?: string | null;
};

const TERMINAL_LRO_STATUSES = new Set(["succeeded", "failed", "canceled", "expired"]);
const LRO_SCOPE_TYPES: LroScopeType[] = ["project", "account", "host", "hub"];
const MAX_TRANSPORT_TIMEOUT_MS = 30_000;
const WORKSPACE_CONTEXT_FILENAME = ".cocalc-workspace";

function cliDebug(...args: unknown[]): void {
  if (!cliDebugEnabled) return;
  console.error("[cocalc:cli]", ...args);
}

function parseLroScopeType(value: string): LroScopeType {
  const normalized = value.trim().toLowerCase();
  if (LRO_SCOPE_TYPES.includes(normalized as LroScopeType)) {
    return normalized as LroScopeType;
  }
  throw new Error(
    `invalid --scope-type '${value}'; expected one of: ${LRO_SCOPE_TYPES.join(", ")}`,
  );
}

type WorkspaceContextRecord = {
  workspace_id: string;
  title?: string;
  set_at?: string;
};

function workspaceContextPath(): string {
  return join(process.cwd(), WORKSPACE_CONTEXT_FILENAME);
}

function saveWorkspaceContext(context: WorkspaceContextRecord): void {
  writeFileSync(
    workspaceContextPath(),
    `${JSON.stringify({ ...context, set_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function readWorkspaceContext(): WorkspaceContextRecord | undefined {
  const path = workspaceContextPath();
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return undefined;

  if (isValidUUID(raw)) {
    return { workspace_id: raw };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `invalid workspace context file at ${path}: ${
        err instanceof Error ? err.message : `${err}`
      }`,
    );
  }
  const workspace_id = parsed?.workspace_id;
  if (typeof workspace_id !== "string" || !isValidUUID(workspace_id)) {
    throw new Error(
      `invalid workspace context file at ${path}: expected JSON with workspace_id UUID`,
    );
  }
  return {
    workspace_id,
    title: typeof parsed?.title === "string" ? parsed.title : undefined,
    set_at: typeof parsed?.set_at === "string" ? parsed.set_at : undefined,
  };
}

function clearWorkspaceContext(): boolean {
  const path = workspaceContextPath();
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

type ProductCommand = "plus" | "launchpad";

type ProductSpec = {
  command: ProductCommand;
  binary: string;
  installUrl: string;
};

const PRODUCT_SPECS: Record<ProductCommand, ProductSpec> = {
  plus: {
    command: "plus",
    binary: "cocalc-plus",
    installUrl:
      process.env.COCALC_PLUS_INSTALL_URL ??
      "https://software.cocalc.ai/software/cocalc-plus/install.sh",
  },
  launchpad: {
    command: "launchpad",
    binary: "cocalc-launchpad",
    installUrl:
      process.env.COCALC_LAUNCHPAD_INSTALL_URL ??
      "https://software.cocalc.ai/software/cocalc-launchpad/install.sh",
  },
};

function defaultApiBaseUrl(): string {
  const raw =
    process.env.COCALC_API_URL ??
    process.env.BASE_URL ??
    `http://127.0.0.1:${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`;
  return normalizeUrl(raw);
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

function asUtf8(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

function printKeyValueTable(data: Record<string, unknown>): void {
  const table = new AsciiTable3("Result");
  table.setStyle("unicode-round");
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
  table.setStyle("unicode-round");
  table.setHeading(...cols);
  for (const row of rows) {
    table.addRow(...cols.map((col) => formatValue(row[col])));
  }
  console.log(table.toString());
}

function emitSuccess(
  ctx: { globals: GlobalOptions; apiBaseUrl?: string; accountId?: string },
  commandName: string,
  data: unknown,
): void {
  if (ctx.globals.json || ctx.globals.output === "json") {
    const payload = {
      ok: true,
      command: commandName,
      data,
      meta: {
        api: ctx.apiBaseUrl ?? null,
        account_id: ctx.accountId ?? null,
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (ctx.globals.quiet) {
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

function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function normalizeOptionalSecret(value: string | undefined): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function profileFromGlobals(globals: GlobalOptions): Partial<AuthProfile> {
  const profile: Partial<AuthProfile> = {};
  if (globals.api?.trim()) {
    profile.api = normalizeUrl(globals.api);
  }
  const accountId = getExplicitAccountId(globals);
  if (accountId?.trim()) {
    if (!isValidUUID(accountId)) {
      throw new Error(`invalid --account-id '${accountId}'`);
    }
    profile.account_id = accountId;
  }
  const apiKey = normalizeOptionalSecret(globals.apiKey);
  if (apiKey) profile.api_key = apiKey;
  const cookie = normalizeOptionalSecret(globals.cookie);
  if (cookie) profile.cookie = cookie;
  const bearer = normalizeOptionalSecret(globals.bearer);
  if (bearer) profile.bearer = bearer;
  const hubPassword = normalizeSecretValue(globals.hubPassword);
  if (hubPassword) profile.hub_password = hubPassword;
  return profile;
}

async function runLocalCommand(
  command: unknown,
  commandName: string,
  fn: (globals: GlobalOptions) => Promise<unknown>,
): Promise<void> {
  const globals = globalsFrom(command);
  try {
    const data = await fn(globals);
    emitSuccess({ globals }, commandName, data);
  } catch (error) {
    emitError({ globals }, commandName, error);
    process.exitCode = 1;
  }
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
  const signInTimeoutMs = Math.min(timeoutMs, MAX_TRANSPORT_TIMEOUT_MS);
  const extraHeaders: Record<string, string> = {};
  const cookie = buildCookieHeader(apiBaseUrl, globals);
  if (cookie) {
    extraHeaders.Cookie = cookie;
  }
  const bearer = globals.bearer ?? process.env.COCALC_BEARER_TOKEN;
  if (bearer?.trim()) {
    extraHeaders.Authorization = `Bearer ${bearer.trim()}`;
  }
  cliDebug("connectRemote", {
    apiBaseUrl,
    timeoutMs,
    signInTimeoutMs,
    hasCookie: !!cookie,
    hasBearer: !!bearer?.trim(),
    hasApiKey: !!(globals.apiKey ?? process.env.COCALC_API_KEY),
    hasHubPassword: hasHubPassword(globals),
  });

  const client = connectConat({
    address: apiBaseUrl,
    noCache: true,
    ...(Object.keys(extraHeaders).length ? { extraHeaders } : undefined),
  });
  // Ensure request/reply inbox subscriptions use the authenticated identity prefix
  // (_INBOX.account-..., _INBOX.project-..., etc.), which matches server policy.
  client.inboxPrefixHook = (info) => {
    const user = info?.user as
      | {
          account_id?: string;
          project_id?: string;
          hub_id?: string;
          host_id?: string;
        }
      | undefined;
    if (!user) return undefined;
    return inboxPrefix({
      account_id: user.account_id,
      project_id: user.project_id,
      hub_id: user.hub_id,
      host_id: user.host_id,
    });
  };

  try {
    await withTimeout(
      client.waitUntilSignedIn({ timeout: signInTimeoutMs }),
      signInTimeoutMs,
      `timeout while waiting for conat sign-in (${signInTimeoutMs}ms)`,
    );
  } catch (err) {
    try {
      client.close();
    } catch {
      // ignore
    }
    throw err;
  }

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
  const config = loadAuthConfig();
  const applied = applyAuthProfile(globals, config);
  const effectiveGlobals = applied.globals as GlobalOptions;

  const timeoutMs = durationToMs(effectiveGlobals.timeout, 600_000);
  const pollMs = durationToMs(effectiveGlobals.pollMs, 1_000);
  const apiBaseUrl = effectiveGlobals.api ? normalizeUrl(effectiveGlobals.api) : defaultApiBaseUrl();
  const remote = await connectRemote({ globals: effectiveGlobals, apiBaseUrl, timeoutMs });

  let accountId =
    getExplicitAccountId(effectiveGlobals) ??
    process.env.COCALC_ACCOUNT_ID ??
    resolveAccountIdFromRemote(remote);

  if (!accountId && hasHubPassword(effectiveGlobals)) {
    accountId = await resolveDefaultAdminAccountId({ remote, timeoutMs });
  }

  if (!accountId || !isValidUUID(accountId)) {
    throw new Error(
      "unable to determine account_id; pass --account-id or authenticate with an account api key/cookie",
    );
  }

  return {
    globals: effectiveGlobals,
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!(timeoutMs > 0)) {
    return await promise;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function hubCallAccount<T>(
  ctx: CommandContext,
  name: string,
  args: any[] = [],
  timeout?: number,
): Promise<T> {
  const timeoutMs = timeout ?? ctx.timeoutMs;
  const rpcTimeoutMs = Math.min(timeoutMs, MAX_TRANSPORT_TIMEOUT_MS);
  cliDebug("hubCallAccount", {
    name,
    timeoutMs,
    rpcTimeoutMs,
    account_id: ctx.accountId,
  });
  return (await withTimeout(
    callHub({
      client: ctx.remote.client,
      account_id: ctx.accountId,
      name,
      args,
      timeout: rpcTimeoutMs,
    }),
    rpcTimeoutMs,
    `timeout waiting for hub response: ${name} (${rpcTimeoutMs}ms)`,
  )) as T;
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

function serializeLroSummary(summary: HubLroSummary): Record<string, unknown> {
  return {
    op_id: summary.op_id,
    kind: summary.kind,
    scope_type: summary.scope_type,
    scope_id: summary.scope_id,
    status: summary.status,
    error: summary.error ?? null,
    created_by: summary.created_by ?? null,
    owner_type: summary.owner_type ?? null,
    owner_id: summary.owner_id ?? null,
    attempt: summary.attempt,
    progress_summary: summary.progress_summary ?? null,
    result: summary.result ?? null,
    input: summary.input ?? null,
    created_at: toIso(summary.created_at),
    started_at: toIso(summary.started_at),
    finished_at: toIso(summary.finished_at),
    updated_at: toIso(summary.updated_at),
    expires_at: toIso(summary.expires_at),
    dismissed_at: toIso(summary.dismissed_at),
    dismissed_by: summary.dismissed_by ?? null,
  };
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

async function resolveWorkspaceFromArgOrContext(
  ctx: CommandContext,
  identifier?: string,
): Promise<WorkspaceRow> {
  const value = identifier?.trim();
  if (value) {
    return await resolveWorkspace(ctx, value);
  }
  const context = readWorkspaceContext();
  if (!context?.workspace_id) {
    throw new Error(
      `missing --workspace and no workspace context is set at ${workspaceContextPath()}; run 'cocalc ws use --workspace <workspace>'`,
    );
  }
  return await resolveWorkspace(ctx, context.workspace_id);
}

async function resolveWorkspaceFilesystem(
  ctx: CommandContext,
  workspaceIdentifier?: string,
): Promise<{ workspace: WorkspaceRow; fs: FilesystemClient }> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier);
  const fs = fsClient({
    client: ctx.remote.client,
    subject: fsSubject({ project_id: workspace.project_id }),
    timeout: Math.max(30_000, Math.min(ctx.timeoutMs, 30 * 60_000)),
  });
  return { workspace, fs };
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

async function listHosts(
  ctx: CommandContext,
  opts: { include_deleted?: boolean; catalog?: boolean; admin_view?: boolean } = {},
): Promise<HostRow[]> {
  const hosts = await hubCallAccount<HostRow[]>(ctx, "hosts.listHosts", [
    {
      include_deleted: !!opts.include_deleted,
      catalog: !!opts.catalog,
      admin_view: !!opts.admin_view,
    },
  ]);
  if (!Array.isArray(hosts)) return [];
  return hosts;
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
    const summary = await hubCallAccount<LroStatusSummary | undefined>(ctx, "lro.get", [{ op_id: opId }]);
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

async function waitForWorkspaceNotRunning(
  ctx: CommandContext,
  projectId: string,
  {
    timeoutMs,
    pollMs,
  }: {
    timeoutMs: number;
    pollMs: number;
  },
): Promise<{ ok: boolean; state: string }> {
  const started = Date.now();
  let lastState = "";
  while (Date.now() - started <= timeoutMs) {
    const rows = await queryProjects({
      ctx,
      project_id: projectId,
      limit: 1,
    });
    const state = workspaceState(rows[0]?.state);
    lastState = state;
    if (state !== "running") {
      return { ok: true, state };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, state: lastState };
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

async function runCommand(
  command: string,
  args: string[],
  {
    env,
  }: {
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    timeout: 3000,
  });
  if (!result.error) {
    return true;
  }
  const message = (result.error as Error).message ?? "";
  return !message.toLowerCase().includes("enoent");
}

async function shouldInstallProduct(spec: ProductSpec): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `'${spec.binary}' is not installed. Install now from ${spec.installUrl}? [Y/n] `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensureProductInstalled(spec: ProductSpec): Promise<void> {
  if (commandExists(spec.binary)) {
    return;
  }

  const approved = await shouldInstallProduct(spec);
  if (!approved) {
    throw new Error(
      `'${spec.binary}' is required for 'cocalc ${spec.command}'. Install with: curl -fsSL ${spec.installUrl} | bash`,
    );
  }

  console.error(`Installing ${spec.binary} ...`);
  const code = await runCommand("bash", ["-lc", `curl -fsSL ${spec.installUrl} | bash`]);
  if (code !== 0) {
    throw new Error(`failed installing '${spec.binary}' (exit ${code})`);
  }
  if (!commandExists(spec.binary)) {
    throw new Error(`installation completed but '${spec.binary}' is still not available in PATH`);
  }
}

async function runProductCommand(spec: ProductSpec, args: string[]): Promise<void> {
  await ensureProductInstalled(spec);
  const code = await runCommand(spec.binary, args);
  if (code !== 0) {
    process.exitCode = code;
  }
}

async function runSshCheck(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stderr: string; timed_out: boolean }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let done = false;
    const finish = (result: { code: number; stderr: string; timed_out: boolean }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.on("data", (chunk) => {
      if (stderr.length >= 8192) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stderr += text;
    });

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("exit", (code) => {
      finish({ code: code ?? 1, stderr, timed_out: false });
    });

    const timer = setTimeout(() => {
      if (done) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish({ code: 124, stderr, timed_out: true });
    }, timeoutMs);
  });
}

function isLikelySshAuthFailure(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("permission denied") ||
    text.includes("authentication failed") ||
    text.includes("no supported authentication methods") ||
    text.includes("publickey")
  );
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
  .option("-q, --quiet", "suppress human-formatted success output")
  .option("--verbose", "enable verbose debug logging to stderr")
  .option("--profile <name>", "auth profile name (default: current profile)")
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

for (const spec of Object.values(PRODUCT_SPECS)) {
  program
    .command(`${spec.command} [args...]`)
    .description(`run ${spec.binary} (installs it if missing)`)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (args: string[] | undefined, command: Command) => {
      try {
        await runProductCommand(spec, args ?? []);
      } catch (error) {
        emitError(
          { globals: globalsFrom(command) },
          `cocalc ${spec.command}`,
          error,
        );
        process.exitCode = 1;
      }
    });
}

const auth = program.command("auth").description("auth profile management");

auth
  .command("status")
  .description("show effective auth/profile status")
  .option("--check", "verify credentials by connecting to the configured hub")
  .action(async (opts: { check?: boolean }, command: Command) => {
    await runLocalCommand(command, "auth status", async (globals) => {
      const configPath = authConfigPath();
      const config = loadAuthConfig(configPath);
      const selected = selectedProfileName(globals, config);
      const profile = config.profiles[selected];
      const applied = applyAuthProfile(globals, config);
      const effective = applied.globals as GlobalOptions;
      const accountId = getExplicitAccountId(effective) ?? process.env.COCALC_ACCOUNT_ID ?? null;
      const apiBaseUrl = effective.api ? normalizeUrl(effective.api) : defaultApiBaseUrl();

      let check: { ok: boolean; account_id?: string | null; error?: string } | undefined;
      if (opts.check) {
        try {
          const timeoutMs = durationToMs(effective.timeout, 15_000);
          const remote = await connectRemote({ globals: effective, apiBaseUrl, timeoutMs });
          check = {
            ok: true,
            account_id: resolveAccountIdFromRemote(remote) ?? null,
          };
          remote.client.close();
        } catch (err) {
          check = {
            ok: false,
            error: err instanceof Error ? err.message : `${err}`,
          };
        }
      }

      return {
        config_path: configPath,
        current_profile: config.current_profile ?? null,
        selected_profile: selected,
        profile_found: !!profile,
        using_profile_defaults: applied.fromProfile,
        profiles_count: Object.keys(config.profiles).length,
        api: apiBaseUrl,
        account_id: accountId,
        has_api_key: !!(effective.apiKey ?? process.env.COCALC_API_KEY),
        has_cookie: !!effective.cookie,
        has_bearer: !!(effective.bearer ?? process.env.COCALC_BEARER_TOKEN),
        has_hub_password: !!normalizeSecretValue(
          effective.hubPassword ?? process.env.COCALC_HUB_PASSWORD,
        ),
        check: check ?? null,
      };
    });
  });

auth
  .command("list")
  .description("list auth profiles")
  .action(async (command: Command) => {
    await runLocalCommand(command, "auth list", async () => {
      const config = loadAuthConfig();
      return Object.entries(config.profiles)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, profile]) => ({
          profile: name,
          current: config.current_profile === name,
          api: profile.api ?? null,
          account_id: profile.account_id ?? null,
          api_key: maskSecret(profile.api_key),
          cookie: maskSecret(profile.cookie),
          bearer: maskSecret(profile.bearer),
          hub_password: maskSecret(profile.hub_password),
        }));
    });
  });

async function saveAuthProfile(
  globals: GlobalOptions,
  opts: { setCurrent?: boolean },
): Promise<{
  profile: string;
  current_profile: string | null;
  stored: Record<string, unknown>;
}> {
  const configPath = authConfigPath();
  const config = loadAuthConfig(configPath);
  const profileName = sanitizeProfileName(globals.profile);
  const patch = profileFromGlobals(globals);
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "nothing to store; provide one of --api, --account-id, --api-key, --cookie, --bearer, --hub-password",
    );
  }
  const current = config.profiles[profileName] ?? {};
  const next: AuthProfile = { ...current, ...patch };
  config.profiles[profileName] = next;
  if (opts.setCurrent !== false) {
    config.current_profile = profileName;
  }
  saveAuthConfig(config, configPath);
  return {
    profile: profileName,
    current_profile: config.current_profile ?? null,
    stored: {
      api: next.api ?? null,
      account_id: next.account_id ?? null,
      api_key: maskSecret(next.api_key),
      cookie: maskSecret(next.cookie),
      bearer: maskSecret(next.bearer),
      hub_password: maskSecret(next.hub_password),
    },
  };
}

auth
  .command("login")
  .description("store credentials in an auth profile")
  .option("--no-set-current", "do not set this profile as current")
  .action(async (opts: { setCurrent?: boolean }, command: Command) => {
    await runLocalCommand(command, "auth login", async (globals) => {
      return await saveAuthProfile(globals, opts);
    });
  });

auth
  .command("setup")
  .description("alias for auth login")
  .option("--no-set-current", "do not set this profile as current")
  .action(async (opts: { setCurrent?: boolean }, command: Command) => {
    await runLocalCommand(command, "auth setup", async (globals) => {
      return await saveAuthProfile(globals, opts);
    });
  });

auth
  .command("use <profile>")
  .description("set the current auth profile")
  .action(async (profileName: string, command: Command) => {
    await runLocalCommand(command, "auth use", async () => {
      const configPath = authConfigPath();
      const config = loadAuthConfig(configPath);
      const profile = sanitizeProfileName(profileName);
      if (!config.profiles[profile]) {
        throw new Error(`auth profile '${profile}' not found`);
      }
      config.current_profile = profile;
      saveAuthConfig(config, configPath);
      return {
        current_profile: profile,
      };
    });
  });

auth
  .command("logout")
  .description("remove stored auth profile(s)")
  .option("--all", "remove all auth profiles")
  .option("--target-profile <name>", "profile to remove (defaults to selected/current)")
  .action(async (opts: { all?: boolean; targetProfile?: string }, command: Command) => {
    await runLocalCommand(command, "auth logout", async (globals) => {
      const configPath = authConfigPath();
      const config = loadAuthConfig(configPath);

      if (opts.all) {
        config.profiles = {};
        config.current_profile = undefined;
        saveAuthConfig(config, configPath);
        return {
          removed: "all",
          current_profile: null,
          remaining_profiles: 0,
        };
      }

      const target = sanitizeProfileName(
        opts.targetProfile ?? globals.profile ?? config.current_profile,
      );
      if (!config.profiles[target]) {
        throw new Error(`auth profile '${target}' not found`);
      }
      delete config.profiles[target];
      if (config.current_profile === target) {
        const next = Object.keys(config.profiles).sort()[0];
        config.current_profile = next;
      }
      saveAuthConfig(config, configPath);
      return {
        removed: target,
        current_profile: config.current_profile ?? null,
        remaining_profiles: Object.keys(config.profiles).length,
      };
    });
  });

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
      await hubCallAccount(ctx, "db.userQuery", [
        {
          query: {
            projects: [{ project_id: ws.project_id, title: nextTitle }],
          },
          options: [],
        },
      ]);
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
  .description("soft-delete a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace delete", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await hubCallAccount(ctx, "db.userQuery", [
        {
          query: {
            projects: [{ project_id: ws.project_id, deleted: true }],
          },
          options: [],
        },
      ]);
      return {
        workspace_id: ws.project_id,
        status: "deleted",
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
  .command("stop")
  .description("stop a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--wait", "wait until the workspace is not running")
  .action(async (opts: { workspace?: string; wait?: boolean }, command: Command) => {
    await withContext(command, "workspace stop", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
      await hubCallAccount<void>(ctx, "projects.stop", [
        {
          project_id: ws.project_id,
        },
      ]);

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
      await hubCallAccount<void>(ctx, "projects.stop", [
        {
          project_id: ws.project_id,
        },
      ]);

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

        const result = await hubCallAccount<{
          stdout?: string;
          stderr?: string;
          exit_code?: number;
        }>(ctx, "projects.exec", [
          {
            project_id: ws.project_id,
            execOpts,
          },
        ]);

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
  .description("print or open an ssh connection to a workspace (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .option("--connect", "open ssh instead of printing the target")
  .option("--check", "verify ssh connectivity/authentication non-interactively")
  .option("--require-auth", "with --check, require successful auth (not just reachable ssh endpoint)")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(
    async (
      sshArgs: string[],
      opts: { workspace?: string; connect?: boolean; check?: boolean; requireAuth?: boolean },
      command: Command,
    ) => {
      await withContext(command, "workspace ssh", async (ctx) => {
        const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
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
        if (opts.connect && opts.check) {
          throw new Error("use either --connect or --check, not both");
        }

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
                workspace_id: ws.project_id,
                ssh_server: connection.ssh_server,
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
            workspace_id: ws.project_id,
            ssh_server: connection.ssh_server,
            checked: true,
            command: commandLine,
            auth_ok: true,
            exit_code: 0,
          };
        }

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
      await withContext(command, "workspace file list", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const targetPath = path?.trim() || ".";
        const listing = await fs.getListing(targetPath);
        const files = listing?.files ?? {};
        const names = Object.keys(files).sort((a, b) => a.localeCompare(b));
        return names.map((name) => {
          const info: any = files[name] ?? {};
          return {
            workspace_id: workspace.project_id,
            path: targetPath,
            name,
            is_dir: !!info.isDir,
            size: info.size ?? null,
            mtime: info.mtime ?? null,
          };
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
      await withContext(command, "workspace file cat", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const content = String(await fs.readFile(path, "utf8"));
        if (!ctx.globals.json && ctx.globals.output !== "json") {
          process.stdout.write(content);
          if (!content.endsWith("\n")) {
            process.stdout.write("\n");
          }
          return null;
        }
        return {
          workspace_id: workspace.project_id,
          path,
          content,
          bytes: Buffer.byteLength(content),
        };
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
      await withContext(command, "workspace file put", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const data = await readFileLocal(src);
        if (opts.parents !== false) {
          await fs.mkdir(dirname(dest), { recursive: true });
        }
        await fs.writeFile(dest, data);
        return {
          workspace_id: workspace.project_id,
          src,
          dest,
          bytes: data.length,
          status: "uploaded",
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
      await withContext(command, "workspace file get", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const data = await fs.readFile(src);
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        if (opts.parents !== false) {
          await mkdirLocal(dirname(dest), { recursive: true });
        }
        await writeFileLocal(dest, buffer);
        return {
          workspace_id: workspace.project_id,
          src,
          dest,
          bytes: buffer.length,
          status: "downloaded",
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
      await withContext(command, "workspace file rm", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        await fs.rm(path, {
          recursive: !!opts.recursive,
          force: !!opts.force,
        });
        return {
          workspace_id: workspace.project_id,
          path,
          recursive: !!opts.recursive,
          force: !!opts.force,
          status: "removed",
        };
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
      await withContext(command, "workspace file mkdir", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        await fs.mkdir(path, { recursive: opts.parents !== false });
        return {
          workspace_id: workspace.project_id,
          path,
          parents: opts.parents !== false,
          status: "created",
        };
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
      await withContext(command, "workspace file rg", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const result = await fs.ripgrep(path?.trim() || ".", pattern, {
          options: opts.rgOption,
          timeout: Math.max(1, Number(opts.timeout ?? "30") || 30),
          maxSize: Math.max(1024, Number(opts.maxBytes ?? "20000000") || 20000000),
        });
        const stdout = asUtf8((result as any)?.stdout);
        const stderr = asUtf8((result as any)?.stderr);
        const exit_code = Number((result as any)?.code ?? 1);

        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (exit_code !== 0) {
            process.exitCode = exit_code;
          }
          return null;
        }
        return {
          workspace_id: workspace.project_id,
          path: path?.trim() || ".",
          pattern,
          stdout,
          stderr,
          exit_code,
          truncated: !!(result as any)?.truncated,
        };
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
      await withContext(command, "workspace file fd", async (ctx) => {
        const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, opts.workspace);
        const result = await fs.fd(path?.trim() || ".", {
          pattern: pattern?.trim() || undefined,
          options: opts.fdOption,
          timeout: Math.max(1, Number(opts.timeout ?? "30") || 30),
          maxSize: Math.max(1024, Number(opts.maxBytes ?? "20000000") || 20000000),
        });
        const stdout = asUtf8((result as any)?.stdout);
        const stderr = asUtf8((result as any)?.stderr);
        const exit_code = Number((result as any)?.code ?? 1);

        if (!ctx.globals.json && ctx.globals.output !== "json") {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (exit_code !== 0) {
            process.exitCode = exit_code;
          }
          return null;
        }
        return {
          workspace_id: workspace.project_id,
          path: path?.trim() || ".",
          pattern: pattern?.trim() || null,
          stdout,
          stderr,
          exit_code,
          truncated: !!(result as any)?.truncated,
        };
      });
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
      const op = await hubCallAccount<{ op_id: string }>(ctx, "projects.createBackup", [
        {
          project_id: ws.project_id,
        },
      ]);
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
        const backups = await hubCallAccount<
          Array<{ id: string; time: string | Date; summary?: Record<string, any> }>
        >(ctx, "projects.getBackups", [
          {
            project_id: ws.project_id,
            indexed_only: !!opts.indexedOnly,
          },
        ]);
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
        const files = await hubCallAccount<
          Array<{ name: string; isDir: boolean; mtime: number; size: number }>
        >(ctx, "projects.getBackupFiles", [
          {
            project_id: ws.project_id,
            id: opts.backupId,
            path: opts.path,
          },
        ]);
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
        const op = await hubCallAccount<{ op_id: string }>(ctx, "projects.restoreBackup", [
          {
            project_id: ws.project_id,
            id: opts.backupId,
            path: opts.path,
            dest: opts.dest,
          },
        ]);
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
  .command("list")
  .description("list snapshot usage (defaults to context)")
  .option("-w, --workspace <workspace>", "workspace id or name")
  .action(async (opts: { workspace?: string }, command: Command) => {
    await withContext(command, "workspace snapshot list", async (ctx) => {
      const ws = await resolveWorkspaceFromArgOrContext(ctx, opts.workspace);
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

const op = program.command("op").description("long-running operation management");

op
  .command("list")
  .description("list operations for a scope")
  .option("--scope-type <type>", "scope type: project|account|host|hub")
  .option("--scope-id <id>", "scope id")
  .option("--workspace <workspace>", "workspace id or name")
  .option("--host <host>", "host id or name")
  .option("--include-completed", "include completed operations")
  .option("--limit <n>", "max rows", "100")
  .action(
    async (
      opts: {
        scopeType?: string;
        scopeId?: string;
        workspace?: string;
        host?: string;
        includeCompleted?: boolean;
        limit?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "op list", async (ctx) => {
        const haveExplicitScope = !!opts.scopeType || !!opts.scopeId;
        const haveWorkspace = !!opts.workspace;
        const haveHost = !!opts.host;
        const scopeModes = Number(haveExplicitScope) + Number(haveWorkspace) + Number(haveHost);
        if (scopeModes > 1) {
          throw new Error(
            "use only one scope selector: (--scope-type + --scope-id) OR --workspace OR --host",
          );
        }

        let scope_type: LroScopeType;
        let scope_id: string;

        if (haveWorkspace) {
          const ws = await resolveWorkspace(ctx, opts.workspace!);
          scope_type = "project";
          scope_id = ws.project_id;
        } else if (haveHost) {
          const h = await resolveHost(ctx, opts.host!);
          scope_type = "host";
          scope_id = h.id;
        } else if (haveExplicitScope) {
          if (!opts.scopeType || !opts.scopeId) {
            throw new Error("--scope-type and --scope-id must be used together");
          }
          scope_type = parseLroScopeType(opts.scopeType);
          scope_id = opts.scopeId;
        } else {
          scope_type = "account";
          scope_id = ctx.accountId;
        }

        const rows = await hubCallAccount<HubLroSummary[]>(ctx, "lro.list", [
          {
            scope_type,
            scope_id,
            include_completed: !!opts.includeCompleted,
          },
        ]);
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "100") || 100));
        return (rows ?? [])
          .slice(0, limitNum)
          .map((summary) => serializeLroSummary(summary));
      });
    },
  );

op
  .command("get <op-id>")
  .description("get one operation by id")
  .action(async (opId: string, command: Command) => {
    await withContext(command, "op get", async (ctx) => {
      const summary = await hubCallAccount<HubLroSummary | undefined>(ctx, "lro.get", [
        { op_id: opId },
      ]);
      if (!summary) {
        throw new Error(`operation '${opId}' not found`);
      }
      return serializeLroSummary(summary);
    });
  });

op
  .command("wait <op-id>")
  .description("wait until an operation reaches a terminal state")
  .action(async (opId: string, command: Command) => {
    await withContext(command, "op wait", async (ctx) => {
      const waited = await waitForLro(ctx, opId, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (waited.timedOut) {
        throw new Error(
          `timeout waiting for operation ${opId}; last status=${waited.status}`,
        );
      }
      const summary = await hubCallAccount<HubLroSummary | undefined>(ctx, "lro.get", [
        { op_id: opId },
      ]);
      if (!summary) {
        return {
          op_id: opId,
          status: waited.status,
          error: waited.error ?? null,
        };
      }
      return serializeLroSummary(summary);
    });
  });

op
  .command("cancel <op-id>")
  .description("cancel an operation")
  .action(async (opId: string, command: Command) => {
    await withContext(command, "op cancel", async (ctx) => {
      await hubCallAccount<void>(ctx, "lro.cancel", [{ op_id: opId }]);
      const summary = await hubCallAccount<HubLroSummary | undefined>(ctx, "lro.get", [
        { op_id: opId },
      ]);
      if (!summary) {
        return {
          op_id: opId,
          status: "canceled",
        };
      }
      return serializeLroSummary(summary);
    });
  });

const account = program.command("account").description("account operations");
const accountApiKey = account.command("api-key").description("manage account API keys");

accountApiKey
  .command("list")
  .description("list account API keys")
  .action(async (command: Command) => {
    await withContext(command, "account api-key list", async (ctx) => {
      const rows = await hubCallAccount<
        Array<{
          id?: number;
          name?: string;
          trunc?: string;
          created?: string | Date | null;
          expire?: string | Date | null;
          last_active?: string | Date | null;
          project_id?: string | null;
        }>
      >(ctx, "system.manageApiKeys", [
        {
          action: "get",
        },
      ]);
      return (rows ?? []).map((row) => ({
        id: row.id,
        name: row.name ?? "",
        trunc: row.trunc ?? "",
        created: toIso(row.created),
        expire: toIso(row.expire),
        last_active: toIso(row.last_active),
        project_id: row.project_id ?? null,
      }));
    });
  });

accountApiKey
  .command("create")
  .description("create an account API key")
  .option("--name <name>", "key label", `cocalc-cli-${Date.now().toString(36)}`)
  .option("--expire-seconds <n>", "expire in n seconds")
  .action(
    async (
      opts: {
        name?: string;
        expireSeconds?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "account api-key create", async (ctx) => {
        const expireSeconds =
          opts.expireSeconds == null ? undefined : Number(opts.expireSeconds);
        if (
          expireSeconds != null &&
          (!Number.isFinite(expireSeconds) || expireSeconds <= 0)
        ) {
          throw new Error("--expire-seconds must be a positive number");
        }
        const expire = expireSeconds
          ? new Date(Date.now() + expireSeconds * 1000).toISOString()
          : undefined;
        const rows = await hubCallAccount<
          Array<{
            id?: number;
            name?: string;
            trunc?: string;
            secret?: string;
            created?: string | Date | null;
            expire?: string | Date | null;
            project_id?: string | null;
          }>
        >(ctx, "system.manageApiKeys", [
          {
            action: "create",
            name: opts.name,
            expire,
          },
        ]);
        const key = rows?.[0];
        if (!key?.id) {
          throw new Error("failed to create api key");
        }
        return {
          id: key.id,
          name: key.name ?? opts.name ?? "",
          trunc: key.trunc ?? "",
          secret: key.secret ?? null,
          created: toIso(key.created),
          expire: toIso(key.expire),
          project_id: key.project_id ?? null,
        };
      });
    },
  );

accountApiKey
  .command("delete <id>")
  .description("delete an account API key by id")
  .action(async (id: string, command: Command) => {
    await withContext(command, "account api-key delete", async (ctx) => {
      const keyId = Number(id);
      if (!Number.isInteger(keyId) || keyId <= 0) {
        throw new Error("id must be a positive integer");
      }
      await hubCallAccount<void>(ctx, "system.manageApiKeys", [
        {
          action: "delete",
          id: keyId,
        },
      ]);
      return {
        id: keyId,
        status: "deleted",
      };
    });
  });

const host = program.command("host").description("host operations");

host
  .command("list")
  .description("list hosts")
  .option("--include-deleted", "include deleted hosts")
  .option("--catalog", "include catalog-visible hosts")
  .option("--admin-view", "admin view")
  .option("--limit <n>", "max rows", "500")
  .action(
    async (
      opts: { includeDeleted?: boolean; catalog?: boolean; adminView?: boolean; limit?: string },
      command: Command,
    ) => {
      await withContext(command, "host list", async (ctx) => {
        const rows = await listHosts(ctx, {
          include_deleted: !!opts.includeDeleted,
          catalog: !!opts.catalog,
          admin_view: !!opts.adminView,
        });
        const limitNum = Math.max(1, Math.min(10000, Number(opts.limit ?? "500") || 500));
        return rows.slice(0, limitNum).map((row) => ({
          host_id: row.id,
          name: row.name,
          status: row.status ?? "",
          region: row.region ?? "",
          size: row.size ?? "",
          gpu: !!row.gpu,
          scope: row.scope ?? "",
          last_seen: row.last_seen ?? null,
          public_ip: row.public_ip ?? null,
        }));
      });
    },
  );

host
  .command("get <host>")
  .description("get one host by id or name")
  .action(async (hostIdentifier: string, command: Command) => {
    await withContext(command, "host get", async (ctx) => {
      const h = await resolveHost(ctx, hostIdentifier);
      return {
        host_id: h.id,
        name: h.name,
        status: h.status ?? "",
        region: h.region ?? "",
        size: h.size ?? "",
        gpu: !!h.gpu,
        scope: h.scope ?? "",
        last_seen: h.last_seen ?? null,
        public_ip: h.public_ip ?? null,
        machine: h.machine ?? null,
      };
    });
  });

host
  .command("create-self <name>")
  .description("create a self-host host record")
  .requiredOption("--ssh-target <target>", "ssh target, e.g. ubuntu@10.0.0.2")
  .option("--region <region>", "region label", "pending")
  .option("--size <size>", "size label", "custom")
  .option("--cpu <count>", "cpu count", "2")
  .option("--ram-gb <gb>", "ram in GB", "8")
  .option("--disk-gb <gb>", "disk in GB", "40")
  .option("--gpu", "mark host as having gpu")
  .action(
    async (
      name: string,
      opts: {
        sshTarget: string;
        region?: string;
        size?: string;
        cpu?: string;
        ramGb?: string;
        diskGb?: string;
        gpu?: boolean;
      },
      command: Command,
    ) => {
      await withContext(command, "host create-self", async (ctx) => {
        const cpu = Math.max(1, Number(opts.cpu ?? "2") || 2);
        const ram_gb = Math.max(1, Number(opts.ramGb ?? "8") || 8);
        const disk_gb = Math.max(10, Number(opts.diskGb ?? "40") || 40);
        const host = await hubCallAccount<HostRow>(ctx, "hosts.createHost", [
          {
            name,
            region: opts.region ?? "pending",
            size: opts.size ?? "custom",
            gpu: !!opts.gpu,
            machine: {
              cloud: "self-host",
              storage_mode: "persistent",
              disk_gb,
              metadata: {
                cpu,
                ram_gb,
                self_host_mode: "local",
                self_host_kind: "direct",
                self_host_ssh_target: opts.sshTarget,
              },
            },
          },
        ]);
        return {
          host_id: host.id,
          name: host.name,
          status: host.status ?? "",
          region: host.region ?? "",
          size: host.size ?? "",
          gpu: !!host.gpu,
        };
      });
    },
  );

host
  .command("start <host>")
  .description("start a host")
  .option("--wait", "wait for completion")
  .action(async (hostIdentifier: string, opts: { wait?: boolean }, command: Command) => {
    await withContext(command, "host start", async (ctx) => {
      const h = await resolveHost(ctx, hostIdentifier);
      const op = await hubCallAccount<{ op_id: string }>(ctx, "hosts.startHost", [{ id: h.id }]);
      if (!opts.wait) {
        return {
          host_id: h.id,
          op_id: op.op_id,
          status: "queued",
        };
      }
      const summary = await waitForLro(ctx, op.op_id, {
        timeoutMs: ctx.timeoutMs,
        pollMs: ctx.pollMs,
      });
      if (summary.timedOut) {
        throw new Error(`host start timed out (op=${op.op_id}, last_status=${summary.status})`);
      }
      if (summary.status !== "succeeded") {
        throw new Error(`host start failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
      }
      return {
        host_id: h.id,
        op_id: op.op_id,
        status: summary.status,
      };
    });
  });

host
  .command("delete <host>")
  .description("deprovision a host")
  .option("--skip-backups", "skip creating backups before deprovision")
  .option("--wait", "wait for completion")
  .action(
    async (
      hostIdentifier: string,
      opts: { skipBackups?: boolean; wait?: boolean },
      command: Command,
    ) => {
      await withContext(command, "host delete", async (ctx) => {
        const h = await resolveHost(ctx, hostIdentifier);
        const op = await hubCallAccount<{ op_id: string }>(ctx, "hosts.deleteHost", [
          {
            id: h.id,
            skip_backups: !!opts.skipBackups,
          },
        ]);
        if (!opts.wait) {
          return {
            host_id: h.id,
            op_id: op.op_id,
            status: "queued",
          };
        }
        const summary = await waitForLro(ctx, op.op_id, {
          timeoutMs: ctx.timeoutMs,
          pollMs: ctx.pollMs,
        });
        if (summary.timedOut) {
          throw new Error(`host delete timed out (op=${op.op_id}, last_status=${summary.status})`);
        }
        if (summary.status !== "succeeded") {
          throw new Error(`host delete failed: status=${summary.status} error=${summary.error ?? "unknown"}`);
        }
        return {
          host_id: h.id,
          op_id: op.op_id,
          status: summary.status,
        };
      });
    },
  );

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
    const shortcut = process.argv[2] as ProductCommand | undefined;
    if (shortcut && (shortcut === "plus" || shortcut === "launchpad")) {
      const spec = PRODUCT_SPECS[shortcut];
      try {
        await runProductCommand(spec, process.argv.slice(3));
      } catch (error) {
        emitError(
          { globals: globalsFrom(program as unknown as Command) },
          `cocalc ${shortcut}`,
          error,
        );
        process.exitCode = 1;
      }
      return;
    }

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
