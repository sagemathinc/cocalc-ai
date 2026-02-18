#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir as mkdirLocal, readFile as readFileLocal, writeFile as writeFileLocal } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createNetServer, createConnection as createNetConnection, type Server as NetServer } from "node:net";
import { homedir, hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
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
import { acpSubject } from "@cocalc/conat/ai/acp/server";
import type { AcpRequest, AcpStreamMessage } from "@cocalc/conat/ai/acp/types";
import { FALLBACK_ACCOUNT_UUID, basePathCookieName, isValidUUID } from "@cocalc/util/misc";
import type { CodexReasoningId, CodexSessionConfig, CodexSessionMode } from "@cocalc/util/ai/codex";
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

type DaemonAction =
  | "ping"
  | "shutdown"
  | "workspace.file.list"
  | "workspace.file.cat"
  | "workspace.file.put"
  | "workspace.file.get"
  | "workspace.file.rm"
  | "workspace.file.mkdir"
  | "workspace.file.rg"
  | "workspace.file.fd";

type DaemonRequest = {
  id: string;
  action: DaemonAction;
  cwd?: string;
  globals?: GlobalOptions;
  payload?: Record<string, unknown>;
};

type DaemonResponse = {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  meta?: {
    api?: string | null;
    account_id?: string | null;
    pid?: number;
    uptime_s?: number;
    started_at?: string;
  };
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
const PROJECT_HOST_TOKEN_TTL_LEEWAY_MS = 60_000;
const WORKSPACE_CACHE_TTL_MS = 15_000;
const HOST_CONNECTION_CACHE_TTL_MS = 15_000;
const DAEMON_CONNECT_TIMEOUT_MS = 3_000;
const DAEMON_RPC_TIMEOUT_MS = 30_000;

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

function daemonRuntimeDir(env = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  if (runtime) {
    return join(runtime, "cocalc");
  }
  const cache = env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(cache, "cocalc");
}

function daemonSocketPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.sock`);
}

function daemonPidPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.pid`);
}

function daemonLogPath(env = process.env): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return join(daemonRuntimeDir(env), `cli-daemon-${uid}.log`);
}

function daemonSpawnTarget(): { cmd: string; args: string[] } {
  const scriptPath = process.argv[1];
  if (scriptPath && existsSync(scriptPath)) {
    return { cmd: process.execPath, args: [scriptPath] };
  }
  return { cmd: process.execPath, args: [] };
}

function daemonRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readDaemonPid(path = daemonPidPath()): number | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

function isDaemonTransportError(err: unknown): boolean {
  const code = `${(err as any)?.code ?? ""}`.toUpperCase();
  const msg = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    msg.includes("daemon transport") ||
    msg.includes("daemon timeout")
  );
}

