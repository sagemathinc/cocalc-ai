#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirLocal, readFile as readFileLocal, writeFile as writeFileLocal } from "node:fs/promises";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { Command } from "commander";

import pkg from "../../package.json";

import { connect as connectConat, type Client as ConatClient } from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";
import callHub from "@cocalc/conat/hub/call-hub";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import type { HubApi } from "@cocalc/conat/hub/api";
import type {
  HostConnectionInfo,
} from "@cocalc/conat/hub/api/hosts";
import type { LroScopeType, LroSummary as HubLroSummary } from "@cocalc/conat/hub/api/lro";
import type {
  ProjectCollabInviteRow,
} from "@cocalc/conat/hub/api/projects";
import { fsClient, fsSubject, type FilesystemClient } from "@cocalc/conat/files/fs";
import type { UserSearchResult } from "@cocalc/util/db-schema/accounts";
import { createBrowserSessionClient } from "@cocalc/conat/service/browser-session";
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
import { createWorkspaceSyncOps } from "./core/workspace-sync";
import {
  commandExists,
  isLikelySshAuthFailure,
  resolveCloudflaredBinary,
  runCommand,
  runSsh,
  runSshCheck,
} from "./core/system-command";
import {
  asObject,
  emitError as emitErrorCore,
  emitSuccess,
  printArrayTable,
} from "./core/cli-output";
import {
  HOST_CREATE_DISK_TYPES,
  HOST_CREATE_STORAGE_MODES,
  createHostHelpers,
  inferRegionFromZone,
  normalizeHostProviderValue,
  parseHostMachineJson,
  parseHostSoftwareArtifactsOption,
  parseHostSoftwareChannelsOption,
  parseOptionalPositiveInteger,
  summarizeHostCatalogEntries,
} from "./core/host-helpers";
import {
  daemonLogPath,
  daemonPidPath,
  daemonRequestId,
  daemonSocketPath,
  isDaemonTransportError,
  pingDaemon,
  readDaemonPid,
  sendDaemonRequest,
  startDaemonProcess,
} from "./core/daemon-transport";
import { createDaemonServerOps } from "./core/daemon-server";
import {
  PRODUCT_SPECS,
  runProductCommand,
  type ProductCommand,
} from "./core/product-shortcuts";
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
import {
  registerBrowserCommand,
  type BrowserCommandDeps,
} from "./commands/browser";

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

