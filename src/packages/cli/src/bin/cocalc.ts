#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirLocal, readFile as readFileLocal, writeFile as writeFileLocal } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { homedir, hostname } from "node:os";
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
import type { HubApi } from "@cocalc/conat/hub/api";
import type {
  HostCatalog,
  HostCatalogEntry,
  HostConnectionInfo,
  HostMachine,
  HostSoftwareArtifact,
  HostSoftwareChannel,
} from "@cocalc/conat/hub/api/hosts";
import type { LroScopeType, LroSummary as HubLroSummary } from "@cocalc/conat/hub/api/lro";
import type {
  ProjectCollabInviteRow,
  WorkspaceSshConnectionInfo,
} from "@cocalc/conat/hub/api/projects";
import { fsClient, fsSubject, type FilesystemClient } from "@cocalc/conat/files/fs";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
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
import {
  createHubApiForContext as createTypedHubApiForContext,
  hubCallByName as hubCallByNameCore,
  withTimeout,
} from "./core/context";
import {
  listHosts as listHostsCore,
  normalizeUserSearchName as normalizeUserSearchNameCore,
  queryProjects as queryProjectsCore,
  resolveAccountByIdentifier as resolveAccountByIdentifierCore,
  resolveHost as resolveHostCore,
  resolveWorkspace as resolveWorkspaceCore,
  resolveWorkspaceFromArgOrContext as resolveWorkspaceFromArgOrContextCore,
  workspaceState as workspaceStateCore,
} from "./core/workspace-resolve";
import { createWorkspaceFileOps } from "./core/workspace-file";
import { createWorkspaceCodexOps } from "./core/workspace-codex";
import {
  daemonLogPath,
  daemonPidPath,
  daemonRequestId,
  daemonRequestWithAutoStart,
  daemonSocketPath,
  isDaemonTransportError,
  pingDaemon,
  readDaemonPid,
  sendDaemonRequest,
  startDaemonProcess,
  type DaemonRequest,
  type DaemonResponse,
} from "./core/daemon-transport";
import {
  waitForLro as waitForLroCore,
  waitForProjectPlacement as waitForProjectPlacementCore,
  waitForWorkspaceNotRunning as waitForWorkspaceNotRunningCore,
} from "./core/lro";
import { registerOpCommand, type OpCommandDeps } from "./commands/op";
import { registerHostCommand, type HostCommandDeps } from "./commands/host";
import { registerWorkspaceCommand, type WorkspaceCommandDeps } from "./commands/workspace";
import { registerAuthCommand, type AuthCommandDeps } from "./commands/auth";
import { registerDaemonCommand, type DaemonCommandDeps } from "./commands/daemon";
import { registerAdminCommand, type AdminCommandDeps } from "./commands/admin";
import { registerAccountCommand, type AccountCommandDeps } from "./commands/account";

const cliVerboseFlag = process.argv.includes("--verbose");
const cliDebugEnabled =
  cliVerboseFlag ||
  process.env.COCALC_CLI_DEBUG === "1" ||
  process.env.COCALC_CLI_DEBUG === "true";
const requireCjs = createRequire(__filename);

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
  daemon?: boolean;
  noDaemon?: boolean;
  timeout?: string;
  rpcTimeout?: string;
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
  rpcTimeoutMs: number;
  pollMs: number;
  apiBaseUrl: string;
  remote: RemoteConnection;
  hub: HubApi;
  routedProjectHostClients: Record<string, RoutedProjectHostClientState>;
  workspaceCache: Map<string, { expiresAt: number; workspace: WorkspaceRow }>;
  hostConnectionCache: Map<string, { expiresAt: number; connection: HostConnectionInfo }>;
};

type RoutedProjectHostClientState = {
  host_id: string;
  address: string;
  client?: ConatClient;
  token?: string;
  expiresAt?: number;
  tokenSource?: "memory" | "hub";
  tokenInFlight?: Promise<string>;
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
  version?: string | null;
  project_bundle_version?: string | null;
  tools_version?: string | null;
  last_error?: string | null;
  last_action_error?: string | null;
  last_action_status?: string | null;
};

type LroStatus = {
  op_id: string;
  status: string;
  error?: string | null;
  timedOut?: boolean;
};

const TERMINAL_LRO_STATUSES = new Set(["succeeded", "failed", "canceled", "expired"]);
const LRO_SCOPE_TYPES: LroScopeType[] = ["project", "account", "host", "hub"];
const MAX_TRANSPORT_TIMEOUT_MS = 30_000;
const WORKSPACE_CONTEXT_FILENAME = ".cocalc-workspace";
const PROJECT_HOST_TOKEN_TTL_LEEWAY_MS = 60_000;
const WORKSPACE_CACHE_TTL_MS = 15_000;
const HOST_CONNECTION_CACHE_TTL_MS = 15_000;
const HOST_SSH_RESOLVE_TIMEOUT_MS = 5_000;

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

function workspaceContextPath(cwd = process.cwd()): string {
  return join(cwd, WORKSPACE_CONTEXT_FILENAME);
}