async function sendDaemonRequest({
  request,
  socketPath = daemonSocketPath(),
  timeoutMs = DAEMON_RPC_TIMEOUT_MS,
}: {
  request: DaemonRequest;
  socketPath?: string;
  timeoutMs?: number;
}): Promise<DaemonResponse> {
  return await new Promise<DaemonResponse>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const socket = createNetConnection(socketPath);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        // ignore
      }
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      fn();
    };

    const timer = setTimeout(() => {
      const err: any = new Error(`daemon timeout after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      done(() => reject(err));
    }, timeoutMs);

    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        done(() => reject(err));
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let parsed: DaemonResponse;
        try {
          parsed = JSON.parse(line) as DaemonResponse;
        } catch (err) {
          clearTimeout(timer);
          done(() => reject(err));
          return;
        }
        if (parsed.id !== request.id) {
          continue;
        }
        clearTimeout(timer);
        done(() => resolve(parsed));
        return;
      }
    });

    socket.on("error", (err: any) => {
      clearTimeout(timer);
      err.message = `daemon transport error: ${err?.message ?? err}`;
      done(() => reject(err));
    });

    socket.on("close", () => {
      if (settled) return;
      clearTimeout(timer);
      const err: any = new Error("daemon transport closed before response");
      err.code = "ECONNRESET";
      done(() => reject(err));
    });
  });
}

async function pingDaemon(socketPath = daemonSocketPath()): Promise<DaemonResponse> {
  return await sendDaemonRequest({
    socketPath,
    timeoutMs: DAEMON_CONNECT_TIMEOUT_MS,
    request: {
      id: daemonRequestId(),
      action: "ping",
    },
  });
}

async function startDaemonProcess({
  socketPath = daemonSocketPath(),
  timeoutMs = 8_000,
}: {
  socketPath?: string;
  timeoutMs?: number;
} = {}): Promise<{ started: boolean; pid?: number; already_running?: boolean }> {
  try {
    const pong = await pingDaemon(socketPath);
    return {
      started: true,
      pid: pong.meta?.pid,
      already_running: true,
    };
  } catch {
    // not running
  }

  mkdirSync(dirname(socketPath), { recursive: true });
  const { cmd, args } = daemonSpawnTarget();
  const daemonArgs = [...args, "daemon", "serve", "--socket", socketPath];
  const child = spawn(cmd, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COCALC_CLI_DAEMON_MODE: "1",
    },
  });
  child.unref();

  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const pong = await pingDaemon(socketPath);
      return {
        started: true,
        pid: pong.meta?.pid,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `daemon did not become ready in ${timeoutMs}ms: ${
      lastErr instanceof Error ? lastErr.message : `${lastErr ?? "unknown"}`
    }`,
  );
}

async function daemonRequestWithAutoStart(
  request: DaemonRequest,
  {
    timeoutMs = DAEMON_RPC_TIMEOUT_MS,
  }: {
    timeoutMs?: number;
  } = {},
): Promise<DaemonResponse> {
  const socketPath = daemonSocketPath();
  try {
    return await sendDaemonRequest({ request, socketPath, timeoutMs });
  } catch (err) {
    if (!isDaemonTransportError(err)) {
      throw err;
    }
    await startDaemonProcess({ socketPath });
    return await sendDaemonRequest({ request, socketPath, timeoutMs });
  }
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
    routedProjectHostClients: {},
    workspaceCache: new Map(),
    hostConnectionCache: new Map(),
  };
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

function workspaceCacheKey(identifier: string): string {
  const value = identifier.trim();
  if (isValidUUID(value)) {
    return `id:${value.toLowerCase()}`;
  }
  return `title:${value}`;
}

function getCachedWorkspace(
  ctx: CommandContext,
  identifier: string,
): WorkspaceRow | undefined {
  const key = workspaceCacheKey(identifier);
  const cached = ctx.workspaceCache.get(key);
  if (!cached) return undefined;
  if (Date.now() >= cached.expiresAt) {
    ctx.workspaceCache.delete(key);
    return undefined;
  }
  return cached.workspace;
}

function setCachedWorkspace(
  ctx: CommandContext,
  workspace: WorkspaceRow,
): void {
  const expiresAt = Date.now() + WORKSPACE_CACHE_TTL_MS;
  ctx.workspaceCache.set(workspaceCacheKey(workspace.project_id), { workspace, expiresAt });
  if (workspace.title) {
    ctx.workspaceCache.set(workspaceCacheKey(workspace.title), { workspace, expiresAt });
  }
}

async function resolveWorkspace(ctx: CommandContext, identifier: string): Promise<WorkspaceRow> {
  const cached = getCachedWorkspace(ctx, identifier);
  if (cached) {
    return cached;
  }

  if (isValidUUID(identifier)) {
    const rows = await queryProjects({
      ctx,
      project_id: identifier,
      limit: 3,
    });
    if (rows[0]) {
      setCachedWorkspace(ctx, rows[0]);
      return rows[0];
    }
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
  setCachedWorkspace(ctx, rows[0]);
  return rows[0];
}

async function resolveWorkspaceFromArgOrContext(
  ctx: CommandContext,
  identifier?: string,
  cwd = process.cwd(),
): Promise<WorkspaceRow> {
  const value = identifier?.trim();
  if (value) {
    return await resolveWorkspace(ctx, value);
  }
  const context = readWorkspaceContext(cwd);
  if (!context?.workspace_id) {
    throw new Error(
      `missing --workspace and no workspace context is set at ${workspaceContextPath(cwd)}; run 'cocalc ws use --workspace <workspace>'`,
    );
  }
  return await resolveWorkspace(ctx, context.workspace_id);
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

function localProxyProjectHostAddress(apiBaseUrl: string, host_id: string): string {
  const url = new URL(normalizeUrl(apiBaseUrl));
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${host_id}`.replace(/\/+/g, "/");
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
    const issued = await hubCallAccount<{ host_id: string; token: string; expires_at: number }>(
      ctx,
      "hosts.issueProjectHostAuthToken",
      [
        {
          host_id: state.host_id,
          project_id,
        },
      ],
    );
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
    connection = await hubCallAccount<HostConnectionInfo>(ctx, "hosts.resolveHostConnection", [
      { host_id },
    ]);
    ctx.hostConnectionCache.set(host_id, {
      connection,
      expiresAt: Date.now() + HOST_CONNECTION_CACHE_TTL_MS,
    });
  }
  const address = connection.local_proxy
    ? localProxyProjectHostAddress(ctx.apiBaseUrl, host_id)
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
  const routed = connectConat({
    address,
    noCache: true,
    reconnection: false,
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
  const rpcTimeoutMs = Math.min(timeoutMs, MAX_TRANSPORT_TIMEOUT_MS);
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

function parseCodexReasoning(value?: string): CodexReasoningId | undefined {
  if (!value?.trim()) return undefined;
  const reasoning = value.trim().toLowerCase();
  if (
    reasoning === "low" ||
    reasoning === "medium" ||
    reasoning === "high" ||
    reasoning === "extra_high"
  ) {
    return reasoning;
  }
  throw new Error(
    `invalid --reasoning '${value}'; expected low|medium|high|extra_high`,
  );
}

function parseCodexSessionMode(value?: string): CodexSessionMode | undefined {
  if (!value?.trim()) return undefined;
  const mode = value.trim().toLowerCase();
  if (
    mode === "auto" ||
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    return mode;
  }
  throw new Error(
    `invalid --session-mode '${value}'; expected auto|read-only|workspace-write|full-access`,
  );
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildCodexSessionConfig(opts: {
  model?: string;
  reasoning?: string;
  sessionMode?: string;
  workdir?: string;
}): CodexSessionConfig | undefined {
  const config: CodexSessionConfig = {};
  if (opts.model?.trim()) {
    config.model = opts.model.trim();
  }
  const reasoning = parseCodexReasoning(opts.reasoning);
  if (reasoning) {
    config.reasoning = reasoning;
  }
  const sessionMode = parseCodexSessionMode(opts.sessionMode);
  if (sessionMode) {
    config.sessionMode = sessionMode;
  }
  if (opts.workdir?.trim()) {
    config.workingDirectory = opts.workdir.trim();
  }
  return Object.keys(config).length ? config : undefined;
}

type WorkspaceCodexExecResult = {
  workspace_id: string;
  session_id: string | null;
  thread_id: string | null;
  final_response: string;
  usage: Record<string, unknown> | null;
  last_seq: number;
  event_count: number;
  event_types: Record<string, number>;
  duration_ms: number;
};

async function workspaceCodexExecData({
  ctx,
  workspaceIdentifier,
  prompt,
  sessionId,
  config,
  onMessage,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  prompt: string;
  sessionId?: string;
  config?: CodexSessionConfig;
  onMessage?: (message: AcpStreamMessage) => Promise<void> | void;
  cwd?: string;
}): Promise<WorkspaceCodexExecResult> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const routed = await getOrCreateRoutedProjectHostClient(ctx, workspace);
  if (!routed.client) {
    throw new Error(`internal error: routed client missing for host ${routed.host_id}`);
  }

  const request: AcpRequest = {
    project_id: workspace.project_id,
    account_id: ctx.accountId,
    prompt,
    ...(sessionId?.trim() ? { session_id: sessionId.trim() } : undefined),
    ...(config ? { config } : undefined),
  };
  const subject = acpSubject({ project_id: workspace.project_id });
  const startedAt = Date.now();
  const maxWait = Math.max(1_000, ctx.timeoutMs);

  let lastSeq = -1;
  let lastType: string | null = null;
  let eventCount = 0;
  const eventTypes: Record<string, number> = {};
  let usage: Record<string, unknown> | null = null;
  let finalResponse = "";
  let threadId: string | null = null;
  let sawSummary = false;
  let sawAnyMessage = false;

  const responses = await routed.client.requestMany(subject, request, {
    maxWait,
  });
  for await (const resp of responses) {
    if (resp.data == null) break;
    const message = resp.data as AcpStreamMessage;
    sawAnyMessage = true;
    lastType = `${(message as any)?.type ?? "unknown"}`;
    if (typeof message.seq === "number") {
      if (message.seq !== lastSeq + 1) {
        throw new Error("missed codex stream response");
      }
      lastSeq = message.seq;
    }
    if (onMessage) {
      await onMessage(message);
    }
    if (message.type === "error") {
      throw new Error(message.error || "codex exec failed");
    }
    if (message.type === "usage") {
      usage = ((message as any).usage ?? null) as Record<string, unknown> | null;
      continue;
    }
    if (message.type === "event") {
      eventCount += 1;
      const eventType = `${(message as any)?.event?.type ?? "unknown"}`;
      eventTypes[eventType] = (eventTypes[eventType] ?? 0) + 1;
      continue;
    }
    if (message.type === "summary") {
      sawSummary = true;
      finalResponse = `${message.finalResponse ?? ""}`;
      threadId = typeof message.threadId === "string" ? message.threadId : null;
      usage = ((message as any).usage ?? usage ?? null) as Record<string, unknown> | null;
    }
  }

  if (!sawSummary) {
    if (sawAnyMessage) {
      throw new Error(
        `codex exec ended before summary (last_type=${lastType ?? "unknown"}, last_seq=${lastSeq}); likely timed out waiting for completion -- try --stream and/or increase --timeout`,
      );
    }
    throw new Error(
      "codex exec returned no stream messages; check project-host ACP availability and routing",
    );
  }

  return {
    workspace_id: workspace.project_id,
    session_id: sessionId?.trim() || null,
    thread_id: threadId,
    final_response: finalResponse,
    usage,
    last_seq: lastSeq,
    event_count: eventCount,
    event_types: eventTypes,
    duration_ms: Date.now() - startedAt,
  };
}

function streamCodexHumanMessage(message: AcpStreamMessage): void {
  if (message.type === "status") {
    process.stderr.write(`[codex:${message.state}]\n`);
    return;
  }
  if (message.type === "event") {
    const event = (message as any).event;
    const kind = `${event?.type ?? "event"}`;
    if ((kind === "thinking" || kind === "message") && typeof event?.text === "string") {
      process.stderr.write(event.text);
      if (!event.text.endsWith("\n")) {
        process.stderr.write("\n");
      }
      return;
    }
    if (kind === "terminal") {
      const phase = `${event?.phase ?? "unknown"}`;
      const terminalId = `${event?.terminalId ?? "terminal"}`;
      if (phase === "data" && typeof event?.chunk === "string" && event.chunk.length > 0) {
        process.stderr.write(event.chunk);
        if (!event.chunk.endsWith("\n")) {
          process.stderr.write("\n");
        }
        return;
      }
      process.stderr.write(`[codex:terminal:${phase}] ${terminalId}\n`);
      return;
    }
    if (kind === "file") {
      process.stderr.write(
        `[codex:file] ${event?.operation ?? "op"} ${event?.path ?? ""}\n`,
      );
      return;
    }
    if (kind === "diff") {
      process.stderr.write(`[codex:diff] ${event?.path ?? ""}\n`);
      return;
    }
    process.stderr.write(`[codex:event] ${kind}\n`);
    return;
  }
  if (message.type === "usage") {
    const usage = (message as any).usage ?? {};
    process.stderr.write(`[codex:usage] ${JSON.stringify(usage)}\n`);
    return;
  }
  if (message.type === "summary") {
    process.stderr.write("[codex:summary]\n");
    return;
  }
  if (message.type === "error") {
    process.stderr.write(`[codex:error] ${message.error ?? "unknown error"}\n`);
  }
}

async function workspaceCodexAuthStatusData({
  ctx,
  workspaceIdentifier,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const [paymentSource, keyStatus, subscriptionCreds] = await Promise.all([
    hubCallAccount<any>(ctx, "system.getCodexPaymentSource", [
      { project_id: workspace.project_id },
    ]),
    hubCallAccount<any>(ctx, "system.getOpenAiApiKeyStatus", [
      { project_id: workspace.project_id },
    ]),
    hubCallAccount<any[]>(ctx, "system.listExternalCredentials", [
      {
        provider: "openai",
        kind: "codex-subscription-auth-json",
        scope: "account",
      },
    ]),
  ]);

  return {
    workspace_id: workspace.project_id,
    workspace_title: workspace.title,
    payment_source: paymentSource?.source ?? "none",
    has_subscription: !!paymentSource?.hasSubscription,
    has_workspace_api_key: !!paymentSource?.hasProjectApiKey,
    has_account_api_key: !!paymentSource?.hasAccountApiKey,
    has_site_api_key: !!paymentSource?.hasSiteApiKey,
    shared_home_mode: paymentSource?.sharedHomeMode ?? null,
    account_api_key_configured: !!keyStatus?.account,
    account_api_key_updated: toIso(keyStatus?.account?.updated),
    account_api_key_last_used: toIso(keyStatus?.account?.last_used),
    workspace_api_key_configured: !!keyStatus?.project,
    workspace_api_key_updated: toIso(keyStatus?.project?.updated),
    workspace_api_key_last_used: toIso(keyStatus?.project?.last_used),
    subscription_credentials_count: Array.isArray(subscriptionCreds)
      ? subscriptionCreds.length
      : 0,
  };
}

type WorkspaceCodexDeviceAuthStatus = {
  id: string;
  state: "pending" | "completed" | "failed" | "canceled";
  verificationUrl?: string;
  userCode?: string;
  output?: string;
  startedAt?: number;
  updatedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
};

function summarizeCodexDeviceAuth(
  workspace: WorkspaceRow,
  status: WorkspaceCodexDeviceAuthStatus,
): Record<string, unknown> {
  return {
    workspace_id: workspace.project_id,
    workspace_title: workspace.title,
    auth_id: status.id,
    state: status.state,
    verification_url: status.verificationUrl ?? null,
    user_code: status.userCode ?? null,
    started_at: status.startedAt ? new Date(status.startedAt).toISOString() : null,
    updated_at: status.updatedAt ? new Date(status.updatedAt).toISOString() : null,
    exit_code: status.exitCode ?? null,
    signal: status.signal ?? null,
    error: status.error ?? null,
    output: status.output ?? "",
  };
}

async function workspaceCodexDeviceAuthStartData({
  ctx,
  workspaceIdentifier,
  wait,
  pollMs,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  wait: boolean;
  pollMs: number;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  let status = await projectHostHubCallAccount<WorkspaceCodexDeviceAuthStatus>(
    ctx,
    workspace,
    "projects.codexDeviceAuthStart",
    [{ project_id: workspace.project_id }],
  );

  if (wait && status.state === "pending") {
    const deadline = Date.now() + ctx.timeoutMs;
    while (status.state === "pending") {
      if (Date.now() >= deadline) {
        throw new Error(
          `timeout waiting for codex device auth completion (id=${status.id})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      status = await projectHostHubCallAccount<WorkspaceCodexDeviceAuthStatus>(
        ctx,
        workspace,
        "projects.codexDeviceAuthStatus",
        [{ project_id: workspace.project_id, id: status.id }],
      );
    }
  }

  return summarizeCodexDeviceAuth(workspace, status);
}

async function workspaceCodexDeviceAuthStatusData({
  ctx,
  workspaceIdentifier,
  id,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  id: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const status = await projectHostHubCallAccount<WorkspaceCodexDeviceAuthStatus>(
    ctx,
    workspace,
    "projects.codexDeviceAuthStatus",
    [{ project_id: workspace.project_id, id }],
  );
  return summarizeCodexDeviceAuth(workspace, status);
}

async function workspaceCodexDeviceAuthCancelData({
  ctx,
  workspaceIdentifier,
  id,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  id: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const canceled = await projectHostHubCallAccount<{ id: string; canceled: boolean }>(
    ctx,
    workspace,
    "projects.codexDeviceAuthCancel",
    [{ project_id: workspace.project_id, id }],
  );
  const status = await projectHostHubCallAccount<WorkspaceCodexDeviceAuthStatus>(
    ctx,
    workspace,
    "projects.codexDeviceAuthStatus",
    [{ project_id: workspace.project_id, id }],
  );
  return {
    ...summarizeCodexDeviceAuth(workspace, status),
    canceled: canceled.canceled,
  };
}

async function workspaceCodexAuthUploadFileData({
  ctx,
  workspaceIdentifier,
  localPath,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  localPath: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier, cwd);
  const content = await readFileLocal(localPath, "utf8");
  const uploaded = await projectHostHubCallAccount<{
    ok: true;
    codexHome: string;
    bytes: number;
    synced?: boolean;
  }>(ctx, workspace, "projects.codexUploadAuthFile", [
    {
      project_id: workspace.project_id,
      filename: basename(localPath),
      content,
    },
  ]);
  return {
    workspace_id: workspace.project_id,
    workspace_title: workspace.title,
    uploaded: uploaded.ok,
    bytes: uploaded.bytes,
    codex_home: uploaded.codexHome,
    synced: uploaded.synced ?? null,
  };
}

async function workspaceFileListData({
  ctx,
  workspaceIdentifier,
  path,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  path?: string;
  cwd?: string;
}): Promise<Array<Record<string, unknown>>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
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
}

async function workspaceFileCatData({
  ctx,
  workspaceIdentifier,
  path,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  path: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  const content = String(await fs.readFile(path, "utf8"));
  return {
    workspace_id: workspace.project_id,
    path,
    content,
    bytes: Buffer.byteLength(content),
  };
}

async function workspaceFilePutData({
  ctx,
  workspaceIdentifier,
  dest,
  data,
  parents,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  dest: string;
  data: Buffer;
  parents: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  if (parents) {
    await fs.mkdir(dirname(dest), { recursive: true });
  }
  await fs.writeFile(dest, data);
  return {
    workspace_id: workspace.project_id,
    dest,
    bytes: data.length,
    status: "uploaded",
  };
}

async function workspaceFileGetData({
  ctx,
  workspaceIdentifier,
  src,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  src: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  const data = await fs.readFile(src);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  return {
    workspace_id: workspace.project_id,
    src,
    bytes: buffer.length,
    content_base64: buffer.toString("base64"),
    status: "downloaded",
  };
}

async function workspaceFileRmData({
  ctx,
  workspaceIdentifier,
  path,
  recursive,
  force,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  path: string;
  recursive: boolean;
  force: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  await fs.rm(path, {
    recursive,
    force,
  });
  return {
    workspace_id: workspace.project_id,
    path,
    recursive,
    force,
    status: "removed",
  };
}

async function workspaceFileMkdirData({
  ctx,
  workspaceIdentifier,
  path,
  parents,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  path: string;
  parents: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  await fs.mkdir(path, { recursive: parents });
  return {
    workspace_id: workspace.project_id,
    path,
    parents,
    status: "created",
  };
}

async function workspaceFileRgData({
  ctx,
  workspaceIdentifier,
  pattern,
  path,
  timeoutMs,
  maxBytes,
  options,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  pattern: string;
  path?: string;
  timeoutMs: number;
  maxBytes: number;
  options?: string[];
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  const result = await fs.ripgrep(path?.trim() || ".", pattern, {
    options,
    timeout: timeoutMs,
    maxSize: maxBytes,
  });
  const stdout = asUtf8((result as any)?.stdout);
  const stderr = asUtf8((result as any)?.stderr);
  const exit_code = normalizeProcessExitCode((result as any)?.code, stdout, stderr);
  return {
    workspace_id: workspace.project_id,
    path: path?.trim() || ".",
    pattern,
    stdout,
    stderr,
    exit_code,
    truncated: normalizeBoolean((result as any)?.truncated),
  };
}

async function workspaceFileFdData({
  ctx,
  workspaceIdentifier,
  pattern,
  path,
  timeoutMs,
  maxBytes,
  options,
  cwd,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  pattern?: string;
  path?: string;
  timeoutMs: number;
  maxBytes: number;
  options?: string[];
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const { workspace, fs } = await resolveWorkspaceFilesystem(ctx, workspaceIdentifier, cwd);
  const result = await fs.fd(path?.trim() || ".", {
    pattern: pattern?.trim() || undefined,
    options,
    timeout: timeoutMs,
    maxSize: maxBytes,
  });
  const stdout = asUtf8((result as any)?.stdout);
  const stderr = asUtf8((result as any)?.stderr);
  const exit_code = normalizeProcessExitCode((result as any)?.code, stdout, stderr);
  return {
    workspace_id: workspace.project_id,
    path: path?.trim() || ".",
    pattern: pattern?.trim() || null,
    stdout,
    stderr,
    exit_code,
    truncated: normalizeBoolean((result as any)?.truncated),
  };
}

type WorkspaceFileCheckResult = {
  step: string;
  status: "ok" | "fail" | "skip";
  duration_ms: number;
  detail: string;
};

type WorkspaceFileCheckReport = {
  ok: boolean;
  workspace_id: string;
  workspace_title: string;
  temp_path: string;
  kept: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: WorkspaceFileCheckResult[];
};

type WorkspaceFileCheckBenchRun = {
  run: number;
  ok: boolean;
  duration_ms: number;
  passed: number;
  failed: number;
  skipped: number;
  temp_path: string;
  first_failure: string | null;
};

type WorkspaceFileCheckBenchStepStat = {
  step: string;
  runs: number;
  ok: number;
  fail: number;
  skip: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
};

type WorkspaceFileCheckBenchReport = {
  ok: boolean;
  workspace_id: string;
  workspace_title: string;
  runs: number;
  ok_runs: number;
  failed_runs: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  min_duration_ms: number;
  max_duration_ms: number;
  run_results: WorkspaceFileCheckBenchRun[];
  step_stats: WorkspaceFileCheckBenchStepStat[];
};

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null || `${value}`.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeWorkspacePathPrefix(value: string | undefined): string {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return ".cocalc-cli-check";
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed || ".cocalc-cli-check";
}

function joinWorkspacePath(...parts: string[]): string {
  const normalized = parts
    .map((x) => `${x}`.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^\/+/, "").replace(/\/+$/, ""))
    .filter(Boolean);
  return normalized.join("/");
}

function assertWorkspaceCheck(
  condition: unknown,
  message: string,
): void {
  if (!condition) throw new Error(message);
}

async function runWorkspaceFileCheck({
  ctx,
  workspaceIdentifier,
  pathPrefix,
  timeoutMs,
  maxBytes,
  keep,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  pathPrefix?: string;
  timeoutMs: number;
  maxBytes: number;
  keep: boolean;
}): Promise<WorkspaceFileCheckReport> {
  const workspace = await resolveWorkspaceFromArgOrContext(ctx, workspaceIdentifier);
  const prefix = normalizeWorkspacePathPrefix(pathPrefix);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = joinWorkspacePath(prefix, runId);
  const fileName = "probe.txt";
  const filePath = joinWorkspacePath(tempPath, fileName);
  const marker = `cocalc-cli-check-${runId}`;
  const content = `${marker}\n`;
  const results: WorkspaceFileCheckResult[] = [];

  const record = async <T>(
    step: string,
    fn: () => Promise<T>,
    onSuccess?: (value: T) => string,
  ): Promise<T | undefined> => {
    const started = Date.now();
    try {
      const value = await fn();
      results.push({
        step,
        status: "ok",
        duration_ms: Date.now() - started,
        detail: onSuccess ? onSuccess(value) : "ok",
      });
      return value;
    } catch (err) {
      results.push({
        step,
        status: "fail",
        duration_ms: Date.now() - started,
        detail: err instanceof Error ? err.message : `${err}`,
      });
      return undefined;
    }
  };

  await record(
    "mkdir",
    async () =>
      await workspaceFileMkdirData({
        ctx,
        workspaceIdentifier: workspace.project_id,
        path: tempPath,
        parents: true,
      }),
    () => `created ${tempPath}`,
  );

  await record(
    "put",
    async () =>
      await workspaceFilePutData({
        ctx,
        workspaceIdentifier: workspace.project_id,
        dest: filePath,
        data: Buffer.from(content),
        parents: true,
      }),
    (value: any) => `uploaded ${value?.bytes ?? Buffer.byteLength(content)} bytes`,
  );

  await record("list", async () => {
    const rows = await workspaceFileListData({
      ctx,
      workspaceIdentifier: workspace.project_id,
      path: tempPath,
    });
    assertWorkspaceCheck(
      rows.some((row) => `${row.name ?? ""}` === fileName),
      `expected '${fileName}' in directory listing`,
    );
    return rows;
  }, () => `found ${fileName}`);

  await record("cat", async () => {
    const data = await workspaceFileCatData({
      ctx,
      workspaceIdentifier: workspace.project_id,
      path: filePath,
    });
    assertWorkspaceCheck(
      `${data.content ?? ""}` === content,
      "cat content mismatch",
    );
    return data;
  }, () => `read ${filePath}`);

  await record("get", async () => {
    const data = await workspaceFileGetData({
      ctx,
      workspaceIdentifier: workspace.project_id,
      src: filePath,
    });
    const decoded = Buffer.from(`${data.content_base64 ?? ""}`, "base64").toString("utf8");
    assertWorkspaceCheck(decoded === content, "get content mismatch");
    return data;
  }, () => `downloaded ${filePath}`);

  await record("rg", async () => {
    const data = await workspaceFileRgData({
      ctx,
      workspaceIdentifier: workspace.project_id,
      pattern: marker,
      path: tempPath,
      timeoutMs,
      maxBytes,
      options: ["-F"],
    });
    assertWorkspaceCheck(
      Number(data.exit_code ?? 1) === 0,
      `rg exit_code=${data.exit_code ?? "unknown"}`,
    );
    assertWorkspaceCheck(
      `${data.stdout ?? ""}`.includes(fileName),
      `rg output missing '${fileName}'`,
    );
    return data;
  }, () => `matched ${fileName}`);

  await record("fd", async () => {
    const data = await workspaceFileFdData({
      ctx,
      workspaceIdentifier: workspace.project_id,
      pattern: fileName,
      path: tempPath,
      timeoutMs,
      maxBytes,
    });
    assertWorkspaceCheck(
      Number(data.exit_code ?? 1) === 0,
      `fd exit_code=${data.exit_code ?? "unknown"}`,
    );
    assertWorkspaceCheck(
      `${data.stdout ?? ""}`.includes(fileName),
      `fd output missing '${fileName}'`,
    );
    return data;
  }, () => `matched ${fileName}`);

  if (keep) {
    results.push({
      step: "rm",
      status: "skip",
      duration_ms: 0,
      detail: "skipped (--keep)",
    });
  } else {
    await record(
      "rm",
      async () =>
        await workspaceFileRmData({
          ctx,
          workspaceIdentifier: workspace.project_id,
          path: tempPath,
          recursive: true,
          force: true,
        }),
      () => `removed ${tempPath}`,
    );
  }

  if (!keep) {
    // Best-effort cleanup if rm check failed earlier.
    try {
      await workspaceFileRmData({
        ctx,
        workspaceIdentifier: workspace.project_id,
        path: tempPath,
        recursive: true,
        force: true,
      });
    } catch {
      // ignore cleanup errors
    }
  }

  const passed = results.filter((x) => x.status === "ok").length;
  const failed = results.filter((x) => x.status === "fail").length;
  const skipped = results.filter((x) => x.status === "skip").length;
  return {
    ok: failed === 0,
    workspace_id: workspace.project_id,
    workspace_title: workspace.title,
    temp_path: tempPath,
    kept: keep,
    total: results.length,
    passed,
    failed,
    skipped,
    results,
  };
}

async function runWorkspaceFileCheckBench({
  ctx,
  workspaceIdentifier,
  pathPrefix,
  timeoutMs,
  maxBytes,
  keep,
  runs,
}: {
  ctx: CommandContext;
  workspaceIdentifier?: string;
  pathPrefix?: string;
  timeoutMs: number;
  maxBytes: number;
  keep: boolean;
  runs: number;
}): Promise<WorkspaceFileCheckBenchReport> {
  const runResults: WorkspaceFileCheckBenchRun[] = [];
  const stepStats = new Map<
    string,
    {
      runs: number;
      ok: number;
      fail: number;
      skip: number;
      totalMs: number;
      minMs: number;
      maxMs: number;
    }
  >();

  let workspaceId = "";
  let workspaceTitle = "";

  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    const report = await runWorkspaceFileCheck({
      ctx,
      workspaceIdentifier,
      pathPrefix,
      timeoutMs,
      maxBytes,
      keep,
    });
    const durationMs = Date.now() - started;
    workspaceId = report.workspace_id;
    workspaceTitle = report.workspace_title;

    const firstFailure = report.results.find((x) => x.status === "fail");
    runResults.push({
      run,
      ok: report.ok,
      duration_ms: durationMs,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      temp_path: report.temp_path,
      first_failure: firstFailure ? `${firstFailure.step}: ${firstFailure.detail}` : null,
    });

    for (const row of report.results) {
      if (!stepStats.has(row.step)) {
        stepStats.set(row.step, {
          runs: 0,
          ok: 0,
          fail: 0,
          skip: 0,
          totalMs: 0,
          minMs: Number.POSITIVE_INFINITY,
          maxMs: 0,
        });
      }
      const stats = stepStats.get(row.step)!;
      stats.runs += 1;
      if (row.status === "ok") stats.ok += 1;
      if (row.status === "fail") stats.fail += 1;
      if (row.status === "skip") stats.skip += 1;
      stats.totalMs += row.duration_ms;
      stats.minMs = Math.min(stats.minMs, row.duration_ms);
      stats.maxMs = Math.max(stats.maxMs, row.duration_ms);
    }
  }

  const totalDurationMs = runResults.reduce((sum, row) => sum + row.duration_ms, 0);
  const okRuns = runResults.filter((x) => x.ok).length;
  const failedRuns = runResults.length - okRuns;
  const minDurationMs =
    runResults.length > 0 ? Math.min(...runResults.map((x) => x.duration_ms)) : 0;
  const maxDurationMs =
    runResults.length > 0 ? Math.max(...runResults.map((x) => x.duration_ms)) : 0;

  const aggregatedSteps: WorkspaceFileCheckBenchStepStat[] = Array.from(stepStats.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([step, stats]) => ({
      step,
      runs: stats.runs,
      ok: stats.ok,
      fail: stats.fail,
      skip: stats.skip,
      avg_ms: stats.runs ? Math.round(stats.totalMs / stats.runs) : 0,
      min_ms: Number.isFinite(stats.minMs) ? stats.minMs : 0,
      max_ms: stats.maxMs,
    }));

  return {
    ok: failedRuns === 0,
    workspace_id: workspaceId,
    workspace_title: workspaceTitle,
    runs: runResults.length,
    ok_runs: okRuns,
    failed_runs: failedRuns,
    total_duration_ms: totalDurationMs,
    avg_duration_ms: runResults.length
      ? Math.round(totalDurationMs / runResults.length)
      : 0,
    min_duration_ms: minDurationMs,
    max_duration_ms: maxDurationMs,
    run_results: runResults,
    step_stats: aggregatedSteps,
  };
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
  const connection = await hubCallAccount<HostConnectionInfo>(ctx, "hosts.resolveHostConnection", [
    { host_id: workspace.host_id },
  ]);
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

const daemon = program.command("daemon").description("manage local cocalc-cli daemon");

daemon
  .command("start")
  .description("start daemon if not already running")
  .action(async (command: Command) => {
    await runLocalCommand(command, "daemon start", async () => {
      const result = await startDaemonProcess();
      return {
        socket: daemonSocketPath(),
        pid_file: daemonPidPath(),
        log_file: daemonLogPath(),
        started: result.started,
        already_running: !!result.already_running,
        pid: result.pid ?? readDaemonPid() ?? null,
      };
    });
  });

daemon
  .command("status")
  .description("check daemon status")
  .action(async (command: Command) => {
    await runLocalCommand(command, "daemon status", async () => {
      const pid = readDaemonPid() ?? null;
      try {
        const pong = await pingDaemon();
        return {
          socket: daemonSocketPath(),
          pid_file: daemonPidPath(),
          log_file: daemonLogPath(),
          running: true,
          pid: pong.meta?.pid ?? pid,
          uptime_s: pong.meta?.uptime_s ?? null,
          started_at: pong.meta?.started_at ?? null,
        };
      } catch {
        return {
          socket: daemonSocketPath(),
          pid_file: daemonPidPath(),
          log_file: daemonLogPath(),
          running: false,
          pid,
        };
      }
    });
  });

daemon
  .command("stop")
  .description("stop daemon")
  .action(async (command: Command) => {
    await runLocalCommand(command, "daemon stop", async () => {
      const pid = readDaemonPid() ?? null;
      try {
        const response = await sendDaemonRequest({
          request: {
            id: daemonRequestId(),
            action: "shutdown",
          },
          timeoutMs: 5_000,
        });
        return {
          stopped: !!response.ok,
          pid: response.meta?.pid ?? pid,
          socket: daemonSocketPath(),
        };
      } catch {
        if (pid != null) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // ignore
          }
        }
        return {
          stopped: true,
          pid,
          socket: daemonSocketPath(),
        };
      }
    });
  });

daemon
  .command("serve")
  .description("internal daemon server")
  .option("--socket <path>", "daemon socket path")
  .action(async (opts: { socket?: string }) => {
    const socketPath = opts.socket?.trim() || daemonSocketPath();
    await serveDaemon(socketPath);
  });

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
        if (opts.jsonl && (ctx.globals.json || ctx.globals.output === "json")) {
          throw new Error("--jsonl cannot be combined with --json/--output json");
        }
        const streamJsonl = !!opts.jsonl;
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
        if (streamJsonl) {
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
      const status = await hubCallAccount<any>(ctx, "system.getOpenAiApiKeyStatus", [
        { project_id: workspace.project_id },
      ]);
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
          const result = await hubCallAccount<{ id: string; created: boolean }>(
            ctx,
            "system.setOpenAiApiKey",
            [{ project_id: workspace.project_id, api_key: apiKey }],
          );
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            credential_id: result.id,
            created: result.created,
            status: "saved",
          };
        }
        const result = await hubCallAccount<{ id: string; created: boolean }>(
          ctx,
          "system.setOpenAiApiKey",
          [{ api_key: apiKey }],
        );
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
          const result = await hubCallAccount<{ revoked: boolean }>(
            ctx,
            "system.deleteOpenAiApiKey",
            [{ project_id: workspace.project_id }],
          );
          return {
            scope,
            workspace_id: workspace.project_id,
            workspace_title: workspace.title,
            revoked: result.revoked,
          };
        }
        const result = await hubCallAccount<{ revoked: boolean }>(
          ctx,
          "system.deleteOpenAiApiKey",
          [{}],
        );
        return {
          scope,
          revoked: result.revoked,
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