function defaultApiBaseUrl(): string {
  const raw =
    process.env.COCALC_API_URL ??
    process.env.BASE_URL ??
    `http://127.0.0.1:${process.env.HUB_PORT ?? process.env.PORT ?? "9100"}`;
  return normalizeUrl(raw);
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

function emitError(
  ctx: { globals?: GlobalOptions; apiBaseUrl?: string; accountId?: string },
  commandName: string,
  error: unknown,
): void {
  emitErrorCore(ctx, commandName, error, normalizeUrl);
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

type LiteConnectionInfo = {
  url?: string;
  protocol?: string;
  host?: string;
  port?: number;
  agent_token?: string;
  account_id?: string;
};

function isLoopbackHostName(hostname: string): boolean {
  const host = `${hostname ?? ""}`.trim().toLowerCase();
  if (!host) return false;
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function liteConnectionInfoPath(): string {
  const explicit =
    process.env.COCALC_LITE_CONNECTION_INFO ??
    process.env.COCALC_WRITE_CONNECTION_INFO;
  if (explicit?.trim()) return explicit.trim();
  return join(
    process.env.HOME?.trim() || process.cwd(),
    ".local",
    "share",
    "cocalc-lite",
    "connection-info.json",
  );
}

function loadLiteConnectionInfo(): LiteConnectionInfo | undefined {
  const path = liteConnectionInfoPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as LiteConnectionInfo;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function matchesLiteConnection({
  apiBaseUrl,
  info,
}: {
  apiBaseUrl: string;
  info: LiteConnectionInfo;
}): boolean {
  if (typeof info.url === "string" && info.url.trim()) {
    try {
      return normalizeUrl(info.url) === apiBaseUrl;
    } catch {
      // ignore malformed url in connection-info
    }
  }
  try {
    const base = new URL(apiBaseUrl);
    const hostOk =
      typeof info.host === "string" &&
      info.host.trim().toLowerCase() === base.hostname.toLowerCase();
    const protocolOk =
      typeof info.protocol === "string"
        ? info.protocol.trim().toLowerCase().replace(/:$/, "") ===
          base.protocol.replace(/:$/, "").toLowerCase()
        : true;
    const port = Number(info.port ?? NaN);
    const basePort = Number(base.port || (base.protocol === "https:" ? 443 : 80));
    const portOk = Number.isFinite(port) ? port === basePort : true;
    return hostOk && protocolOk && portOk;
  } catch {
    return false;
  }
}

function maybeApplyLiteAgentAuth({
  globals,
  apiBaseUrl,
}: {
  globals: GlobalOptions;
  apiBaseUrl: string;
}): GlobalOptions {
  const hasExplicitAuth =
    !!normalizeOptionalSecret(globals.cookie) ||
    !!normalizeOptionalSecret(globals.bearer) ||
    !!normalizeOptionalSecret(globals.apiKey) ||
    !!normalizeSecretValue(globals.hubPassword) ||
    !!normalizeOptionalSecret(process.env.COCALC_BEARER_TOKEN) ||
    !!normalizeOptionalSecret(process.env.COCALC_API_KEY) ||
    !!normalizeSecretValue(process.env.COCALC_HUB_PASSWORD);
  if (hasExplicitAuth) return globals;

  let hostname = "";
  try {
    hostname = new URL(apiBaseUrl).hostname;
  } catch {
    return globals;
  }
  if (!isLoopbackHostName(hostname)) return globals;

  const info = loadLiteConnectionInfo();
  if (!info?.agent_token?.trim()) return globals;
  if (!matchesLiteConnection({ apiBaseUrl, info })) return globals;

  const next = {
    ...globals,
    bearer: info.agent_token.trim(),
  };
  const account_id = `${info.account_id ?? ""}`.trim();
  if (!getExplicitAccountId(next) && isValidUUID(account_id)) {
    next.accountId = account_id;
  }
  return next;
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
  let effectiveGlobals = applied.globals as GlobalOptions;

  const timeoutMs = durationToMs(effectiveGlobals.timeout, 600_000);
  const rpcTimeoutMs = Math.max(
    1_000,
    Math.min(timeoutMs, durationToMs(effectiveGlobals.rpcTimeout, MAX_TRANSPORT_TIMEOUT_MS)),
  );
  const pollMs = durationToMs(effectiveGlobals.pollMs, 1_000);
  const apiBaseUrl = effectiveGlobals.api ? normalizeUrl(effectiveGlobals.api) : defaultApiBaseUrl();
  effectiveGlobals = maybeApplyLiteAgentAuth({
    globals: effectiveGlobals,
    apiBaseUrl,
  });
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

const {
  expandUserPath,
  normalizeSyncKeyBasePath,
  syncKeyPublicPath,
  normalizeWorkspaceSshConfigPath,
  normalizeWorkspaceSshHostAlias,
  workspaceSshConfigBlockMarkers,
  removeWorkspaceSshConfigBlock,
  readSyncPublicKey,
  ensureSyncKeyPair,
  installSyncPublicKey,
  resolveWorkspaceSshTarget,
  resolveWorkspaceSshConnection,
  runReflectSyncCli,
  listReflectForwards,
  parseCreatedForwardId,
  forwardsForWorkspace,
  formatReflectForwardRow,
  terminateReflectForwards,
  reflectSyncHomeDir,
  reflectSyncSessionDbPath,
} = createWorkspaceSyncOps<CommandContext, WorkspaceRow>({
  resolveWorkspaceFilesystem,
  resolveWorkspaceFromArgOrContext,
  parseSshServer,
  authConfigPath,
  resolveModule: (specifier) => requireCjs.resolve(specifier),
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
const { waitForHostCreateReady, resolveHostSshEndpoint } =
  createHostHelpers<CommandContext, HostRow>({
    listHosts,
    resolveHost,
    parseSshServer,
    cliDebug,
  });

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

const { serveDaemon, runDaemonRequestFromCommand } =
  createDaemonServerOps<CommandContext>({
    daemonContextKey,
    contextForGlobals,
    closeCommandContext,
    globalsFrom,
    daemonContextMeta: (ctx) => ({
      api: ctx.apiBaseUrl,
      account_id: ctx.accountId,
    }),
    workspaceFileListData,
    workspaceFileCatData,
    workspaceFilePutData,
    workspaceFileGetData,
    workspaceFileRmData,
    workspaceFileMkdirData,
    workspaceFileRgData,
    workspaceFileFdData,
  });

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
        await runProductCommand(spec, args ?? [], {
          commandExists,
          runCommand,
        });
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

const browserCommandDeps = {
  withContext,
  authConfigPath,
  loadAuthConfig,
  saveAuthConfig,
  selectedProfileName,
  globalsFrom,
  resolveWorkspace,
  createBrowserSessionClient,
} satisfies BrowserCommandDeps;

registerBrowserCommand(program, browserCommandDeps);

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
        await runProductCommand(spec, process.argv.slice(3), {
          commandExists,
          runCommand,
        });
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