function saveWorkspaceContext(context: WorkspaceContextRecord, cwd = process.cwd()): void {
  writeFileSync(
    workspaceContextPath(cwd),
    `${JSON.stringify({ ...context, set_at: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function readWorkspaceContext(cwd = process.cwd()): WorkspaceContextRecord | undefined {
  const path = workspaceContextPath(cwd);
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

function clearWorkspaceContext(cwd = process.cwd()): boolean {
  const path = workspaceContextPath(cwd);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function daemonContextKey(globals: GlobalOptions): string {
  return JSON.stringify({
    profile: globals.profile ?? null,
    api: globals.api ?? null,
    account_id: getExplicitAccountId(globals) ?? null,
    api_key: globals.apiKey ?? null,
    cookie: globals.cookie ?? null,
    bearer: globals.bearer ?? null,
    hub_password: globals.hubPassword ?? null,
  });
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

function normalizeBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (!v || v === "0" || v === "false" || v === "no" || v === "off") {
      return false;
    }
    if (v === "1" || v === "true" || v === "yes" || v === "on") {
      return true;
    }
  }
  return Boolean(value);
}

function normalizeProcessExitCode(raw: unknown, stdout: string, stderr: string): number {
  const code = Number(raw);
  if (Number.isFinite(code)) {
    return code;
  }
  if (stdout.length > 0) return 0;
  if (stderr.length > 0) return 2;
  return 1;
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

function buildCookieHeader(
  baseUrl: string,
  globals: GlobalOptions,
  options: { includeHubPassword?: boolean } = {},
): string | undefined {
  const includeHubPassword = options.includeHubPassword !== false;
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

  if (includeHubPassword) {
    const hubPassword = normalizeSecretValue(
      globals.hubPassword ?? process.env.COCALC_HUB_PASSWORD,
    );
    if (hubPassword?.trim()) {
      const scopedName = cookieNameFor(baseUrl, "hub_password");
      parts.push(`${scopedName}=${hubPassword}`);
      if (scopedName !== "hub_password") {
        parts.push(`hub_password=${hubPassword}`);
      }
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
  const rpcTimeoutMs = Math.max(
    1_000,
    Math.min(timeoutMs, durationToMs(effectiveGlobals.rpcTimeout, MAX_TRANSPORT_TIMEOUT_MS)),
  );
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

  const ctx = {
    globals: effectiveGlobals,
    accountId,
    timeoutMs,
    rpcTimeoutMs,
    pollMs,
    apiBaseUrl,
    remote,
    hub: undefined as unknown as HubApi,
    routedProjectHostClients: {},
    workspaceCache: new Map(),
    hostConnectionCache: new Map(),
  };
  ctx.hub = createHubApiForContext(ctx);
  return ctx;
}

function closeCommandContext(ctx: CommandContext | undefined): void {
  if (!ctx) return;
  for (const host_id of Object.keys(ctx.routedProjectHostClients)) {
    closeRoutedProjectHostClient(ctx, host_id);
  }
  try {
    ctx.remote.client.close();
  } catch {
    // ignore
  }
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
    closeCommandContext(ctx);
  }
}

async function hubCallByName<T>(
  ctx: CommandContext,
  name: string,
  args: any[] = [],
  timeout?: number,
): Promise<T> {
  return await hubCallByNameCore<T>({
    ctx,
    name,
    args,
    timeout,
    callHub: (opts) => callHub(opts),
    debug: cliDebug,
  });
}

function createHubApiForContext(ctx: CommandContext): HubApi {
  return createTypedHubApiForContext((name, args = []) =>
    hubCallByName(ctx, name, args),
  );
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
  return workspaceStateCore(value);
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
  return await queryProjectsCore<WorkspaceRow>({
    ctx,
    project_id,
    title,
    host_id,
    limit,
  });
}

async function resolveWorkspace(ctx: CommandContext, identifier: string): Promise<WorkspaceRow> {
  return await resolveWorkspaceCore<WorkspaceRow>(
    ctx,
    identifier,
    WORKSPACE_CACHE_TTL_MS,
  );
}

async function resolveWorkspaceFromArgOrContext(
  ctx: CommandContext,
  identifier?: string,
  cwd = process.cwd(),
): Promise<WorkspaceRow> {
  return await resolveWorkspaceFromArgOrContextCore<WorkspaceRow>({
    ctx,
    identifier,
    cwd,
    workspaceCacheTtlMs: WORKSPACE_CACHE_TTL_MS,
    readWorkspaceContext,
    workspaceContextPath,
  });
}

function normalizeUserSearchName(row: UserSearchResult): string {
  return normalizeUserSearchNameCore(row);
}

async function resolveAccountByIdentifier(
  ctx: CommandContext,
  identifier: string,
): Promise<UserSearchResult> {
  return await resolveAccountByIdentifierCore(ctx, identifier);
}

function serializeInviteRow(invite: ProjectCollabInviteRow): Record<string, unknown> {
  return {
    invite_id: invite.invite_id,
    project_id: invite.project_id,
    project_title: invite.project_title ?? null,
    project_description: invite.project_description ?? null,
    inviter_account_id: invite.inviter_account_id,
    inviter_name:
      `${invite.inviter_name ?? ""}`.trim() ||
      `${invite.inviter_first_name ?? ""} ${invite.inviter_last_name ?? ""}`.trim() ||
      null,
    inviter_email_address: invite.inviter_email_address ?? null,
    invitee_account_id: invite.invitee_account_id,
    invitee_name:
      `${invite.invitee_name ?? ""}`.trim() ||
      `${invite.invitee_first_name ?? ""} ${invite.invitee_last_name ?? ""}`.trim() ||
      null,
    invitee_email_address: invite.invitee_email_address ?? null,
    status: invite.status,
    message: invite.message ?? null,
    responder_action: invite.responder_action ?? null,
    created: toIso(invite.created),
    updated: toIso(invite.updated),
    responded: toIso(invite.responded),
    expires: toIso(invite.expires),
    shared_projects_count: invite.shared_projects_count ?? 0,
    shared_projects_sample: invite.shared_projects_sample ?? [],
    prior_invites_accepted: invite.prior_invites_accepted ?? 0,
    prior_invites_declined: invite.prior_invites_declined ?? 0,
  };
}

function compactInviteRow(
  invite: ProjectCollabInviteRow,
  accountId: string,
): Record<string, unknown> {
  const inviterName =
    `${invite.inviter_name ?? ""}`.trim() ||
    `${invite.inviter_first_name ?? ""} ${invite.inviter_last_name ?? ""}`.trim() ||
    invite.inviter_account_id;
  const inviteeName =
    `${invite.invitee_name ?? ""}`.trim() ||
    `${invite.invitee_first_name ?? ""} ${invite.invitee_last_name ?? ""}`.trim() ||
    invite.invitee_account_id;
  const outbound = invite.inviter_account_id === accountId;
  const inbound = invite.invitee_account_id === accountId;
  const direction = outbound ? "outbound" : inbound ? "inbound" : "related";
  const other = outbound ? inviteeName : inviterName;
  return {
    invite_id: invite.invite_id,
    workspace: invite.project_title ?? invite.project_id,
    direction,
    with: other,
    status: invite.status,
    created: toIso(invite.created),
    responded: toIso(invite.responded),
  };
}

function isProjectHostAuthError(err: unknown): boolean {
  const mesg = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    mesg.includes("missing project-host bearer token") ||
    mesg.includes("project-host auth token") ||
    mesg.includes("jwt") ||
    mesg.includes("unauthorized")
  );
}

function localProxyProjectHostAddress(apiBaseUrl: string, routeId: string): string {
  const url = new URL(normalizeUrl(apiBaseUrl));
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${routeId}`.replace(/\/+/g, "/");
  if (!url.pathname.startsWith("/")) {
    url.pathname = `/${url.pathname}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function issueProjectHostAuthToken(
  ctx: CommandContext,
  state: RoutedProjectHostClientState,
  project_id: string,
): Promise<string> {
  const now = Date.now();
  if (
    state.token &&
    state.expiresAt &&
    now < state.expiresAt - PROJECT_HOST_TOKEN_TTL_LEEWAY_MS
  ) {
    state.tokenSource = "memory";
    return state.token;
  }
  if (state.tokenInFlight) {
    return await state.tokenInFlight;
  }

  state.tokenInFlight = (async () => {
    const issued = await ctx.hub.hosts.issueProjectHostAuthToken({
      host_id: state.host_id,
      project_id,
    });
    state.token = issued.token;
    state.expiresAt = issued.expires_at;
    state.tokenSource = "hub";
    return issued.token;
  })().finally(() => {
    delete state.tokenInFlight;
  });

  return await state.tokenInFlight;
}

function invalidateProjectHostAuthToken(state: RoutedProjectHostClientState): void {
  delete state.token;
  delete state.expiresAt;
  delete state.tokenSource;
  delete state.tokenInFlight;
}

function closeRoutedProjectHostClient(
  ctx: CommandContext,
  host_id: string,
): void {
  const current = ctx.routedProjectHostClients[host_id];
  if (!current) return;
  try {
    current.client?.close();
  } catch {
    // ignore close errors
  }
  delete ctx.routedProjectHostClients[host_id];
}

async function getOrCreateRoutedProjectHostClient(
  ctx: CommandContext,
  workspace: WorkspaceRow,
  allowTokenRetry = true,
): Promise<RoutedProjectHostClientState> {
  const host_id = workspace.host_id;
  if (!host_id) {
    throw new Error("workspace has no assigned host");
  }

  let connection: HostConnectionInfo | undefined;
  const cachedConnection = ctx.hostConnectionCache.get(host_id);
  if (cachedConnection && Date.now() < cachedConnection.expiresAt) {
    connection = cachedConnection.connection;
  }
  if (!connection) {
    connection = await ctx.hub.hosts.resolveHostConnection({ host_id });
    ctx.hostConnectionCache.set(host_id, {
      connection,
      expiresAt: Date.now() + HOST_CONNECTION_CACHE_TTL_MS,
    });
  }
  const address = connection.local_proxy
    ? localProxyProjectHostAddress(ctx.apiBaseUrl, workspace.project_id)
    : connection.connect_url
      ? normalizeUrl(connection.connect_url)
      : "";
  if (!address) {
    throw new Error(`host '${host_id}' has no connect_url and is not local_proxy`);
  }

  const existing = ctx.routedProjectHostClients[host_id];
  if (existing && existing.address === address && existing.client) {
    return existing;
  }
  if (existing) {
    closeRoutedProjectHostClient(ctx, host_id);
  }

  const state: RoutedProjectHostClientState = {
    host_id,
    address,
  };
  const cookie = connection.local_proxy
    ? buildCookieHeader(ctx.apiBaseUrl, ctx.globals, { includeHubPassword: false })
    : undefined;
  const routed = connectConat({
    address,
    noCache: true,
    reconnection: false,
    ...(cookie ? { extraHeaders: { Cookie: cookie } } : undefined),
    auth: async (cb) => {
      try {
        const token = await issueProjectHostAuthToken(ctx, state, workspace.project_id);
        cb({ bearer: token });
      } catch (err) {
        cliDebug("project-host token issuance failed", {
          host_id,
          err: err instanceof Error ? err.message : `${err}`,
        });
        cb({});
      }
    },
  });
  state.client = routed;
  routed.inboxPrefixHook = (info) => {
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
  routed.conn.on("connect_error", (err: unknown) => {
    if (isProjectHostAuthError(err)) {
      invalidateProjectHostAuthToken(state);
    }
  });
  ctx.routedProjectHostClients[host_id] = state;

  const signInTimeoutMs = Math.min(ctx.timeoutMs, MAX_TRANSPORT_TIMEOUT_MS);
  try {
    await withTimeout(
      routed.waitUntilSignedIn({ timeout: signInTimeoutMs }),
      signInTimeoutMs,
      `timeout while waiting for project-host sign-in (${signInTimeoutMs}ms)`,
    );
  } catch (err) {
    const hadToken = !!state.token;
    const shouldRetryWithFreshToken = allowTokenRetry && (hadToken || isProjectHostAuthError(err));
    closeRoutedProjectHostClient(ctx, host_id);
    if (shouldRetryWithFreshToken) {
      invalidateProjectHostAuthToken(state);
      return await getOrCreateRoutedProjectHostClient(ctx, workspace, false);
    }
    throw err;
  }

  return state;
}

async function resolveWorkspaceFilesystem(
  ctx: CommandContext,
  workspaceIdentifier?: string,
  cwd = process.cwd(),
): Promise<{ workspace: WorkspaceRow; fs: FilesystemClient }> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const routed = await getOrCreateRoutedProjectHostClient(ctx, workspace);
  if (!routed.client) {
    throw new Error(`internal error: routed client missing for host ${routed.host_id}`);
  }
  const fs = fsClient({
    client: routed.client,
    subject: fsSubject({ project_id: workspace.project_id }),
    timeout: Math.max(30_000, Math.min(ctx.timeoutMs, 30 * 60_000)),
  });
  return { workspace, fs };
}

const {
  workspaceFileListData,
  workspaceFileCatData,
  workspaceFilePutData,
  workspaceFileGetData,
  workspaceFileRmData,
  workspaceFileMkdirData,
  workspaceFileRgData,
  workspaceFileFdData,
  runWorkspaceFileCheck,
  runWorkspaceFileCheckBench,
  parsePositiveInteger,
} = createWorkspaceFileOps<CommandContext>({
  resolveWorkspaceFilesystem,
  resolveWorkspaceFromArgOrContext,
  asUtf8,
  normalizeProcessExitCode,
  normalizeBoolean,
});

const {
  readAllStdin,
  buildCodexSessionConfig,
  workspaceCodexExecData,
  streamCodexHumanMessage,
  workspaceCodexAuthStatusData,
  workspaceCodexDeviceAuthStartData,
  workspaceCodexDeviceAuthStatusData,
  workspaceCodexDeviceAuthCancelData,
  workspaceCodexAuthUploadFileData,
} = createWorkspaceCodexOps<CommandContext, WorkspaceRow>({
  resolveWorkspaceFromArgOrContext,
  getOrCreateRoutedProjectHostClient,
  projectHostHubCallAccount,
  toIso,
  readFileLocal,
});

async function projectHostHubCallAccount<T>(
  ctx: CommandContext,
  workspace: WorkspaceRow,
  name: string,
  args: any[] = [],
  timeout?: number,
  allowAuthRetry = true,
): Promise<T> {
  const routed = await getOrCreateRoutedProjectHostClient(ctx, workspace);
  if (!routed.client) {
    throw new Error(`internal error: routed client missing for host ${routed.host_id}`);
  }
  const timeoutMs = timeout ?? ctx.timeoutMs;
  const rpcTimeoutMs = Math.max(1_000, Math.min(timeoutMs, ctx.rpcTimeoutMs));
  cliDebug("projectHostHubCallAccount", {
    name,
    timeoutMs,
    rpcTimeoutMs,
    account_id: ctx.accountId,
    project_id: workspace.project_id,
    host_id: workspace.host_id,
  });
  try {
    return (await withTimeout(
      callHub({
        client: routed.client,
        account_id: ctx.accountId,
        name,
        args,
        timeout: rpcTimeoutMs,
      }),
      rpcTimeoutMs,
      `timeout waiting for project-host response: ${name} (${rpcTimeoutMs}ms)`,
    )) as T;
  } catch (err) {
    if (allowAuthRetry && isProjectHostAuthError(err) && workspace.host_id) {
      closeRoutedProjectHostClient(ctx, workspace.host_id);
      return await projectHostHubCallAccount(
        ctx,
        workspace,
        name,
        args,
        timeout,
        false,
      );
    }
    throw err;
  }
}

async function resolveHost(ctx: CommandContext, identifier: string): Promise<HostRow> {
  return await resolveHostCore<HostRow>(ctx, identifier);
}

async function listHosts(
  ctx: CommandContext,
  opts: { include_deleted?: boolean; catalog?: boolean; admin_view?: boolean } = {},
): Promise<HostRow[]> {
  return await listHostsCore<HostRow>(ctx, opts);
}

function normalizeHostSoftwareArtifactValue(value: string): HostSoftwareArtifact {
  const normalized = value.trim().toLowerCase();
  if (normalized === "project-host" || normalized === "host") {
    return "project-host";
  }
  if (
    normalized === "project" ||
    normalized === "project-bundle" ||
    normalized === "bundle"
  ) {
    return "project";
  }
  if (normalized === "tools" || normalized === "tool") {
    return "tools";
  }
  throw new Error(
    `invalid artifact '${value}'; expected one of: project-host, project, tools`,
  );
}

function parseHostSoftwareArtifactsOption(values?: string[]): HostSoftwareArtifact[] {
  if (!values?.length) {
    return ["project-host", "project", "tools"];
  }
  const artifacts = values.map((value) =>
    normalizeHostSoftwareArtifactValue(value),
  );
  return Array.from(new Set(artifacts));
}

function parseHostSoftwareChannelsOption(values?: string[]): HostSoftwareChannel[] {
  if (!values?.length) {
    return ["latest"];
  }
  const channels = values.map((value) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "latest" || normalized === "stable") return "latest";
    if (normalized === "staging") return "staging";
    throw new Error(
      `invalid channel '${value}'; expected one of: latest, staging`,
    );
  });
  return Array.from(new Set(channels));
}

const HOST_CREATE_DISK_TYPES = new Set(["ssd", "balanced", "standard", "ssd_io_m3"]);
const HOST_CREATE_STORAGE_MODES = new Set(["persistent", "ephemeral"]);
const HOST_CREATE_READY_STATUSES = new Set(["running", "active"]);
const HOST_CREATE_FAILED_STATUSES = new Set(["error", "deprovisioned"]);

function normalizeHostProviderValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("--provider must not be empty");
  }
  if (normalized === "google" || normalized === "google-cloud") {
    return "gcp";
  }
  if (normalized === "self" || normalized === "self_host") {
    return "self-host";
  }
  return normalized;
}

function parseHostMachineJson(value?: string): Partial<HostMachine> {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `--machine-json must be valid JSON object: ${
        err instanceof Error ? err.message : `${err}`
      }`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--machine-json must be a JSON object");
  }
  return { ...(parsed as Partial<HostMachine>) };
}

function parseOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value == null || `${value}`.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function inferRegionFromZone(zone: string | undefined): string | undefined {
  const raw = `${zone ?? ""}`.trim();
  if (!raw) return undefined;
  const parts = raw.split("-").filter(Boolean);
  if (parts.length >= 3 && parts[parts.length - 1].length === 1) {
    return parts.slice(0, -1).join("-");
  }
  return undefined;
}

function summarizeCatalogPayload(payload: unknown): string {
  if (payload == null) return "null";
  if (Array.isArray(payload)) {
    if (payload.length === 0) return "0 items";
    const named = payload
      .slice(0, 3)
      .map((item) => (item && typeof item === "object" ? `${(item as any).name ?? ""}`.trim() : ""))
      .filter(Boolean);
    if (named.length > 0) {
      return `${payload.length} items (${named.join(", ")}${payload.length > named.length ? ", ..." : ""})`;
    }
    return `${payload.length} items`;
  }
  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);
    if (!keys.length) return "0 keys";
    const preview = keys.slice(0, 4).join(", ");
    return `${keys.length} keys (${preview}${keys.length > 4 ? ", ..." : ""})`;
  }
  return `${payload}`;
}

function summarizeHostCatalogEntries(
  catalog: HostCatalog,
  kinds?: string[],
): Array<Record<string, unknown>> {
  const wantedKinds = new Set(
    (kinds ?? [])
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );
  const entries = (catalog.entries ?? []).filter((entry) =>
    wantedKinds.size ? wantedKinds.has(`${entry.kind ?? ""}`.toLowerCase()) : true,
  );
  return entries.map((entry: HostCatalogEntry) => ({
    provider: catalog.provider,
    kind: entry.kind,
    scope: entry.scope,
    summary: summarizeCatalogPayload(entry.payload),
  }));
}

async function waitForHostCreateReady(
  ctx: CommandContext,
  hostId: string,
  {
    timeoutMs,
    pollMs,
  }: {
    timeoutMs: number;
    pollMs: number;
  },
): Promise<{ host: HostRow; timedOut: boolean }> {
  const started = Date.now();
  let lastHost: HostRow | undefined;
  while (Date.now() - started <= timeoutMs) {
    const hosts = await listHosts(ctx, {
      include_deleted: true,
      catalog: true,
    });
    const host = hosts.find((x) => x.id === hostId);
    if (!host) {
      throw new Error(`host '${hostId}' no longer exists`);
    }
    lastHost = host;
    const status = `${host.status ?? ""}`.trim().toLowerCase();
    if (HOST_CREATE_READY_STATUSES.has(status)) {
      return { host, timedOut: false };
    }
    if (HOST_CREATE_FAILED_STATUSES.has(status)) {
      const detail = `${host.last_action_error ?? host.last_error ?? ""}`.trim();
      throw new Error(
        `host create failed: status=${status}${detail ? ` error=${detail}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (!lastHost) {
    throw new Error(`host '${hostId}' not found`);
  }
  return { host: lastHost, timedOut: true };
}

async function resolveHostSshEndpoint(
  ctx: CommandContext,
  hostIdentifier: string,
): Promise<{
  host: HostRow;
  ssh_host: string;
  ssh_port: number | null;
  ssh_server: string | null;
}> {
  const host = await resolveHost(ctx, hostIdentifier);
  const machine = (host.machine ?? {}) as Record<string, any>;
  const directHost = `${host.public_ip ?? machine?.metadata?.public_ip ?? ""}`.trim();
  if (directHost) {
    const configuredPort = Number(machine?.metadata?.ssh_port);
    const directPort =
      Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
        ? configuredPort
        : 22;
    return {
      host,
      ssh_host: directHost,
      ssh_port: directPort,
      ssh_server: `${directHost}:${directPort}`,
    };
  }
  let connection: HostConnectionInfo | null = null;
  try {
    connection = await Promise.race([
      ctx.hub.hosts.resolveHostConnection({ host_id: host.id }),
      new Promise<HostConnectionInfo>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `hosts.resolveHostConnection timed out after ${HOST_SSH_RESOLVE_TIMEOUT_MS}ms`,
              ),
            ),
          HOST_SSH_RESOLVE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    cliDebug("host ssh: resolveHostConnection failed, falling back to host ip", {
      host_id: host.id,
      err: err instanceof Error ? err.message : `${err}`,
    });
  }
  if (connection?.ssh_server) {
    const parsed = parseSshServer(connection.ssh_server);
    return {
      host,
      ssh_host: parsed.host,
      ssh_port: parsed.port ?? null,
      ssh_server: connection.ssh_server,
    };
  }
  throw new Error("host has no direct public ip and no routed ssh endpoint");
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
  return await waitForLroCore({
    hub: ctx.hub,
    opId,
    timeoutMs,
    pollMs,
    terminalStatuses: TERMINAL_LRO_STATUSES,
  });
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
  return await waitForProjectPlacementCore({
    projectId,
    hostId,
    timeoutMs,
    pollMs,
    getHostId: async (id) => {
      const rows = await queryProjects({ ctx, project_id: id, limit: 1 });
      return rows[0]?.host_id;
    },
  });
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
  return await waitForWorkspaceNotRunningCore({
    projectId,
    timeoutMs,
    pollMs,
    getState: async (id) => {
      const rows = await queryProjects({ ctx, project_id: id, limit: 1 });
      return workspaceState(rows[0]?.state);
    },
  });
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

function cloudflaredInstallHint(): string {
  if (process.platform === "darwin") {
    return "brew install cloudflared";
  }
  if (process.platform === "linux") {
    return "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
  }
  return "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/";
}

function resolveCloudflaredBinary(): string {
  const configured = `${process.env.COCALC_CLI_CLOUDFLARED ?? ""}`.trim();
  if (configured) {
    if (!commandExists(configured)) {
      throw new Error(
        `COCALC_CLI_CLOUDFLARED is set but not executable: ${configured}`,
      );
    }
    return configured;
  }
  if (commandExists("cloudflared")) {
    return "cloudflared";
  }
  throw new Error(
    `cloudflared is required for workspace ssh via Cloudflare Access; install it (${cloudflaredInstallHint()}) or use --direct`,
  );
}

type CommandCaptureResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type SyncKeyInfo = {
  private_key_path: string;
  public_key_path: string;
  public_key: string;
  created: boolean;
};

type WorkspaceSshTarget = {
  workspace: WorkspaceRow;
  ssh_server: string;
  ssh_host: string;
  ssh_port: number | null;
  ssh_target: string;
};

type WorkspaceSshRoute = {
  workspace: WorkspaceRow;
  host_id: string;
  transport: "cloudflare-access-tcp" | "direct";
  ssh_username: string;
  ssh_server: string | null;
  cloudflare_hostname: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
};

type ReflectForwardRecord = {
  id: number;
  name?: string | null;
  direction?: "local_to_remote" | "remote_to_local";
  ssh_host: string;
  ssh_port?: number | null;
  local_host: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  desired_state?: string;
  actual_state?: string;
  monitor_pid?: number | null;
  last_error?: string | null;
  ssh_args?: string | null;
};

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function defaultSyncKeyBasePath(): string {
  return join(homedir(), ".ssh", "id_ed25519");
}

function normalizeSyncKeyBasePath(input?: string): string {
  const raw = `${input ?? ""}`.trim();
  if (!raw) {
    return defaultSyncKeyBasePath();
  }
  const expanded = expandUserPath(raw);
  if (expanded.endsWith(".pub")) {
    return expanded.slice(0, -4);
  }
  return expanded;
}

function syncKeyPublicPath(basePath: string): string {
  return `${basePath}.pub`;
}

function defaultWorkspaceSshConfigPath(): string {
  return join(homedir(), ".ssh", "config");
}

function normalizeWorkspaceSshConfigPath(input?: string): string {
  const raw = `${input ?? ""}`.trim();
  if (!raw) {
    return defaultWorkspaceSshConfigPath();
  }
  return expandUserPath(raw);
}

function normalizeWorkspaceSshHostAlias(input: string): string {
  const alias = input.trim();
  if (!alias) {
    throw new Error("ssh config host alias cannot be empty");
  }
  if (alias.includes("@")) {
    throw new Error(
      `ssh config host alias '${alias}' cannot contain '@' (ssh parses user@host); use a host-only alias, e.g. '${alias.replace(/@/g, "-")}'`,
    );
  }
  if (/\s/.test(alias)) {
    throw new Error(`ssh config host alias '${alias}' cannot contain whitespace`);
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(alias)) {
    throw new Error(
      `ssh config host alias '${alias}' must match [a-zA-Z0-9._-]+`,
    );
  }
  return alias;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspaceSshConfigBlockMarkers(alias: string): {
  start: string;
  end: string;
} {
  return {
    start: `# >>> cocalc ws ssh ${alias} >>>`,
    end: `# <<< cocalc ws ssh ${alias} <<<`,
  };
}

function removeWorkspaceSshConfigBlock(
  content: string,
  alias: string,
): { content: string; removed: boolean } {
  const { start, end } = workspaceSshConfigBlockMarkers(alias);
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(start)}\\n[\\s\\S]*?\\n${escapeRegExp(end)}(?:\\n|$)`,
    "g",
  );
  const next = content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  return {
    content: next,
    removed: next !== content,
  };
}

function readSyncPublicKey(basePath: string): string {
  const pubPath = syncKeyPublicPath(basePath);
  const publicKey = readFileSync(pubPath, "utf8").trim();
  if (!publicKey) {
    throw new Error(`ssh public key is empty: ${pubPath}`);
  }
  return publicKey;
}

async function ensureSyncKeyPair(keyPathInput?: string): Promise<SyncKeyInfo> {
  const privateKeyPath = normalizeSyncKeyBasePath(keyPathInput);
  const publicKeyPath = syncKeyPublicPath(privateKeyPath);
  const privateExists = existsSync(privateKeyPath);
  const publicExists = existsSync(publicKeyPath);
  if (privateExists && publicExists) {
    return {
      private_key_path: privateKeyPath,
      public_key_path: publicKeyPath,
      public_key: readSyncPublicKey(privateKeyPath),
      created: false,
    };
  }
  if (privateExists !== publicExists) {
    throw new Error(
      `incomplete ssh keypair: expected both '${privateKeyPath}' and '${publicKeyPath}'`,
    );
  }

  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  const comment = `cocalc-cli-sync-${hostname()}`;
  const created = spawnSync(
    "ssh-keygen",
    ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", comment],
    {
      encoding: "utf8",
    },
  );
  if (created.error) {
    const message = (created.error as Error).message ?? `${created.error}`;
    throw new Error(`failed to run ssh-keygen: ${message}`);
  }
  if (created.status !== 0) {
    const stderr = `${created.stderr ?? ""}`.trim();
    throw new Error(stderr || `ssh-keygen failed with exit code ${created.status}`);
  }
  if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
    throw new Error("ssh-keygen completed, but key files were not created");
  }
  return {
    private_key_path: privateKeyPath,
    public_key_path: publicKeyPath,
    public_key: readSyncPublicKey(privateKeyPath),
    created: true,
  };
}

function isNotFoundLikeError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("does not exist")
  );
}

async function installSyncPublicKey({
  ctx,
  workspaceIdentifier,
  publicKey,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  publicKey: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const trimmedKey = publicKey.trim();
  if (!trimmedKey) {
    throw new Error("public key is empty");
  }

  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  const sshDir = ".ssh";
  const authorizedKeysPath = ".ssh/authorized_keys";
  await fs.mkdir(sshDir, { recursive: true });

  let existing = "";
  try {
    existing = String(await fs.readFile(authorizedKeysPath, "utf8"));
  } catch (err) {
    if (!isNotFoundLikeError(err)) {
      throw err;
    }
  }

  const existingKeys = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (existingKeys.includes(trimmedKey)) {
    return {
      workspace_id: workspace.project_id,
      workspace_title: workspace.title,
      path: authorizedKeysPath,
      installed: false,
      already_present: true,
    };
  }

  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const next = `${prefix}${trimmedKey}\n`;
  await fs.writeFile(authorizedKeysPath, Buffer.from(next, "utf8"));
  return {
    workspace_id: workspace.project_id,
    workspace_title: workspace.title,
    path: authorizedKeysPath,
    installed: true,
    already_present: false,
  };
}

async function resolveWorkspaceSshTarget(
  ctx: CommandContext,
  workspaceIdentifier?: string,
  cwd = process.cwd(),
): Promise<WorkspaceSshTarget> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  if (!workspace.host_id) {
    throw new Error("workspace has no assigned host");
  }
  const connection = await ctx.hub.hosts.resolveHostConnection({
    host_id: workspace.host_id,
  });
  if (!connection.ssh_server) {
    throw new Error("host has no ssh server endpoint");
  }
  const parsed = parseSshServer(connection.ssh_server);
  const sshHost = `${workspace.project_id}@${parsed.host}`;
  const sshTarget = parsed.port != null ? `${sshHost}:${parsed.port}` : sshHost;
  return {
    workspace,
    ssh_server: connection.ssh_server,
    ssh_host: sshHost,
    ssh_port: parsed.port ?? null,
    ssh_target: sshTarget,
  };
}

async function resolveWorkspaceSshConnection(
  ctx: CommandContext,
  workspaceIdentifier?: string,
  {
    cwd = process.cwd(),
    direct = false,
  }: {
    cwd?: string;
    direct?: boolean;
  } = {},
): Promise<WorkspaceSshRoute> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  if (!workspace.host_id) {
    throw new Error("workspace has no assigned host");
  }
  const connection = (await ctx.hub.projects.resolveWorkspaceSshConnection({
    project_id: workspace.project_id,
    direct,
  })) as WorkspaceSshConnectionInfo;
  const sshUsername = `${connection.ssh_username ?? workspace.project_id}`.trim() || workspace.project_id;
  if (connection.transport === "cloudflare-access-tcp") {
    const hostname = `${connection.cloudflare_hostname ?? ""}`.trim();
    if (!hostname) {
      throw new Error("workspace ssh route returned no cloudflare hostname");
    }
    return {
      workspace,
      host_id: connection.host_id,
      transport: "cloudflare-access-tcp",
      ssh_username: sshUsername,
      ssh_server: connection.ssh_server ?? null,
      cloudflare_hostname: hostname,
      ssh_host: hostname,
      ssh_port: null,
    };
  }
  const sshServer = `${connection.ssh_server ?? ""}`.trim();
  if (!sshServer) {
    throw new Error("host has no ssh server endpoint");
  }
  const parsed = parseSshServer(sshServer);
  return {
    workspace,
    host_id: connection.host_id,
    transport: "direct",
    ssh_username: sshUsername,
    ssh_server: sshServer,
    cloudflare_hostname:
      `${connection.cloudflare_hostname ?? ""}`.trim() || null,
    ssh_host: parsed.host,
    ssh_port: parsed.port ?? null,
  };
}

function reflectSyncHomeDir(): string {
  return process.env.COCALC_REFLECT_HOME ?? join(dirname(authConfigPath()), "reflect-sync");
}

function reflectSyncSessionDbPath(): string {
  return join(reflectSyncHomeDir(), "sessions.db");
}

function resolveReflectSyncCliEntry(): string {
  try {
    return requireCjs.resolve("reflect-sync/cli");
  } catch {
    throw new Error(
      "reflect-sync is not installed in @cocalc/cli (add it to dependencies and run pnpm install)",
    );
  }
}

async function runCommandCapture(
  command: string,
  args: string[],
  {
    env,
  }: {
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandCaptureResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function runReflectSyncCli(args: string[]): Promise<CommandCaptureResult> {
  const reflectHome = reflectSyncHomeDir();
  mkdirSync(reflectHome, { recursive: true, mode: 0o700 });
  const cliEntry = resolveReflectSyncCliEntry();
  const result = await runCommandCapture(
    process.execPath,
    [
      cliEntry,
      "--log-level",
      "error",
      "--session-db",
      reflectSyncSessionDbPath(),
      ...args,
    ],
    {
      env: {
        ...process.env,
        REFLECT_HOME: reflectHome,
      },
    },
  );
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim();
    throw new Error(message || `reflect-sync exited with code ${result.code}`);
  }
  return result;
}

function parseReflectForwardRows(raw: string): ReflectForwardRecord[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `unable to parse reflect-sync forward list JSON: ${err instanceof Error ? err.message : `${err}`}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("reflect-sync forward list did not return an array");
  }
  return parsed as ReflectForwardRecord[];
}

async function listReflectForwards(): Promise<ReflectForwardRecord[]> {
  const result = await runReflectSyncCli(["forward", "list", "--json"]);
  return parseReflectForwardRows(result.stdout);
}

function parseCreatedForwardId(output: string): number | null {
  const match = output.match(/created forward\s+(\d+)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function forwardsForWorkspace(
  rows: ReflectForwardRecord[],
  workspaceId: string,
): ReflectForwardRecord[] {
  const prefix = `${workspaceId}@`;
  return rows.filter((row) => `${row.ssh_host ?? ""}`.startsWith(prefix));
}

function formatReflectForwardRow(row: ReflectForwardRecord): Record<string, unknown> {
  const sshHost = `${row.ssh_host ?? ""}`;
  const workspaceId = sshHost.includes("@") ? sshHost.split("@")[0] : null;
  const target = row.ssh_port ? `${sshHost}:${row.ssh_port}` : sshHost;
  return {
    id: row.id,
    name: row.name ?? null,
    workspace_id: workspaceId,
    direction: row.direction ?? null,
    target,
    local: `${row.local_host}:${row.local_port}`,
    remote_port: row.remote_port,
    state: row.actual_state ?? null,
    desired_state: row.desired_state ?? null,
    monitor_pid: row.monitor_pid ?? null,
    last_error: row.last_error ?? null,
  };
}

async function terminateReflectForwards(forwardRefs: string[]): Promise<void> {
  if (!forwardRefs.length) return;
  await runReflectSyncCli(["forward", "terminate", ...forwardRefs]);
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

async function confirmHardWorkspaceDelete({
  workspace_id,
  title,
  backupRetentionDays,
  purgeBackupsNow,
}: {
  workspace_id: string;
  title?: string;
  backupRetentionDays: number;
  purgeBackupsNow: boolean;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "hard delete requires interactive confirmation; pass --yes to continue non-interactively",
    );
  }
  const expected = workspace_id;
  const backupMessage = purgeBackupsNow
    ? "File backups will be purged immediately."
    : backupRetentionDays > 0
      ? `Only file backups are retained for ${backupRetentionDays} day(s), then purged.`
      : "File backups will be purged immediately.";
  console.error(
    "WARNING: hard delete immediately and permanently removes workspace metadata (title/description, collaborators, invites, logs, API keys, shares, etc.).",
  );
  console.error(
    "Only file backup data can be restored while retention is active.",
  );
  console.error(backupMessage);
  console.error(
    `Type project_id '${expected}' to permanently delete workspace '${title?.trim() || workspace_id}'.`,
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question("Confirm: ")).trim();
    if (answer !== expected) {
      throw new Error("hard delete confirmation did not match; aborting");
    }
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

  const connection = await ctx.hub.hosts.resolveHostConnection({ host_id: host.id });

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

type DaemonServerState = {
  startedAtMs: number;
  socketPath: string;
  pidPath: string;
  contexts: Map<string, CommandContext>;
  server?: NetServer;
  closing: boolean;
};

function daemonContextMeta(ctx: CommandContext) {
  return {
    api: ctx.apiBaseUrl,
    account_id: ctx.accountId,
  };
}

async function getDaemonContext(
  state: DaemonServerState,
  globals: GlobalOptions,
): Promise<CommandContext> {
  const key = daemonContextKey(globals);
  const existing = state.contexts.get(key);
  if (existing) {
    return existing;
  }
  const ctx = await contextForGlobals({ ...globals, noDaemon: true });
  state.contexts.set(key, ctx);
  return ctx;
}

function closeDaemonServerState(state: DaemonServerState): void {
  for (const ctx of state.contexts.values()) {
    closeCommandContext(ctx);
  }
  state.contexts.clear();
  try {
    state.server?.close();
  } catch {
    // ignore
  }
  try {
    if (existsSync(state.socketPath)) unlinkSync(state.socketPath);
  } catch {
    // ignore
  }
  try {
    if (existsSync(state.pidPath)) unlinkSync(state.pidPath);
  } catch {
    // ignore
  }
}

async function handleDaemonAction(
  state: DaemonServerState,
  request: DaemonRequest,
): Promise<DaemonResponse> {
  const meta = {
    pid: process.pid,
    uptime_s: Math.max(0, Math.floor((Date.now() - state.startedAtMs) / 1000)),
    started_at: new Date(state.startedAtMs).toISOString(),
  };
  try {
    switch (request.action) {
      case "ping":
        return { id: request.id, ok: true, data: { status: "ok" }, meta };
      case "shutdown":
        state.closing = true;
        setTimeout(() => {
          closeDaemonServerState(state);
          process.exit(0);
        }, 10);
        return { id: request.id, ok: true, data: { status: "shutting_down" }, meta };
      case "workspace.file.list": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileListData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          path: typeof request.payload?.path === "string" ? request.payload.path : undefined,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.cat": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const path = typeof request.payload?.path === "string" ? request.payload.path : "";
        if (!path) {
          throw new Error("workspace file cat requires path");
        }
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileCatData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          path,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.put": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const dest = typeof request.payload?.dest === "string" ? request.payload.dest : "";
        const contentBase64 =
          typeof request.payload?.content_base64 === "string"
            ? request.payload.content_base64
            : "";
        if (!dest) {
          throw new Error("workspace file put requires dest");
        }
        const data = Buffer.from(contentBase64, "base64");
        const ctx = await getDaemonContext(state, globals);
        const result = await workspaceFilePutData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          dest,
          data,
          parents: request.payload?.parents !== false,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data: result,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.get": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const src = typeof request.payload?.src === "string" ? request.payload.src : "";
        if (!src) {
          throw new Error("workspace file get requires src");
        }
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileGetData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          src,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.rm": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const path = typeof request.payload?.path === "string" ? request.payload.path : "";
        if (!path) {
          throw new Error("workspace file rm requires path");
        }
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileRmData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          path,
          recursive: request.payload?.recursive === true,
          force: request.payload?.force === true,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.mkdir": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const path = typeof request.payload?.path === "string" ? request.payload.path : "";
        if (!path) {
          throw new Error("workspace file mkdir requires path");
        }
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileMkdirData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          path,
          parents: request.payload?.parents !== false,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.rg": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const pattern = typeof request.payload?.pattern === "string" ? request.payload.pattern : "";
        if (!pattern) {
          throw new Error("workspace file rg requires pattern");
        }
        const timeoutMs = Math.max(1, Number(request.payload?.timeout_ms ?? 30_000) || 30_000);
        const maxBytes = Math.max(1024, Number(request.payload?.max_bytes ?? 20000000) || 20000000);
        const rgOptions = Array.isArray(request.payload?.rg_options)
          ? request.payload?.rg_options.filter((x): x is string => typeof x === "string")
          : undefined;
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileRgData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          pattern,
          path: typeof request.payload?.path === "string" ? request.payload.path : undefined,
          timeoutMs,
          maxBytes,
          options: rgOptions,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      case "workspace.file.fd": {
        const globals = request.globals ?? {};
        const cwd = typeof request.cwd === "string" ? request.cwd : process.cwd();
        const timeoutMs = Math.max(1, Number(request.payload?.timeout_ms ?? 30_000) || 30_000);
        const maxBytes = Math.max(1024, Number(request.payload?.max_bytes ?? 20000000) || 20000000);
        const fdOptions = Array.isArray(request.payload?.fd_options)
          ? request.payload?.fd_options.filter((x): x is string => typeof x === "string")
          : undefined;
        const ctx = await getDaemonContext(state, globals);
        const data = await workspaceFileFdData({
          ctx,
          workspaceIdentifier: typeof request.payload?.workspace === "string" ? request.payload.workspace : undefined,
          pattern: typeof request.payload?.pattern === "string" ? request.payload.pattern : undefined,
          path: typeof request.payload?.path === "string" ? request.payload.path : undefined,
          timeoutMs,
          maxBytes,
          options: fdOptions,
          cwd,
        });
        return {
          id: request.id,
          ok: true,
          data,
          meta: {
            ...meta,
            ...daemonContextMeta(ctx),
          },
        };
      }
      default:
        throw new Error(`unsupported daemon action '${request.action}'`);
    }
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : `${err}`,
      meta,
    };
  }
}

async function serveDaemon(socketPath = daemonSocketPath()): Promise<void> {
  mkdirSync(dirname(socketPath), { recursive: true });
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    // ignore
  }
  const state: DaemonServerState = {
    startedAtMs: Date.now(),
    socketPath,
    pidPath: daemonPidPath(),
    contexts: new Map(),
    closing: false,
  };
  writeFileSync(state.pidPath, `${process.pid}\n`, "utf8");

  const server = createNetServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let request: DaemonRequest;
        try {
          request = JSON.parse(line) as DaemonRequest;
        } catch (err) {
          const response: DaemonResponse = {
            id: daemonRequestId(),
            ok: false,
            error: `invalid daemon request JSON: ${err instanceof Error ? err.message : `${err}`}`,
            meta: { pid: process.pid },
          };
          socket.write(`${JSON.stringify(response)}\n`);
          continue;
        }
        const response = await handleDaemonAction(state, request);
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  state.server = server;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const terminate = () => {
    if (state.closing) return;
    state.closing = true;
    closeDaemonServerState(state);
    process.exit(0);
  };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);

  await new Promise<void>(() => {
    // wait forever until signal/shutdown
  });
}

async function runDaemonRequestFromCommand(
  command: unknown,
  request: Omit<DaemonRequest, "id" | "globals">,
): Promise<DaemonResponse> {
  const globals = globalsFrom(command);
  return await daemonRequestWithAutoStart({
    id: daemonRequestId(),
    action: request.action,
    payload: request.payload,
    cwd: process.cwd(),
    globals: { ...globals, noDaemon: true },
  });
}

function shouldUseDaemonForFileOps(globals: GlobalOptions): boolean {
  if (process.env.COCALC_CLI_DAEMON_MODE === "1") return false;
  if (globals.daemon === false) return false;
  return globals.noDaemon !== true;
}

function emitWorkspaceFileCatHumanContent(content: string): void {
  process.stdout.write(content);
  if (!content.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

const program = new Command();

program
  .name("cocalc")
  .description("CoCalc CLI (Phase 0)")
  .version(pkg.version)
  .option("--json", "output machine-readable JSON")
  .option("--output <format>", "output format (table|json|yaml)", "table")
  .option("-q, --quiet", "suppress human-formatted success output")
  .option("--no-daemon", "disable CLI daemon usage")
  .option("--verbose", "enable verbose debug logging to stderr")
  .option("--profile <name>", "auth profile name (default: current profile)")
  .option("--account-id <uuid>", "account id to use for API calls")
  .option("--api <url>", "hub base URL")
  .option("--timeout <duration>", "wait timeout (default: 600s)", "600s")
  .option("--rpc-timeout <duration>", "per-RPC timeout (default: 30s)", "30s")
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

const daemonCommandDeps = {
  runLocalCommand,
  startDaemonProcess,
  daemonSocketPath,
  daemonPidPath,
  daemonLogPath,
  readDaemonPid,
  pingDaemon,
  sendDaemonRequest,
  daemonRequestId,
  serveDaemon,
} satisfies DaemonCommandDeps;

registerDaemonCommand(program, daemonCommandDeps);

const authCommandDeps = {
  runLocalCommand,
  authConfigPath,
  loadAuthConfig,
  selectedProfileName,
  applyAuthProfile,
  normalizeUrl,
  defaultApiBaseUrl,
  getExplicitAccountId,
  durationToMs,
  connectRemote,
  resolveAccountIdFromRemote,
  normalizeSecretValue,
  maskSecret,
  sanitizeProfileName,
  profileFromGlobals,
  saveAuthConfig,
} satisfies AuthCommandDeps;

registerAuthCommand(program, authCommandDeps);
const workspaceCommandDeps = {
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
} satisfies WorkspaceCommandDeps;

registerWorkspaceCommand(program, workspaceCommandDeps);
const opCommandDeps = {
  withContext,
  resolveWorkspace,
  resolveHost,
  parseLroScopeType,
  serializeLroSummary,
  waitForLro,
} satisfies OpCommandDeps;

registerOpCommand(program, opCommandDeps);

const adminCommandDeps = {
  withContext,
} satisfies AdminCommandDeps;

registerAdminCommand(program, adminCommandDeps);

const accountCommandDeps = {
  withContext,
  toIso,
} satisfies AccountCommandDeps;

registerAccountCommand(program, accountCommandDeps);

const hostCommandDeps = {
  withContext,
  listHosts,
  resolveHost,
  normalizeHostProviderValue,
  summarizeHostCatalogEntries,
  emitWorkspaceFileCatHumanContent,
  parseHostSoftwareArtifactsOption,
  parseHostSoftwareChannelsOption,
  waitForLro,
  ensureSyncKeyPair,
  resolveHostSshEndpoint,
  expandUserPath,
  parseHostMachineJson,
  parseOptionalPositiveInteger,
  inferRegionFromZone,
  HOST_CREATE_DISK_TYPES,
  HOST_CREATE_STORAGE_MODES,
  waitForHostCreateReady,
  resolveWorkspace,
} satisfies HostCommandDeps;

registerHostCommand(program, hostCommandDeps);

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
