/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import type {
  BrowserActionName,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAutomationPosture,
  BrowserCoordinateSpace,
  BrowserExecPolicyV1,
  BrowserScreenshotMetadata,
} from "@cocalc/conat/service/browser-session";
import { basePathCookieName, isValidUUID } from "@cocalc/util/misc";
import { durationToMs } from "../../core/utils";

type BrowserSessionClient = {
  getExecApiDeclaration: () => Promise<string>;
  listRuntimeEvents: (opts?: {
    after_seq?: number;
    limit?: number;
    kinds?: BrowserRuntimeEventKind[];
    levels?: BrowserRuntimeEventLevel[];
  }) => Promise<{
    events: BrowserRuntimeEvent[];
    next_seq: number;
    dropped: number;
    total_buffered: number;
  }>;
  startExec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ exec_id: string; status: BrowserExecStatus }>;
  getExec: (opts: {
    exec_id: string;
  }) => Promise<BrowserExecOperation>;
  cancelExec: (opts: {
    exec_id: string;
  }) => Promise<{ ok: true; exec_id: string; status: BrowserExecStatus }>;
  listOpenFiles: () => Promise<
    {
      project_id: string;
      title?: string;
      path: string;
    }[]
  >;
  openFile: (opts: {
    project_id: string;
    path: string;
    foreground?: boolean;
    foreground_project?: boolean;
  }) => Promise<{ ok: true }>;
  closeFile: (opts: {
    project_id: string;
    path: string;
  }) => Promise<{ ok: true }>;
  exec: (opts: {
    project_id: string;
    code: string;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: unknown }>;
  action: (opts: {
    project_id: string;
    action: BrowserActionRequest;
    posture?: BrowserAutomationPosture;
    policy?: BrowserExecPolicyV1;
  }) => Promise<{ ok: true; result: BrowserActionResult }>;
};

type BrowserExecStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

type BrowserExecOperation = {
  exec_id: string;
  project_id: string;
  status: BrowserExecStatus;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancel_requested?: boolean;
  error?: string;
  result?: unknown;
};

type BrowserRuntimeEventKind =
  | "console"
  | "uncaught_error"
  | "unhandled_rejection";

type BrowserRuntimeEventLevel =
  | "trace"
  | "debug"
  | "log"
  | "info"
  | "warn"
  | "error";

type BrowserRuntimeEvent = {
  seq: number;
  ts: string;
  kind: BrowserRuntimeEventKind;
  level: BrowserRuntimeEventLevel;
  message: string;
  source?: string;
  line?: number;
  column?: number;
  stack?: string;
  url?: string;
};

type SpawnCookie = {
  name: string;
  value: string;
  url: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
};

type PlaywrightDaemonConfig = {
  spawn_id: string;
  state_file: string;
  target_url: string;
  headless?: boolean;
  timeout_ms?: number;
  executable_path?: string;
  session_name?: string;
  cookies?: SpawnCookie[];
};

type SpawnStateRecord = {
  spawn_id: string;
  pid: number;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
  target_url: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  stopped_at?: string;
  ready_at?: string;
  reason?: string;
  error?: string;
  page_url?: string;
  executable_path?: string;
  session_name?: string;
  browser_id?: string;
  session_url?: string;
  ipc_dir?: string;
};

type ScreenshotRenderer = "auto" | "dom" | "native" | "media";

type SpawnedScreenshotRequest = {
  request_id: string;
  action: "screenshot";
  selector: string;
  wait_for_idle_ms: number;
  timeout_ms: number;
};

type SpawnedScreenshotResponse =
  | {
      ok: true;
      request_id: string;
      result: Record<string, unknown>;
    }
  | {
      ok: false;
      request_id: string;
      error: string;
    };

const SPAWN_MARKER_QUERY_PARAM = "_cocalc_browser_spawn";
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 45_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 10_000;
const SPAWN_STATE_DIR = join(
  homedir() || process.cwd(),
  ".local",
  "share",
  "cocalc",
  "browser-sessions",
  "v1",
);

export type BrowserCommandDeps = {
  withContext: any;
  authConfigPath: any;
  loadAuthConfig: any;
  saveAuthConfig: any;
  selectedProfileName: any;
  globalsFrom: any;
  resolveWorkspace: any;
  createBrowserSessionClient: any;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSpawnId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `pw-${Date.now().toString(36)}-${rand}`;
}

function isSeaMode(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea?.isSea === "function" ? !!sea.isSea() : false;
  } catch {
    return false;
  }
}

function ensureSpawnStateDir(): void {
  mkdirSync(SPAWN_STATE_DIR, { recursive: true });
}

function spawnStateFile(spawnId: string): string {
  const clean = `${spawnId ?? ""}`.trim();
  if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) {
    throw new Error("spawn id must match /^[A-Za-z0-9._-]+$/");
  }
  return join(SPAWN_STATE_DIR, `${clean}.json`);
}

function readJsonFile(path: string): any {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function readSpawnState(path: string): SpawnStateRecord | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const row = readJsonFile(path);
    if (!row || typeof row !== "object") return undefined;
    return row as SpawnStateRecord;
  } catch {
    return undefined;
  }
}

function writeSpawnState(path: string, value: SpawnStateRecord): void {
  ensureSpawnStateDir();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, path);
}

function writeDaemonConfig(path: string, value: PlaywrightDaemonConfig): void {
  ensureSpawnStateDir();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveSecret(value: unknown): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return undefined;
  if (existsSync(raw)) {
    try {
      const fileVal = readFileSync(raw, "utf8").trim();
      return fileVal || undefined;
    } catch {
      return undefined;
    }
  }
  return raw;
}

function parseDiscoveryTimeout(value: string | undefined, fallbackMs: number): number {
  const clean = `${value ?? ""}`.trim();
  return clean ? Math.max(1_000, durationToMs(clean, fallbackMs)) : fallbackMs;
}

function resolveChromiumExecutablePath(preferred?: string): string | undefined {
  const explicit = `${preferred ?? ""}`.trim();
  if (explicit) return explicit;
  const envHint =
    `${process.env.COCALC_CHROMIUM_BIN ?? ""}`.trim() ||
    `${process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? ""}`.trim();
  if (envHint) return envHint;
  const candidates = [
    "chromium-browser",
    "chromium",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
  ];
  for (const command of candidates) {
    const probe = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (probe.status === 0) {
      const path = `${probe.stdout ?? ""}`.trim().split(/\r?\n/)[0]?.trim();
      if (path) return path;
    }
  }
  return undefined;
}

function resolveSpawnTargetUrl({
  apiUrl,
  projectId,
  explicitTargetUrl,
}: {
  apiUrl: string;
  projectId?: string;
  explicitTargetUrl?: string;
}): string {
  const explicit = `${explicitTargetUrl ?? ""}`.trim();
  if (explicit) {
    const parsed = new URL(explicit);
    return parsed.toString();
  }
  const base = new URL(apiUrl);
  if (projectId) {
    const basePath = base.pathname.replace(/\/+$/, "");
    base.pathname = `${basePath}/projects/${projectId}/files`.replace(/\/+/g, "/");
  }
  return base.toString();
}

function withSpawnMarker(targetUrl: string, marker: string): string {
  const url = new URL(targetUrl);
  url.searchParams.set(SPAWN_MARKER_QUERY_PARAM, marker);
  return url.toString();
}

function cookieNameFor(apiUrl: string, name: string): string {
  const pathname = new URL(apiUrl).pathname || "/";
  const basePath = pathname.replace(/\/+$/, "") || "/";
  return basePathCookieName({ basePath, name });
}

function buildSpawnCookies({
  apiUrl,
  hubPassword,
  apiKey,
}: {
  apiUrl: string;
  hubPassword?: string;
  apiKey?: string;
}): SpawnCookie[] {
  const out: SpawnCookie[] = [];
  const addCookie = (name: string, value: string) => {
    if (!name || !value) return;
    out.push({
      name,
      value,
      url: apiUrl,
    });
  };
  const cleanHubPassword = `${hubPassword ?? ""}`.trim();
  const cleanApiKey = `${apiKey ?? ""}`.trim();
  if (cleanHubPassword) {
    const prefixed = cookieNameFor(apiUrl, "hub_password");
    addCookie(prefixed, cleanHubPassword);
    if (prefixed !== "hub_password") {
      addCookie("hub_password", cleanHubPassword);
    }
  }
  if (cleanApiKey) {
    const prefixed = cookieNameFor(apiUrl, "api_key");
    addCookie(prefixed, cleanApiKey);
    if (prefixed !== "api_key") {
      addCookie("api_key", cleanApiKey);
    }
  }
  return out;
}

function matchesSpawnMarker(session: BrowserSessionInfo, marker: string): boolean {
  const url = `${session.url ?? ""}`.trim();
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get(SPAWN_MARKER_QUERY_PARAM) === marker) {
      return true;
    }
  } catch {
    // fall through to substring check
  }
  return url.includes(`${SPAWN_MARKER_QUERY_PARAM}=${encodeURIComponent(marker)}`);
}

async function waitForSpawnStateReady({
  stateFile,
  timeoutMs,
}: {
  stateFile: string;
  timeoutMs: number;
}): Promise<SpawnStateRecord> {
  const started = Date.now();
  let lastState: SpawnStateRecord | undefined;
  for (;;) {
    const state = readSpawnState(stateFile);
    if (state) lastState = state;
    if (state?.status === "ready") return state;
    if (state?.status === "failed") {
      throw new Error(state.error || "spawn daemon failed");
    }
    if (Date.now() - started > timeoutMs) {
      const suffix = lastState?.status ? ` (last status=${lastState.status})` : "";
      throw new Error(`timed out waiting for spawned browser daemon${suffix}`);
    }
    await sleep(250);
  }
}

async function waitForSpawnedSession({
  ctx,
  marker,
  timeoutMs,
}: {
  ctx: any;
  marker: string;
  timeoutMs: number;
}): Promise<BrowserSessionInfo> {
  const started = Date.now();
  for (;;) {
    const sessions = (await ctx.hub.system.listBrowserSessions({
      include_stale: true,
    })) as BrowserSessionInfo[];
    const match = (sessions ?? []).find((s) => matchesSpawnMarker(s, marker) && !s.stale);
    if (match) return match;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for spawned browser session heartbeat");
    }
    await sleep(1_000);
  }
}

async function terminateSpawnedProcess({
  pid,
  timeoutMs,
}: {
  pid: number;
  timeoutMs: number;
}): Promise<{ terminated: boolean; killed: boolean }> {
  if (!isProcessRunning(pid)) {
    return { terminated: true, killed: false };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { terminated: false, killed: false };
  }
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (!isProcessRunning(pid)) {
      return { terminated: true, killed: false };
    }
    await sleep(200);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { terminated: false, killed: false };
  }
  await sleep(200);
  return { terminated: !isProcessRunning(pid), killed: true };
}

function listSpawnStates(): Array<{ file: string; state: SpawnStateRecord }> {
  ensureSpawnStateDir();
  const entries: Array<{ file: string; state: SpawnStateRecord }> = [];
  for (const name of (existsSync(SPAWN_STATE_DIR) ? readdirSync(SPAWN_STATE_DIR) : [])) {
    if (!name.endsWith(".json")) continue;
    const file = join(SPAWN_STATE_DIR, name);
    const state = readSpawnState(file);
    if (!state) continue;
    entries.push({ file, state });
  }
  entries.sort((a, b) =>
    `${b.state.updated_at ?? ""}`.localeCompare(`${a.state.updated_at ?? ""}`),
  );
  return entries;
}

function resolveSpawnStateById(id: string): { file: string; state: SpawnStateRecord } | undefined {
  const clean = `${id ?? ""}`.trim();
  if (!clean) return undefined;
  try {
    const file = spawnStateFile(clean);
    const state = readSpawnState(file);
    if (state) return { file, state };
  } catch {
    // ignore invalid spawn-id format and continue searching by browser id
  }
  return listSpawnStates().find((x) => `${x.state.browser_id ?? ""}`.trim() === clean);
}

function resolveSpawnIpcDir({
  file,
  state,
}: {
  file: string;
  state: SpawnStateRecord;
}): string {
  const explicit = `${state.ipc_dir ?? ""}`.trim();
  if (explicit) return explicit;
  return join(dirname(file), `${state.spawn_id}.ipc`);
}

function resolveSpawnStateByBrowserId(
  browser_id: string,
): { file: string; state: SpawnStateRecord } | undefined {
  const clean = `${browser_id ?? ""}`.trim();
  if (!clean) return undefined;
  const match = listSpawnStates().find(
    ({ state }) =>
      `${state.browser_id ?? ""}`.trim() === clean &&
      Number.isInteger(Number(state.pid)) &&
      Number(state.pid) > 0,
  );
  if (!match) return undefined;
  if (!isProcessRunning(Number(match.state.pid))) return undefined;
  return match;
}

function normalizeBrowserId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id.length > 0 ? id : undefined;
}

function normalizeBrowserPosture(value: unknown): BrowserAutomationPosture | undefined {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return undefined;
  if (clean === "dev" || clean === "prod") return clean;
  throw new Error(`invalid browser posture '${value}'; expected 'dev' or 'prod'`);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = `${hostname ?? ""}`.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

function defaultPostureForApiUrl(apiUrl: string): BrowserAutomationPosture {
  try {
    const host = new URL(apiUrl).hostname;
    return isLoopbackHostname(host) ? "dev" : "prod";
  } catch {
    return "dev";
  }
}

function parseOptionalDurationMs(
  value: unknown,
  fallbackMs: number,
): number | undefined {
  const clean = `${value ?? ""}`.trim();
  if (!clean) return undefined;
  return durationToMs(clean, fallbackMs);
}

function parseCoordinateSpace(value: unknown): BrowserCoordinateSpace {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "viewport") return "viewport";
  if (
    clean === "selector" ||
    clean === "image" ||
    clean === "normalized"
  ) {
    return clean;
  }
  throw new Error(
    `invalid coordinate space '${value}'; expected viewport|selector|image|normalized`,
  );
}

function parseScreenshotRenderer(value: unknown): ScreenshotRenderer {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "auto") return "auto";
  if (clean === "dom" || clean === "native" || clean === "media") return clean;
  throw new Error(
    `invalid screenshot renderer '${value}'; expected auto|dom|native|media`,
  );
}

function parseRequiredNumber(value: unknown, label: string): number {
  const num = Number(`${value ?? ""}`.trim());
  if (!Number.isFinite(num)) {
    throw new Error(`${label} must be a finite number`);
  }
  return num;
}

function parseScrollBehavior(value: unknown): "auto" | "smooth" {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean || clean === "auto") return "auto";
  if (clean === "smooth") return "smooth";
  throw new Error(`invalid scroll behavior '${value}'; expected auto|smooth`);
}

function parseScrollAlign(
  value: unknown,
  label: "block" | "inline",
): "start" | "center" | "end" | "nearest" {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return label === "block" ? "center" : "nearest";
  if (
    clean === "start" ||
    clean === "center" ||
    clean === "end" ||
    clean === "nearest"
  ) {
    return clean;
  }
  throw new Error(`invalid --${label} '${value}'; expected start|center|end|nearest`);
}

function parseRuntimeEventLevels(
  value: unknown,
): BrowserRuntimeEventLevel[] | undefined {
  const clean = `${value ?? ""}`.trim().toLowerCase();
  if (!clean) return undefined;
  const parts = clean
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length === 0) return undefined;
  const allowed = new Set<BrowserRuntimeEventLevel>([
    "trace",
    "debug",
    "log",
    "info",
    "warn",
    "error",
  ]);
  const out: BrowserRuntimeEventLevel[] = [];
  for (const part of parts) {
    if (!allowed.has(part as BrowserRuntimeEventLevel)) {
      throw new Error(
        `invalid --level '${part}'; expected comma-separated trace,debug,log,info,warn,error`,
      );
    }
    out.push(part as BrowserRuntimeEventLevel);
  }
  return out.length > 0 ? out : undefined;
}

function formatRuntimeEventLine(event: BrowserRuntimeEvent): string {
  const ts = `${event.ts ?? ""}`.trim() || nowIso();
  const level = `${event.level ?? "log"}`.toUpperCase();
  const kind =
    event.kind === "console"
      ? "console"
      : event.kind === "uncaught_error"
        ? "uncaught"
        : "rejection";
  const sourceBits: string[] = [];
  if (event.source) sourceBits.push(`${event.source}`);
  if (event.line != null || event.column != null) {
    sourceBits.push(`${event.line ?? "?"}:${event.column ?? "?"}`);
  }
  const source = sourceBits.length > 0 ? ` (${sourceBits.join(" ")})` : "";
  return `${ts} [${level}] [${kind}] ${event.message}${source}`;
}

async function readScreenshotMeta(
  metaFile: string | undefined,
): Promise<BrowserScreenshotMetadata | undefined> {
  const clean = `${metaFile ?? ""}`.trim();
  if (!clean) return undefined;
  const raw = await readFile(clean, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in screenshot meta file '${clean}': ${err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`screenshot meta file '${clean}' must contain a JSON object`);
  }
  return parsed as BrowserScreenshotMetadata;
}

function parseBrowserExecPolicy(raw: string): BrowserExecPolicyV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in browser exec policy: ${err}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("browser exec policy must be a JSON object");
  }
  const row = parsed as Record<string, unknown>;
  const version = Number(row.version ?? 1);
  if (version !== 1) {
    throw new Error(`unsupported browser exec policy version '${row.version ?? ""}'; expected 1`);
  }
  const cleanStringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x) => x.length > 0);
    return out.length ? out : undefined;
  };
  const cleanActionArray = (value: unknown): BrowserActionName[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value
      .map((x) => `${x ?? ""}`.trim())
      .filter((x): x is BrowserActionName =>
        x === "click" ||
        x === "click_at" ||
        x === "drag" ||
        x === "type" ||
        x === "press" ||
        x === "reload" ||
        x === "navigate" ||
        x === "scroll_by" ||
        x === "scroll_to" ||
        x === "wait_for_selector" ||
        x === "wait_for_url" ||
        x === "batch",
      );
    return out.length ? out : undefined;
  };
  return {
    version: 1,
    ...(row.allow_raw_exec == null
      ? {}
      : { allow_raw_exec: !!row.allow_raw_exec }),
    ...(cleanStringArray(row.allowed_project_ids)
      ? { allowed_project_ids: cleanStringArray(row.allowed_project_ids) }
      : {}),
    ...(cleanStringArray(row.allowed_origins)
      ? { allowed_origins: cleanStringArray(row.allowed_origins) }
      : {}),
    ...(cleanActionArray(row.allowed_actions)
      ? { allowed_actions: cleanActionArray(row.allowed_actions) }
      : {}),
  };
}

async function resolveBrowserPolicyAndPosture({
  posture,
  policyFile,
  allowRawExec,
  apiBaseUrl,
}: {
  posture?: string;
  policyFile?: string;
  allowRawExec?: boolean;
  apiBaseUrl?: string;
}): Promise<{
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
}> {
  const resolvedPosture =
    normalizeBrowserPosture(posture) ??
    normalizeBrowserPosture(process.env.COCALC_BROWSER_POSTURE) ??
    defaultPostureForApiUrl(`${apiBaseUrl ?? ""}`);
  let policy: BrowserExecPolicyV1 | undefined;
  const cleanPolicyFile = `${policyFile ?? ""}`.trim();
  if (cleanPolicyFile) {
    const policyRaw = await readFile(cleanPolicyFile, "utf8");
    policy = parseBrowserExecPolicy(policyRaw);
  }
  if (allowRawExec) {
    policy = {
      ...(policy ?? { version: 1 }),
      version: 1,
      allow_raw_exec: true,
    };
  }
  return { posture: resolvedPosture, ...(policy ? { policy } : {}) };
}

function withBrowserExecStaleSessionHint({
  err,
  posture,
  policy,
  browserId,
}: {
  err: unknown;
  posture: BrowserAutomationPosture;
  policy?: BrowserExecPolicyV1;
  browserId?: string;
}): Error {
  const base = err instanceof Error ? err.message : `${err}`;
  const msg = `${base ?? ""}`;
  const quickjsExpected = posture === "prod" && !policy?.allow_raw_exec;
  if (
    quickjsExpected &&
    (msg.includes("raw browser exec is blocked in prod posture") ||
      msg.includes("QuickJSUseAfterFree"))
  ) {
    const reloadCmd = browserId
      ? `cocalc browser action reload --browser ${browserId} --posture prod`
      : "cocalc browser action reload --posture prod";
    return new Error(
      `${msg}\n\nThis browser session is likely stale after a frontend rebuild. Reload the target session and retry.\nTry: ${reloadCmd}\nIf needed, use --hard or manually hard-refresh the tab.`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function browserHintFromOption(value: unknown): string | undefined {
  return (
    normalizeBrowserId(value) ?? normalizeBrowserId(process.env.COCALC_BROWSER_ID)
  );
}

function isLikelyExactBrowserId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(value);
}

function directBrowserSessionInfo(browser_id: string): BrowserSessionInfo {
  const now = new Date().toISOString();
  return {
    browser_id,
    open_projects: [],
    stale: false,
    created_at: now,
    updated_at: now,
  };
}

function resolveBrowserSession(
  sessions: BrowserSessionInfo[],
  browserHint: string,
): BrowserSessionInfo {
  const exact = sessions.find((s) => s.browser_id === browserHint);
  if (exact) return exact;
  const prefixed = sessions.filter((s) => s.browser_id.startsWith(browserHint));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(
      `browser id '${browserHint}' is ambiguous (${prefixed.length} matches)`,
    );
  }
  throw new Error(`browser session '${browserHint}' not found`);
}

function sessionMatchesProject(
  session: BrowserSessionInfo,
  projectId: string | undefined,
): boolean {
  const target = `${projectId ?? ""}`.trim();
  if (!target) return true;
  if (`${session.active_project_id ?? ""}`.trim() === target) {
    return true;
  }
  return (session.open_projects ?? []).some(
    (p) => `${p?.project_id ?? ""}`.trim() === target,
  );
}

function sessionTargetContext(
  ctx: any,
  sessionInfo: BrowserSessionInfo,
  project_id?: string,
): Record<string, unknown> {
  const apiUrl = `${ctx?.apiBaseUrl ?? ""}`.trim();
  const sessionUrl = `${sessionInfo?.url ?? ""}`.trim();
  let target_warning = "";
  if (apiUrl && sessionUrl) {
    try {
      const apiOrigin = new URL(apiUrl).origin;
      const sessionOrigin = new URL(sessionUrl).origin;
      if (apiOrigin !== sessionOrigin) {
        target_warning =
          `browser session URL origin (${sessionOrigin}) differs from API origin (${apiOrigin})`;
      }
    } catch {
      // ignore parse failures
    }
  }
  return {
    target_api_url: apiUrl,
    target_browser_id: sessionInfo.browser_id,
    target_session_url: sessionUrl,
    ...(project_id ? { target_project_id: project_id } : {}),
    ...(target_warning ? { target_warning } : {}),
  };
}

async function resolveTargetProjectId({
  deps,
  ctx,
  workspace,
  projectId,
  sessionInfo,
}: {
  deps: Pick<BrowserCommandDeps, "resolveWorkspace">;
  ctx: any;
  workspace?: string;
  projectId?: string;
  sessionInfo: BrowserSessionInfo;
}): Promise<string> {
  const projectIdHint = `${projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  const workspaceHint = `${workspace ?? ""}`.trim();
  if (projectIdHint) {
    return isValidUUID(projectIdHint)
      ? projectIdHint
      : (await deps.resolveWorkspace(ctx, projectIdHint)).project_id;
  }
  if (workspaceHint) {
    return (await deps.resolveWorkspace(ctx, workspaceHint)).project_id;
  }
  if (`${sessionInfo.active_project_id ?? ""}`.trim()) {
    return (await deps.resolveWorkspace(ctx, sessionInfo.active_project_id)).project_id;
  }
  if (sessionInfo.open_projects?.length === 1 && sessionInfo.open_projects[0]?.project_id) {
    return (
      await deps.resolveWorkspace(ctx, sessionInfo.open_projects[0].project_id)
    ).project_id;
  }
  throw new Error(
    "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
  );
}

function loadProfileSelection(
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >,
  command: Command,
): {
  path: string;
  config: any;
  profile: string;
  browser_id?: string;
} {
  const globals = deps.globalsFrom(command);
  const path = deps.authConfigPath(process.env);
  const config = deps.loadAuthConfig(path);
  const profile = deps.selectedProfileName(globals, config, process.env);
  const browser_id = normalizeBrowserId(config?.profiles?.[profile]?.browser_id);
  return { path, config, profile, browser_id };
}

function saveProfileBrowserId({
  deps,
  command,
  browser_id,
}: {
  deps: Pick<
    BrowserCommandDeps,
    | "authConfigPath"
    | "loadAuthConfig"
    | "saveAuthConfig"
    | "selectedProfileName"
    | "globalsFrom"
  >;
  command: Command;
  browser_id?: string;
}): { profile: string; browser_id?: string } {
  const { path, config, profile } = loadProfileSelection(deps, command);
  const profileData = { ...(config.profiles?.[profile] ?? {}) };
  if (browser_id) {
    profileData.browser_id = browser_id;
  } else {
    delete profileData.browser_id;
  }
  config.current_profile = profile;
  config.profiles = config.profiles ?? {};
  config.profiles[profile] = profileData;
  deps.saveAuthConfig(config, path);
  return { profile, browser_id };
}

async function chooseBrowserSession({
  ctx,
  browserHint,
  fallbackBrowserId,
  requireDiscovery = false,
  sessionProjectId,
  activeOnly = false,
}: {
  ctx: any;
  browserHint?: string;
  fallbackBrowserId?: string;
  requireDiscovery?: boolean;
  sessionProjectId?: string;
  activeOnly?: boolean;
}): Promise<BrowserSessionInfo> {
  let sessions: BrowserSessionInfo[] | undefined;
  const getSessions = async (): Promise<BrowserSessionInfo[]> => {
    if (sessions) return sessions;
    sessions = (await ctx.hub.system.listBrowserSessions({
      include_stale: !activeOnly,
    })) as BrowserSessionInfo[];
    sessions = (sessions ?? []).filter((s) =>
      activeOnly ? !s.stale : true,
    );
    sessions = sessions.filter((s) => sessionMatchesProject(s, sessionProjectId));
    return sessions;
  };

  const explicitHint = normalizeBrowserId(browserHint);
  if (
    explicitHint &&
    !requireDiscovery &&
    isLikelyExactBrowserId(explicitHint) &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim()
  ) {
    return directBrowserSessionInfo(explicitHint);
  }
  if (explicitHint) {
    return resolveBrowserSession(await getSessions(), explicitHint);
  }
  const savedHint = normalizeBrowserId(fallbackBrowserId);
  if (
    savedHint &&
    !requireDiscovery &&
    !activeOnly &&
    !`${sessionProjectId ?? ""}`.trim()
  ) {
    return directBrowserSessionInfo(savedHint);
  }
  const resolvedSessions = await getSessions();
  if (savedHint) {
    const saved = resolveBrowserSession(resolvedSessions, savedHint);
    if (!saved.stale) {
      return saved;
    }
  }
  const active = resolvedSessions.filter((s) => !s.stale);
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) {
    if (`${sessionProjectId ?? ""}`.trim()) {
      throw new Error(
        `no active browser sessions found for project '${sessionProjectId}'`,
      );
    }
    throw new Error(
      "no active browser sessions found; open CoCalc in a browser first",
    );
  }
  throw new Error(
    `multiple active browser sessions found (${active.length}); use --browser <id> or 'cocalc browser session use <id>'`,
  );
}

function isExecTerminal(status: BrowserExecStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function browserScreenshotDomScript({
  selector,
  scale,
  waitForIdleMs,
}: {
  selector: string;
  scale: number;
  waitForIdleMs: number;
}): string {
  return `
const selector = ${JSON.stringify(selector)};
const scale = ${JSON.stringify(scale)};
const waitForIdleMs = ${JSON.stringify(waitForIdleMs)};
const libraryUrls = [
  "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  "https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js",
];
const loadScript = async (url) => {
  await new Promise((resolve, reject) => {
    const existing = Array.from(document.querySelectorAll("script")).find(
      (s) => s.src === url,
    );
    if (existing && (window).html2canvas) {
      resolve(undefined);
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    const timer = setTimeout(
      () => reject(new Error(\`timed out loading \${url}\`)),
      15000,
    );
    script.onload = () => resolve(undefined);
    script.onerror = () => reject(new Error(\`failed to load \${url}\`));
    script.onload = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error(\`failed to load \${url}\`));
    };
    document.head.appendChild(script);
  });
};
const waitForDomIdle = async (idleMs) => {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false;
  const maxWaitMs = Math.max(1000, Math.min(30000, Math.floor(idleMs * 20)));
  const timedOut = await new Promise((resolve) => {
    let timer = undefined;
    let maxTimer = undefined;
    let done = false;
    const finish = (maxedOut) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      observer.disconnect();
      resolve(!!maxedOut);
    };
    const schedule = () => {
      if (done) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(false), idleMs);
    };
    const root = document.documentElement || document.body;
    const observer = new MutationObserver(() => {
      schedule();
    });
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    maxTimer = setTimeout(() => finish(true), maxWaitMs);
    schedule();
  });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
  );
  return timedOut;
};
let html2canvas = (window).html2canvas;
if (typeof html2canvas !== "function") {
  let lastError = "";
  for (const url of libraryUrls) {
    try {
      await loadScript(url);
      html2canvas = (window).html2canvas;
      if (typeof html2canvas === "function") break;
    } catch (err) {
      lastError = \`\${err}\`;
    }
  }
  if (typeof html2canvas !== "function") {
    throw new Error(
      \`unable to initialize screenshot renderer (html2canvas): \${lastError || "library unavailable"}\`,
    );
  }
}
const root = document.querySelector(selector);
if (!root) {
  throw new Error(\`selector did not match any element: \${selector}\`);
}
const rect = root.getBoundingClientRect();
const selector_rect_css = {
  left: Number(rect.left || 0),
  top: Number(rect.top || 0),
  width: Number(rect.width || 0),
  height: Number(rect.height || 0),
};
const viewport_css = {
  width: Number(window.innerWidth || 0),
  height: Number(window.innerHeight || 0),
};
const wait_for_idle_timed_out = await waitForDomIdle(waitForIdleMs);
const canvas = await html2canvas(root, {
  scale,
  useCORS: true,
  allowTaint: true,
  backgroundColor: null,
  logging: false,
});
if (!canvas || typeof canvas.toDataURL !== "function") {
  throw new Error("screenshot renderer did not return a canvas");
}
const png_data_url = canvas.toDataURL("image/png");
if (typeof png_data_url !== "string" || !png_data_url.startsWith("data:image/png;base64,")) {
  throw new Error("invalid PNG data returned by screenshot renderer");
}
return {
  ok: true,
  selector,
  width: Number(canvas.width || 0),
  height: Number(canvas.height || 0),
  page_url: location.href,
  captured_at: new Date().toISOString(),
  capture_scale: Number(scale || 1),
  device_pixel_ratio: Number(window.devicePixelRatio || 1),
  scroll_x: Number(window.scrollX || window.pageXOffset || 0),
  scroll_y: Number(window.scrollY || window.pageYOffset || 0),
  selector_rect_css,
  viewport_css,
  screenshot_meta: {
    page_url: location.href,
    captured_at: new Date().toISOString(),
    selector,
    image_width: Number(canvas.width || 0),
    image_height: Number(canvas.height || 0),
    capture_scale: Number(scale || 1),
    device_pixel_ratio: Number(window.devicePixelRatio || 1),
    scroll_x: Number(window.scrollX || window.pageXOffset || 0),
    scroll_y: Number(window.scrollY || window.pageYOffset || 0),
    selector_rect_css,
    viewport_css,
  },
  wait_for_idle_ms: waitForIdleMs,
  wait_for_idle_timed_out,
  png_data_url,
};
`.trim();
}

function browserScreenshotMediaScript({
  selector,
  waitForIdleMs,
}: {
  selector: string;
  waitForIdleMs: number;
}): string {
  return `
const selector = ${JSON.stringify(selector)};
const waitForIdleMs = ${JSON.stringify(waitForIdleMs)};
const waitForDomIdle = async (idleMs) => {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return false;
  const maxWaitMs = Math.max(1000, Math.min(30000, Math.floor(idleMs * 20)));
  const timedOut = await new Promise((resolve) => {
    let timer = undefined;
    let maxTimer = undefined;
    let done = false;
    const finish = (maxedOut) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (maxTimer) clearTimeout(maxTimer);
      observer.disconnect();
      resolve(!!maxedOut);
    };
    const schedule = () => {
      if (done) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(false), idleMs);
    };
    const root = document.documentElement || document.body;
    const observer = new MutationObserver(() => schedule());
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    maxTimer = setTimeout(() => finish(true), maxWaitMs);
    schedule();
  });
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
  );
  return timedOut;
};
if (!navigator?.mediaDevices?.getDisplayMedia) {
  throw new Error("screen capture is unavailable in this browser/session");
}
const root = document.querySelector(selector);
if (!root) {
  throw new Error(\`selector did not match any element: \${selector}\`);
}
const rect = root.getBoundingClientRect();
const selector_rect_css = {
  left: Number(rect.left || 0),
  top: Number(rect.top || 0),
  width: Number(rect.width || 0),
  height: Number(rect.height || 0),
};
const viewport_css = {
  width: Number(window.innerWidth || 0),
  height: Number(window.innerHeight || 0),
};
const wait_for_idle_timed_out = await waitForDomIdle(waitForIdleMs);
let stream;
try {
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
} catch (err) {
  throw new Error(
    \`screen capture permission denied or blocked: \${err}. Approve the browser share prompt and select this tab, then retry.\`,
  );
}
try {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth || !video.videoHeight) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for captured frame")),
        5000,
      );
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        resolve(undefined);
      };
      video.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("captured media stream failed"));
      };
    });
  }
  const scaleX = Number(video.videoWidth || 0) / Math.max(1, viewport_css.width);
  const scaleY = Number(video.videoHeight || 0) / Math.max(1, viewport_css.height);
  const sx = Math.max(0, Math.floor(selector_rect_css.left * scaleX));
  const sy = Math.max(0, Math.floor(selector_rect_css.top * scaleY));
  const sw = Math.max(1, Math.floor(selector_rect_css.width * scaleX));
  const sh = Math.max(1, Math.floor(selector_rect_css.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("unable to create 2d context for captured frame");
  }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  const png_data_url = canvas.toDataURL("image/png");
  const capture_scale = Number.isFinite(scaleX) && scaleX > 0 ? scaleX : 1;
  return {
    ok: true,
    selector,
    width: Number(canvas.width || 0),
    height: Number(canvas.height || 0),
    page_url: location.href,
    captured_at: new Date().toISOString(),
    capture_scale,
    capture_scale_y: Number.isFinite(scaleY) && scaleY > 0 ? scaleY : capture_scale,
    device_pixel_ratio: Number(window.devicePixelRatio || 1),
    scroll_x: Number(window.scrollX || window.pageXOffset || 0),
    scroll_y: Number(window.scrollY || window.pageYOffset || 0),
    selector_rect_css,
    viewport_css,
    screenshot_meta: {
      page_url: location.href,
      captured_at: new Date().toISOString(),
      selector,
      image_width: Number(canvas.width || 0),
      image_height: Number(canvas.height || 0),
      capture_scale,
      device_pixel_ratio: Number(window.devicePixelRatio || 1),
      scroll_x: Number(window.scrollX || window.pageXOffset || 0),
      scroll_y: Number(window.scrollY || window.pageYOffset || 0),
      selector_rect_css,
      viewport_css,
    },
    wait_for_idle_ms: waitForIdleMs,
    wait_for_idle_timed_out,
    png_data_url,
  };
} finally {
  try {
    if (stream) {
      for (const track of stream.getTracks?.() ?? []) {
        try {
          track.stop();
        } catch {}
      }
    }
  } catch {}
}
`.trim();
}

async function captureScreenshotViaSpawnedDaemon({
  browser_id,
  selector,
  waitForIdleMs,
  timeoutMs,
}: {
  browser_id: string;
  selector: string;
  waitForIdleMs: number;
  timeoutMs: number;
}): Promise<{
  result: Record<string, unknown>;
  spawned: { file: string; state: SpawnStateRecord };
}> {
  const spawned = resolveSpawnStateByBrowserId(browser_id);
  if (!spawned) {
    throw new Error(`no local spawned browser daemon found for browser '${browser_id}'`);
  }
  const ipcDir = resolveSpawnIpcDir(spawned);
  mkdirSync(ipcDir, { recursive: true });
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const requestPath = join(ipcDir, `${requestId}.request.json`);
  const responsePath = join(ipcDir, `${requestId}.response.json`);
  const payload: SpawnedScreenshotRequest = {
    request_id: requestId,
    action: "screenshot",
    selector,
    wait_for_idle_ms: waitForIdleMs,
    timeout_ms: timeoutMs,
  };
  await writeFile(requestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const started = Date.now();
  for (;;) {
    if (existsSync(responsePath)) {
      const raw = await readFile(responsePath, "utf8");
      try {
        unlinkSync(responsePath);
      } catch {
        // best-effort cleanup
      }
      let parsed: SpawnedScreenshotResponse;
      try {
        parsed = JSON.parse(raw) as SpawnedScreenshotResponse;
      } catch (err) {
        throw new Error(`invalid spawned screenshot response: ${err}`);
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid spawned screenshot response payload");
      }
      if (!parsed.ok) {
        throw new Error(`${parsed.error || "spawned screenshot request failed"}`);
      }
      return { result: parsed.result ?? {}, spawned };
    }
    if (Date.now() - started > timeoutMs) {
      try {
        unlinkSync(requestPath);
      } catch {
        // ignore cleanup races
      }
      throw new Error("timed out waiting for spawned screenshot response");
    }
    await sleep(100);
  }
}

async function waitForExecOperation({
  browserClient,
  exec_id,
  pollMs,
  timeoutMs,
}: {
  browserClient: BrowserSessionClient;
  exec_id: string;
  pollMs: number;
  timeoutMs: number;
}): Promise<BrowserExecOperation> {
  const started = Date.now();
  for (;;) {
    const op = await browserClient.getExec({ exec_id });
    if (isExecTerminal(op.status)) {
      return op;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for browser exec ${exec_id}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function readExecScriptFromStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function registerBrowserCommand(
  program: Command,
  deps: BrowserCommandDeps,
): Command {
  const browser = program
    .command("browser")
    .description("browser session discovery and automation");

  const session = browser.command("session").description("browser sessions");

  session
    .command("list")
    .description("list browser sessions for the signed-in account")
    .option("--include-stale", "include stale/inactive sessions")
    .option("--active-only", "include only active sessions")
    .option(
      "--project-id <id>",
      "filter to sessions targeting this active/open workspace/project id",
    )
    .option(
      "--max-age-ms <ms>",
      "consider session stale if heartbeat is older than this",
      "120000",
    )
    .action(
      async (
        opts: {
          includeStale?: boolean;
          activeOnly?: boolean;
          projectId?: string;
          maxAgeMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser session list", async (ctx) => {
          const maxAgeMs = Number(opts.maxAgeMs ?? "120000");
          if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
            throw new Error("--max-age-ms must be a positive number");
          }
          if (opts.includeStale && opts.activeOnly) {
            throw new Error("--include-stale and --active-only cannot both be set");
          }
          const projectId = `${opts.projectId ?? ""}`.trim();
          const sessions = (await ctx.hub.system.listBrowserSessions({
            include_stale: opts.activeOnly ? false : !!opts.includeStale,
            max_age_ms: Math.floor(maxAgeMs),
          })) as BrowserSessionInfo[];
          return (sessions ?? [])
            .filter((s) => (opts.activeOnly ? !s.stale : true))
            .filter((s) => sessionMatchesProject(s, projectId))
            .map((s) => ({
            browser_id: s.browser_id,
            session_name: s.session_name ?? "",
            active_project_id: s.active_project_id ?? "",
            open_projects: s.open_projects?.length ?? 0,
            stale: !!s.stale,
            updated_at: s.updated_at,
            created_at: s.created_at,
            url: s.url ?? "",
            }));
        });
      },
    );

  session
    .command("use <browser>")
    .description("set default browser session id for the current auth profile")
    .action(async (browserHint: string, command: Command) => {
      await deps.withContext(command, "browser session use", async (ctx) => {
        const sessions = (await ctx.hub.system.listBrowserSessions({
          include_stale: true,
        })) as BrowserSessionInfo[];
        const selected = resolveBrowserSession(sessions, browserHint);
        const saved = saveProfileBrowserId({
          deps,
          command,
          browser_id: selected.browser_id,
        });
        return {
          profile: saved.profile,
          browser_id: selected.browser_id,
          stale: !!selected.stale,
        };
      });
    });

  session
    .command("clear")
    .description("clear default browser session id for current auth profile")
    .action(async (_opts: unknown, command: Command) => {
      const saved = saveProfileBrowserId({
        deps,
        command,
        browser_id: undefined,
      });
      await deps.withContext(command, "browser session clear", async () => ({
        profile: saved.profile,
        browser_id: null,
      }));
    });

  session
    .command("spawn")
    .description(
      "spawn a dedicated Playwright-backed Chromium browser session for automation",
    )
    .option("--api-url <url>", "CoCalc API/base URL (defaults to active CLI context)")
    .option("--target-url <url>", "exact URL to open in spawned Chromium session")
    .option("-w, --workspace <workspace>", "workspace id or name to open")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--session-name <name>",
      "set document.title for easier identification in browser session list",
    )
    .option(
      "--spawn-id <id>",
      "explicit spawn id (defaults to generated id)",
    )
    .option(
      "--chromium <path>",
      "explicit Chromium executable path (defaults to auto-detect from PATH)",
    )
    .option(
      "--headless",
      "launch Chromium in headless mode (default)",
    )
    .option(
      "--headed",
      "launch Chromium in visible headed mode",
    )
    .option(
      "--ready-timeout <duration>",
      "timeout for daemon startup readiness (e.g. 10s, 1m)",
      "20s",
    )
    .option(
      "--timeout <duration>",
      "timeout to discover browser heartbeat session (e.g. 30s, 2m)",
      "45s",
    )
    .option(
      "--use",
      "set discovered browser id as default for current auth profile",
    )
    .action(
      async (
        opts: {
          apiUrl?: string;
          targetUrl?: string;
          workspace?: string;
          projectId?: string;
          sessionName?: string;
          spawnId?: string;
          chromium?: string;
          headless?: boolean;
          headed?: boolean;
          readyTimeout?: string;
          timeout?: string;
          use?: boolean;
        },
        command: Command,
      ) => {
        if (isSeaMode()) {
          throw new Error(
            "browser session spawn is unsupported in standalone SEA binary; use JS CLI (e.g. node ./packages/cli/dist/bin/cocalc.js ...).",
          );
        }
        await deps.withContext(command, "browser session spawn", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const globals = deps.globalsFrom(command);
          const apiUrl = `${opts.apiUrl ?? ctx.apiBaseUrl ?? ""}`.trim();
          if (!apiUrl) {
            throw new Error("api url is required; pass --api-url or configure COCALC_API_URL");
          }
          let parsedApiUrl: string;
          try {
            parsedApiUrl = new URL(apiUrl).toString();
          } catch {
            throw new Error(`invalid --api-url '${apiUrl}'`);
          }
          const projectHint = `${opts.projectId ?? opts.workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const project_id = !projectHint
            ? undefined
            : isValidUUID(projectHint)
              ? projectHint
              : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const spawnId = `${opts.spawnId ?? ""}`.trim() || randomSpawnId();
          const stateFile = spawnStateFile(spawnId);
          const existing = readSpawnState(stateFile);
          if (existing?.pid && isProcessRunning(existing.pid)) {
            throw new Error(
              `spawn id '${spawnId}' is already active (pid ${existing.pid}); destroy it first`,
            );
          }
          const marker = `${spawnId}-${Math.random().toString(36).slice(2, 8)}`;
          const targetUrl = resolveSpawnTargetUrl({
            apiUrl: parsedApiUrl,
            projectId: project_id,
            explicitTargetUrl: opts.targetUrl,
          });
          const markedTargetUrl = withSpawnMarker(targetUrl, marker);
          const chromiumPath = resolveChromiumExecutablePath(opts.chromium);
          if (!chromiumPath) {
            throw new Error(
              "unable to find Chromium executable; pass --chromium <path> or set COCALC_CHROMIUM_BIN",
            );
          }
          const hubPassword = resolveSecret(globals.hubPassword ?? process.env.COCALC_HUB_PASSWORD);
          const apiKey = resolveSecret(globals.apiKey ?? process.env.COCALC_API_KEY);
          const cookies = buildSpawnCookies({
            apiUrl: parsedApiUrl,
            hubPassword,
            apiKey,
          });
          const sessionName =
            `${opts.sessionName ?? ""}`.trim() || `CoCalc Agent Session (${spawnId})`;
          const daemonConfigPath = join(
            SPAWN_STATE_DIR,
            `${spawnId}.config-${process.pid}-${Date.now()}.json`,
          );
          const daemonScript = resolvePath(
            __dirname,
            "..",
            "core",
            "browser-session-playwright-daemon.js",
          );
          if (!existsSync(daemonScript)) {
            throw new Error(
              `missing daemon script '${daemonScript}' (build @cocalc/cli first)`,
            );
          }
          if (opts.headless && opts.headed) {
            throw new Error("choose only one of --headless or --headed");
          }
          const spawnHeadless = opts.headed ? false : true;
          writeDaemonConfig(daemonConfigPath, {
            spawn_id: spawnId,
            state_file: stateFile,
            target_url: markedTargetUrl,
            headless: spawnHeadless,
            timeout_ms: parseDiscoveryTimeout(opts.readyTimeout, DEFAULT_READY_TIMEOUT_MS),
            executable_path: chromiumPath,
            session_name: sessionName,
            cookies,
          });
          const child = spawnProcess(process.execPath, [daemonScript, daemonConfigPath], {
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          const daemonPid = child.pid;
          if (!daemonPid || daemonPid <= 0) {
            throw new Error("failed to start browser spawn daemon");
          }

          try {
            await waitForSpawnStateReady({
              stateFile,
              timeoutMs: parseDiscoveryTimeout(
                opts.readyTimeout,
                DEFAULT_READY_TIMEOUT_MS,
              ),
            });
            const sessionInfo = await waitForSpawnedSession({
              ctx,
              marker,
              timeoutMs: parseDiscoveryTimeout(
                opts.timeout,
                DEFAULT_DISCOVERY_TIMEOUT_MS,
              ),
            });
            const latest = readSpawnState(stateFile);
            if (latest) {
              writeSpawnState(stateFile, {
                ...latest,
                browser_id: sessionInfo.browser_id,
                session_url: `${sessionInfo.url ?? ""}`.trim() || undefined,
                updated_at: nowIso(),
              });
            }
            if (opts.use) {
              saveProfileBrowserId({
                deps,
                command,
                browser_id: sessionInfo.browser_id,
              });
            }
            return {
              spawn_id: spawnId,
              pid: daemonPid,
              browser_id: sessionInfo.browser_id,
              state_file: stateFile,
              target_url: targetUrl,
              launched_url: markedTargetUrl,
              session_name: sessionName,
              project_id: project_id ?? "",
              profile: profileSelection.profile,
              profile_default_set: !!opts.use,
              mode: "playwright-spawned",
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          } catch (err) {
            await terminateSpawnedProcess({
              pid: daemonPid,
              timeoutMs: 2_500,
            });
            throw err;
          } finally {
            try {
              unlinkSync(daemonConfigPath);
            } catch {
              // best-effort cleanup
            }
          }
        });
      },
    );

  session
    .command("spawned")
    .description("list locally managed Playwright-spawned browser sessions")
    .action(async (_opts: unknown, command: Command) => {
      await deps.withContext(command, "browser session spawned", async () => {
        return listSpawnStates().map(({ file, state }) => ({
          spawn_id: state.spawn_id,
          pid: state.pid,
          running: isProcessRunning(Number(state.pid)),
          status: state.status,
          browser_id: `${state.browser_id ?? ""}`.trim(),
          session_url: `${state.session_url ?? state.page_url ?? ""}`.trim(),
          target_url: state.target_url,
          updated_at: state.updated_at,
          state_file: file,
        }));
      });
    });

  session
    .command("destroy <id>")
    .description(
      "destroy a Playwright-spawned browser session by spawn id or browser id",
    )
    .option(
      "--timeout <duration>",
      "graceful shutdown timeout before SIGKILL (e.g. 5s, 30s)",
      "10s",
    )
    .option("--keep-state", "do not remove local spawn state file")
    .action(
      async (
        id: string,
        opts: { timeout?: string; keepState?: boolean },
        command: Command,
      ) => {
        await deps.withContext(command, "browser session destroy", async (ctx) => {
          const resolved = resolveSpawnStateById(id);
          if (!resolved) {
            throw new Error(
              `spawned browser session '${id}' not found (try 'cocalc browser session spawned')`,
            );
          }
          const { file, state } = resolved;
          const pid = Number(state.pid);
          const shutdown = await terminateSpawnedProcess({
            pid,
            timeoutMs: parseDiscoveryTimeout(
              opts.timeout,
              DEFAULT_DESTROY_TIMEOUT_MS,
            ),
          });
          let removedRemoteSession = false;
          if (`${state.browser_id ?? ""}`.trim()) {
            try {
              const removed = await ctx.hub.system.removeBrowserSession({
                browser_id: state.browser_id,
              });
              removedRemoteSession = !!removed?.removed;
            } catch {
              removedRemoteSession = false;
            }
          }
          const stoppedState: SpawnStateRecord = {
            ...state,
            status: "stopped",
            reason: "destroy-command",
            stopped_at: nowIso(),
            updated_at: nowIso(),
          };
          let stateFileRemoved = false;
          if (opts.keepState) {
            writeSpawnState(file, stoppedState);
          } else {
            try {
              unlinkSync(file);
              stateFileRemoved = true;
            } catch {
              writeSpawnState(file, stoppedState);
            }
          }
          return {
            spawn_id: state.spawn_id,
            pid,
            browser_id: state.browser_id ?? "",
            terminated: shutdown.terminated,
            force_killed: shutdown.killed,
            remote_session_removed: removedRemoteSession,
            state_file: file,
            state_file_removed: stateFileRemoved,
          };
        });
      },
    );

  const logs = browser.command("logs").description("browser runtime logs");

  logs
    .command("tail")
    .description("tail browser console runtime logs from the target session")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option("--lines <n>", "number of events per fetch", "200")
    .option("--since-seq <n>", "fetch events after this sequence number")
    .option(
      "--level <csv>",
      "optional level filter: trace,debug,log,info,warn,error (comma-separated)",
    )
    .option("--follow", "follow log stream by polling for new events")
    .option("--poll-ms <duration>", "poll interval for --follow", "1s")
    .option("--timeout <duration>", "max follow time before returning")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          lines?: string;
          sinceSeq?: string;
          level?: string;
          follow?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser logs tail", async (ctx) => {
          const globals = deps.globalsFrom(command);
          const wantsJson = !!globals.json || globals.output === "json";
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const lines = Number(opts.lines ?? "200");
          if (!Number.isFinite(lines) || lines <= 0) {
            throw new Error("--lines must be a positive integer");
          }
          const levelFilter = parseRuntimeEventLevels(opts.level);
          const sinceSeqRaw = `${opts.sinceSeq ?? ""}`.trim();
          const hasSinceSeq = sinceSeqRaw.length > 0;
          let afterSeq: number | undefined;
          if (hasSinceSeq) {
            const parsed = Number(sinceSeqRaw);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error("--since-seq must be a non-negative integer");
            }
            afterSeq = Math.floor(parsed);
          }
          const follow = !!opts.follow;
          const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
          const timeoutMs = `${opts.timeout ?? ""}`.trim()
            ? Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs))
            : undefined;
          const startedAt = Date.now();
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
          }) as BrowserSessionClient;
          let printed = 0;
          let latestDropped = 0;
          let latestBuffered = 0;
          let allEvents: BrowserRuntimeEvent[] = [];
          const emitEvents = (events: BrowserRuntimeEvent[]) => {
            if (events.length === 0) return;
            if (wantsJson && follow) {
              for (const event of events) {
                process.stdout.write(`${JSON.stringify(event)}\n`);
              }
              return;
            }
            if (!wantsJson) {
              for (const event of events) {
                process.stdout.write(`${formatRuntimeEventLine(event)}\n`);
              }
            }
          };
          for (;;) {
            const result = await browserClient.listRuntimeEvents({
              ...(afterSeq != null ? { after_seq: afterSeq } : {}),
              limit: Math.min(5_000, Math.max(1, Math.floor(lines))),
              kinds: ["console"],
              ...(levelFilter ? { levels: levelFilter } : {}),
            });
            const events = Array.isArray(result?.events) ? result.events : [];
            latestDropped = Number(result?.dropped ?? latestDropped);
            latestBuffered = Number(result?.total_buffered ?? latestBuffered);
            emitEvents(events);
            printed += events.length;
            allEvents = allEvents.concat(events);
            afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
            if (!follow) {
              break;
            }
            if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
              break;
            }
            await sleep(pollMs);
          }
          const base = {
            browser_id: sessionInfo.browser_id,
            printed,
            next_seq: afterSeq ?? 0,
            dropped: latestDropped,
            total_buffered: latestBuffered,
            ...sessionTargetContext(ctx, sessionInfo),
          };
          if (wantsJson && !follow) {
            return {
              ...base,
              events: allEvents,
            };
          }
          if (wantsJson && follow) {
            return null;
          }
          return base;
        });
      },
    );

  logs
    .command("uncaught")
    .description("stream uncaught errors and unhandled promise rejections")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option("--lines <n>", "number of events per fetch", "200")
    .option("--since-seq <n>", "fetch events after this sequence number")
    .option("--follow", "follow uncaught stream by polling for new events")
    .option("--no-follow", "disable follow mode and return one fetch")
    .option("--poll-ms <duration>", "poll interval for --follow", "1s")
    .option("--timeout <duration>", "max follow time before returning")
    .action(
      async (
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          lines?: string;
          sinceSeq?: string;
          follow?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser logs uncaught", async (ctx) => {
          const globals = deps.globalsFrom(command);
          const wantsJson = !!globals.json || globals.output === "json";
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const lines = Number(opts.lines ?? "200");
          if (!Number.isFinite(lines) || lines <= 0) {
            throw new Error("--lines must be a positive integer");
          }
          const sinceSeqRaw = `${opts.sinceSeq ?? ""}`.trim();
          const hasSinceSeq = sinceSeqRaw.length > 0;
          let afterSeq: number | undefined;
          if (hasSinceSeq) {
            const parsed = Number(sinceSeqRaw);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error("--since-seq must be a non-negative integer");
            }
            afterSeq = Math.floor(parsed);
          }
          const follow = opts.follow !== false;
          const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
          const timeoutMs = `${opts.timeout ?? ""}`.trim()
            ? Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs))
            : undefined;
          const startedAt = Date.now();
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, timeoutMs ?? ctx.timeoutMs),
          }) as BrowserSessionClient;
          let printed = 0;
          let latestDropped = 0;
          let latestBuffered = 0;
          let allEvents: BrowserRuntimeEvent[] = [];
          const emitEvents = (events: BrowserRuntimeEvent[]) => {
            if (events.length === 0) return;
            if (wantsJson && follow) {
              for (const event of events) {
                process.stdout.write(`${JSON.stringify(event)}\n`);
              }
              return;
            }
            if (!wantsJson) {
              for (const event of events) {
                process.stdout.write(`${formatRuntimeEventLine(event)}\n`);
              }
            }
          };
          for (;;) {
            const result = await browserClient.listRuntimeEvents({
              ...(afterSeq != null ? { after_seq: afterSeq } : {}),
              limit: Math.min(5_000, Math.max(1, Math.floor(lines))),
              kinds: ["uncaught_error", "unhandled_rejection"],
              levels: ["error"],
            });
            const events = Array.isArray(result?.events) ? result.events : [];
            latestDropped = Number(result?.dropped ?? latestDropped);
            latestBuffered = Number(result?.total_buffered ?? latestBuffered);
            emitEvents(events);
            printed += events.length;
            allEvents = allEvents.concat(events);
            afterSeq = Number(result?.next_seq ?? afterSeq ?? 0);
            if (!follow) {
              break;
            }
            if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
              break;
            }
            await sleep(pollMs);
          }
          const base = {
            browser_id: sessionInfo.browser_id,
            printed,
            next_seq: afterSeq ?? 0,
            dropped: latestDropped,
            total_buffered: latestBuffered,
            ...sessionTargetContext(ctx, sessionInfo),
          };
          if (wantsJson && !follow) {
            return {
              ...base,
              events: allEvents,
            };
          }
          if (wantsJson && follow) {
            return null;
          }
          return base;
        });
      },
    );

  browser
    .command("exec-api")
    .description(
      "print the TypeScript declaration for the browser exec API supported by the selected browser session",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: { browser?: string; sessionProjectId?: string; activeOnly?: boolean },
        command: Command,
      ) => {
      await deps.withContext(command, "browser exec-api", async (ctx) => {
        const profileSelection = loadProfileSelection(deps, command);
        const sessionInfo = await chooseBrowserSession({
          ctx,
          browserHint: browserHintFromOption(opts.browser),
          fallbackBrowserId: profileSelection.browser_id,
          sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
          activeOnly: !!opts.activeOnly,
        });
        const browserClient = deps.createBrowserSessionClient({
          account_id: ctx.accountId,
          browser_id: sessionInfo.browser_id,
          client: ctx.remote.client,
        }) as BrowserSessionClient;
        return await browserClient.getExecApiDeclaration();
      });
    });

  browser
    .command("files")
    .description("list files currently open in a browser session")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        opts: { browser?: string; sessionProjectId?: string; activeOnly?: boolean },
        command: Command,
      ) => {
      await deps.withContext(command, "browser files", async (ctx) => {
        const profileSelection = loadProfileSelection(deps, command);
        const sessionInfo = await chooseBrowserSession({
          ctx,
          browserHint: browserHintFromOption(opts.browser),
          fallbackBrowserId: profileSelection.browser_id,
          sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
          activeOnly: !!opts.activeOnly,
        });
        const browserClient = deps.createBrowserSessionClient({
          account_id: ctx.accountId,
          browser_id: sessionInfo.browser_id,
          client: ctx.remote.client,
        }) as BrowserSessionClient;
        const files = await browserClient.listOpenFiles();
        return files.map((row) => ({
          browser_id: sessionInfo.browser_id,
          project_id: row.project_id,
          title: row.title ?? "",
          path: row.path,
          ...sessionTargetContext(ctx, sessionInfo, row.project_id),
        }));
      });
    });

  browser
    .command("open [workspace] <paths...>")
    .description(
      "open one or more workspace files in a target browser session (supports --project-id/COCALC_PROJECT_ID)",
    )
    .option(
      "--project-id <id>",
      "workspace/project id (overrides [workspace]); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--background",
      "open in background (do not focus project/file in browser)",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        workspace: string | undefined,
        paths: string[],
        opts: {
          browser?: string;
          projectId?: string;
          background?: boolean;
          sessionProjectId?: string;
          activeOnly?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser open", async (ctx) => {
          const projectHint = `${opts.projectId ?? workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          if (!projectHint) {
            throw new Error(
              "workspace/project is required; pass [workspace], --project-id, or set COCALC_PROJECT_ID",
            );
          }
          const project_id = isValidUUID(projectHint)
            ? projectHint
            : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const profileSelection = loadProfileSelection(deps, command);
          const browserHint = browserHintFromOption(opts.browser);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project_id,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const cleanPaths = (paths ?? []).map((p) => `${p ?? ""}`.trim()).filter((p) => p.length > 0);
          if (!cleanPaths.length) {
            throw new Error("at least one path must be specified");
          }
          for (const [index, path] of cleanPaths.entries()) {
            const foreground = !opts.background && index === 0;
            await browserClient.openFile({
              project_id,
              path,
              foreground,
              foreground_project: foreground,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            paths: cleanPaths,
            opened: cleanPaths.length,
            background: !!opts.background,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("close [workspace] <paths...>")
    .description(
      "close one or more open workspace files in a target browser session (supports --project-id/COCALC_PROJECT_ID)",
    )
    .option(
      "--project-id <id>",
      "workspace/project id (overrides [workspace]); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .action(
      async (
        workspace: string | undefined,
        paths: string[],
        opts: {
          browser?: string;
          projectId?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser close", async (ctx) => {
          const projectHint = `${opts.projectId ?? workspace ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          if (!projectHint) {
            throw new Error(
              "workspace/project is required; pass [workspace], --project-id, or set COCALC_PROJECT_ID",
            );
          }
          const project_id = isValidUUID(projectHint)
            ? projectHint
            : (await deps.resolveWorkspace(ctx, projectHint)).project_id;
          const profileSelection = loadProfileSelection(deps, command);
          const browserHint = browserHintFromOption(opts.browser);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() || project_id,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const cleanPaths = (paths ?? []).map((p) => `${p ?? ""}`.trim()).filter((p) => p.length > 0);
          if (!cleanPaths.length) {
            throw new Error("at least one path must be specified");
          }
          for (const path of cleanPaths) {
            await browserClient.closeFile({
              project_id,
              path,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            paths: cleanPaths,
            closed: cleanPaths.length,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("screenshot")
    .description(
      "capture a PNG screenshot from a target browser session and save it locally",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--renderer <mode>",
      "screenshot renderer: auto|native|dom|media (default auto)",
      "auto",
    )
    .option(
      "--selector <css>",
      "CSS selector for screenshot root element",
      "body",
    )
    .option(
      "--scale <n>",
      "render scale for DOM screenshot renderer",
      "1",
    )
    .option("--out <path>", "output PNG path on local machine")
    .option(
      "--timeout <duration>",
      "timeout for screenshot capture (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-idle <duration>",
      "wait for DOM idle before capture (e.g. 250ms, 2s)",
    )
    .option(
      "--meta-out <path>",
      "optional output path for screenshot metadata JSON",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          renderer?: string;
          selector?: string;
          scale?: string;
          out?: string;
          metaOut?: string;
          timeout?: string;
          waitForIdle?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser screenshot", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });

          const selector = `${opts.selector ?? "body"}`.trim() || "body";
          const requestedRenderer = parseScreenshotRenderer(opts.renderer);
          const scale = Number(opts.scale ?? "1");
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error("--scale must be a positive number");
          }
          const waitForIdleMs = `${opts.waitForIdle ?? ""}`.trim()
            ? Math.max(0, durationToMs(opts.waitForIdle, 1_000))
            : 0;
          const outputPath =
            `${opts.out ?? ""}`.trim() ||
            `browser-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const metaOutPath = `${opts.metaOut ?? ""}`.trim();
          let rendererUsed: ScreenshotRenderer = requestedRenderer;
          let result: any;
          let spawnedUsed:
            | {
                file: string;
                state: SpawnStateRecord;
              }
            | undefined;

          if (requestedRenderer === "native" || requestedRenderer === "auto") {
            try {
              const nativeResult = await captureScreenshotViaSpawnedDaemon({
                browser_id: sessionInfo.browser_id,
                selector,
                waitForIdleMs,
                timeoutMs,
              });
              result = nativeResult.result;
              spawnedUsed = nativeResult.spawned;
              rendererUsed = "native";
            } catch (err) {
              if (requestedRenderer === "native") {
                throw err;
              }
            }
          }

          if (!result) {
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: timeoutMs,
            }) as BrowserSessionClient;
            const modeForExec: ScreenshotRenderer =
              requestedRenderer === "media"
                ? "media"
                : requestedRenderer === "dom"
                  ? "dom"
                  : "dom";
            const script =
              modeForExec === "media"
                ? browserScreenshotMediaScript({
                    selector,
                    waitForIdleMs,
                  })
                : browserScreenshotDomScript({
                    selector,
                    scale,
                    waitForIdleMs,
                  });
            const started = await browserClient.startExec({
              project_id,
              code: script,
            });
            const op = await waitForExecOperation({
              browserClient,
              exec_id: started.exec_id,
              pollMs: 1_000,
              timeoutMs,
            });
            if (op.status === "failed") {
              throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
            }
            if (op.status === "canceled") {
              throw new Error(`browser exec ${op.exec_id} was canceled`);
            }
            result = (op?.result ?? {}) as any;
            rendererUsed = modeForExec;
          }

          const pngDataUrl = `${result?.png_data_url ?? ""}`.trim();
          if (!pngDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("browser screenshot capture returned invalid PNG data");
          }
          const base64 = pngDataUrl.slice("data:image/png;base64,".length);
          const png = Buffer.from(base64, "base64");
          await writeFile(outputPath, png);
          const screenshotMeta = (result?.screenshot_meta ?? {
            page_url: `${result?.page_url ?? ""}`,
            captured_at: `${result?.captured_at ?? ""}`,
            selector,
            image_width: Number(result?.width ?? 0),
            image_height: Number(result?.height ?? 0),
            capture_scale: Number(result?.capture_scale ?? scale),
            device_pixel_ratio: Number(result?.device_pixel_ratio ?? 1),
            scroll_x: Number(result?.scroll_x ?? 0),
            scroll_y: Number(result?.scroll_y ?? 0),
            selector_rect_css: result?.selector_rect_css,
            viewport_css: result?.viewport_css,
          }) as BrowserScreenshotMetadata;
          if (metaOutPath) {
            await writeFile(
              metaOutPath,
              `${JSON.stringify(screenshotMeta, null, 2)}\n`,
              "utf8",
            );
          }

          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            output_path: resolvePath(outputPath),
            ...(metaOutPath ? { meta_output_path: resolvePath(metaOutPath) } : {}),
            bytes: png.byteLength,
            width: Number(result?.width ?? 0),
            height: Number(result?.height ?? 0),
            renderer_requested: requestedRenderer,
            renderer_used: rendererUsed,
            ...(spawnedUsed
              ? {
                  spawn_id: spawnedUsed.state.spawn_id,
                  spawn_state_file: spawnedUsed.file,
                }
              : {}),
            selector,
            wait_for_idle_ms: Number(result?.wait_for_idle_ms ?? waitForIdleMs),
            wait_for_idle_timed_out: !!result?.wait_for_idle_timed_out,
            page_url: `${result?.page_url ?? ""}`,
            screenshot_meta: screenshotMeta,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("exec [code...]")
    .description(
      "execute javascript in the target browser session with a limited browser API (use 'cocalc browser exec-api' to inspect the API); provide code inline, with --file, or with --stdin",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--file <path>",
      "read javascript from a file path (use '-' to read from stdin)",
    )
    .option("--stdin", "read javascript from stdin")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option(
      "--policy-file <path>",
      "JSON file with browser exec policy (prod defaults to sandboxed exec unless allow_raw_exec=true)",
    )
    .option(
      "--allow-raw-exec",
      "explicitly allow raw JS exec (sets policy.allow_raw_exec=true)",
    )
    .option(
      "--async",
      "start execution asynchronously and return an exec id",
    )
    .option(
      "--wait",
      "when used with --async, wait for completion and return final status/result",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval for async wait mode (e.g. 250ms, 2s)",
      "1s",
    )
    .option(
      "--timeout <duration>",
      "timeout for synchronous exec, or total wait timeout in async wait mode (e.g. 30s, 5m, 1h)",
    )
    .action(
      async (
        code: string[],
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          file?: string;
          stdin?: boolean;
          posture?: string;
          policyFile?: string;
          allowRawExec?: boolean;
          timeout?: string;
          async?: boolean;
          wait?: boolean;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const inlineScript = (code ?? []).join(" ").trim();
          const filePath = `${opts.file ?? ""}`.trim();
          const readFromStdin = !!opts.stdin || filePath === "-";
          const readFromFile = filePath.length > 0 && filePath !== "-";
          const sourceCount =
            (inlineScript.length > 0 ? 1 : 0) +
            (readFromFile ? 1 : 0) +
            (readFromStdin ? 1 : 0);
          if (sourceCount === 0) {
            throw new Error(
              "javascript code must be provided inline, with --file <path>, or with --stdin",
            );
          }
          if (sourceCount > 1) {
            throw new Error(
              "choose exactly one script source: inline code, --file <path>, or --stdin",
            );
          }
          const script = readFromFile
            ? await readFile(filePath, "utf8")
            : readFromStdin
              ? await readExecScriptFromStdin()
              : inlineScript;
          if (!script) {
            throw new Error("javascript code must be specified");
          }
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            allowRawExec: opts.allowRawExec,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          if (opts.async) {
            let started;
            try {
              started = await browserClient.startExec({
                project_id,
                code: script,
                posture,
                policy,
              });
            } catch (err) {
              throw withBrowserExecStaleSessionHint({
                err,
                posture,
                policy,
                browserId: sessionInfo.browser_id,
              });
            }
            if (!opts.wait) {
              return {
                browser_id: sessionInfo.browser_id,
                project_id,
                posture,
                ...started,
                ...sessionTargetContext(ctx, sessionInfo, project_id),
              };
            }
            const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
            const op = await waitForExecOperation({
              browserClient,
              exec_id: started.exec_id,
              pollMs,
              timeoutMs,
            });
            if (op.status === "failed") {
              throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
            }
            if (op.status === "canceled") {
              throw new Error(`browser exec ${op.exec_id} was canceled`);
            }
            return {
              browser_id: sessionInfo.browser_id,
              posture,
              ...op,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          }
          let response;
          try {
            response = await browserClient.exec({
              project_id,
              code: script,
              posture,
              policy,
            });
          } catch (err) {
            throw withBrowserExecStaleSessionHint({
              err,
              posture,
              policy,
              browserId: sessionInfo.browser_id,
            });
          }
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  const action = browser
    .command("action")
    .description("run typed browser automation actions without raw JS");

  action
    .command("click <selector>")
    .description("click an element by CSS selector")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--button <left|middle|right>", "mouse button", "left")
    .option("--click-count <n>", "number of clicks", "1")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-navigation <duration>",
      "after click, wait for URL change up to this duration",
    )
    .action(
      async (
        selector: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          button?: string;
          clickCount?: string;
          timeout?: string;
          waitForNavigation?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action click", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const waitForNavigationMs = parseOptionalDurationMs(
            opts.waitForNavigation,
            5_000,
          );
          const cleanSelector = `${selector ?? ""}`.trim();
          if (!cleanSelector) {
            throw new Error("selector must be specified");
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const clickCount = Number(opts.clickCount ?? "1");
          if (!Number.isFinite(clickCount) || clickCount <= 0) {
            throw new Error("--click-count must be a positive number");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "click",
              selector: cleanSelector,
              button,
              click_count: Math.floor(clickCount),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(waitForNavigationMs != null
                ? { wait_for_navigation_ms: waitForNavigationMs }
                : {}),
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("click-at <x> <y>")
    .description(
      "click at coordinates (useful for canvas/plotly); supports screenshot metadata mapping",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--space <viewport|selector|image|normalized>",
      "coordinate space for x/y",
      "viewport",
    )
    .option("--selector <css>", "selector anchor for selector/image space")
    .option(
      "--meta-file <path>",
      "screenshot metadata JSON from 'browser screenshot --meta-out'",
    )
    .option(
      "--strict-meta",
      "require current page url (and selector, if provided) to match metadata",
    )
    .option("--button <left|middle|right>", "mouse button", "left")
    .option("--click-count <n>", "number of clicks", "1")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .option(
      "--wait-for-navigation <duration>",
      "after click, wait for URL change up to this duration",
    )
    .action(
      async (
        x: string,
        y: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          space?: string;
          selector?: string;
          metaFile?: string;
          strictMeta?: boolean;
          button?: string;
          clickCount?: string;
          timeout?: string;
          waitForNavigation?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action click-at", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const waitForNavigationMs = parseOptionalDurationMs(
            opts.waitForNavigation,
            5_000,
          );
          const space = parseCoordinateSpace(opts.space);
          const screenshotMeta = await readScreenshotMeta(opts.metaFile);
          const selector =
            `${opts.selector ?? ""}`.trim() ||
            `${screenshotMeta?.selector ?? ""}`.trim();
          if (
            (space === "selector" || space === "image") &&
            !selector
          ) {
            throw new Error(
              "--selector (or screenshot metadata with selector) is required for selector/image coordinate space",
            );
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const clickCount = Number(opts.clickCount ?? "1");
          if (!Number.isFinite(clickCount) || clickCount <= 0) {
            throw new Error("--click-count must be a positive number");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "click_at",
              x: parseRequiredNumber(x, "x"),
              y: parseRequiredNumber(y, "y"),
              space,
              ...(selector ? { selector } : {}),
              button,
              click_count: Math.floor(clickCount),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(waitForNavigationMs != null
                ? { wait_for_navigation_ms: waitForNavigationMs }
                : {}),
              ...(screenshotMeta ? { screenshot_meta: screenshotMeta } : {}),
              strict_meta: !!opts.strictMeta,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("drag <x1> <y1> <x2> <y2>")
    .description(
      "drag from one coordinate to another (useful for plotly/canvas interactions)",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--space <viewport|selector|image|normalized>",
      "coordinate space for x/y pairs",
      "viewport",
    )
    .option("--selector <css>", "selector anchor for selector/image space")
    .option(
      "--meta-file <path>",
      "screenshot metadata JSON from 'browser screenshot --meta-out'",
    )
    .option(
      "--strict-meta",
      "require current page url (and selector, if provided) to match metadata",
    )
    .option("--button <left|middle|right>", "mouse button for drag", "left")
    .option("--steps <n>", "number of intermediate move steps", "14")
    .option(
      "--hold <duration>",
      "optional hold duration after mousedown before moving",
    )
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        x1: string,
        y1: string,
        x2: string,
        y2: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          space?: string;
          selector?: string;
          metaFile?: string;
          strictMeta?: boolean;
          button?: string;
          steps?: string;
          hold?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action drag", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const holdMs = parseOptionalDurationMs(opts.hold, 100);
          const space = parseCoordinateSpace(opts.space);
          const screenshotMeta = await readScreenshotMeta(opts.metaFile);
          const selector =
            `${opts.selector ?? ""}`.trim() ||
            `${screenshotMeta?.selector ?? ""}`.trim();
          if (
            (space === "selector" || space === "image") &&
            !selector
          ) {
            throw new Error(
              "--selector (or screenshot metadata with selector) is required for selector/image coordinate space",
            );
          }
          const button = `${opts.button ?? "left"}`.trim() as
            | "left"
            | "middle"
            | "right";
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error("--button must be one of left|middle|right");
          }
          const steps = Math.floor(parseRequiredNumber(opts.steps ?? "14", "steps"));
          if (!Number.isFinite(steps) || steps < 1) {
            throw new Error("--steps must be a positive integer");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "drag",
              x1: parseRequiredNumber(x1, "x1"),
              y1: parseRequiredNumber(y1, "y1"),
              x2: parseRequiredNumber(x2, "x2"),
              y2: parseRequiredNumber(y2, "y2"),
              space,
              ...(selector ? { selector } : {}),
              button,
              steps,
              ...(holdMs != null ? { hold_ms: holdMs } : {}),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              ...(screenshotMeta ? { screenshot_meta: screenshotMeta } : {}),
              strict_meta: !!opts.strictMeta,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("type <selector> <text...>")
    .description("type text into an input/textarea/contenteditable target")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--append", "append text instead of replacing existing value")
    .option("--clear", "clear existing content before typing")
    .option("--submit", "submit closest form after typing")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        selector: string,
        text: string[],
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          append?: boolean;
          clear?: boolean;
          submit?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action type", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const cleanSelector = `${selector ?? ""}`.trim();
          const cleanText = (text ?? []).join(" ");
          if (!cleanSelector) {
            throw new Error("selector must be specified");
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "type",
              selector: cleanSelector,
              text: cleanText,
              append: !!opts.append,
              clear: !!opts.clear,
              submit: !!opts.submit,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("press <key>")
    .description("dispatch a key press on target selector (or active element)")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--selector <css>", "optional CSS selector to focus before key press")
    .option("--ctrl", "press Control/Ctrl modifier")
    .option("--alt", "press Alt modifier")
    .option("--shift", "press Shift modifier")
    .option("--meta", "press Meta/Command modifier")
    .option(
      "--timeout <duration>",
      "timeout for locating/interacting with element (e.g. 30s, 2m)",
    )
    .action(
      async (
        key: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          selector?: string;
          ctrl?: boolean;
          alt?: boolean;
          shift?: boolean;
          meta?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action press", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const cleanKey = `${key ?? ""}`.trim();
          if (!cleanKey) {
            throw new Error("key must be specified");
          }
          const cleanSelector = `${opts.selector ?? ""}`.trim();
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "press",
              key: cleanKey,
              ...(cleanSelector ? { selector: cleanSelector } : {}),
              ctrl: !!opts.ctrl,
              alt: !!opts.alt,
              shift: !!opts.shift,
              meta: !!opts.meta,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("wait-for-selector <selector>")
    .description("wait for selector state transition")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--state <attached|visible|hidden|detached>",
      "desired selector state",
      "visible",
    )
    .option(
      "--timeout <duration>",
      "timeout for wait operation (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 100ms, 1s)",
      "100ms",
    )
    .action(
      async (
        selector: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          state?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(
          command,
          "browser action wait-for-selector",
          async (ctx) => {
            const profileSelection = loadProfileSelection(deps, command);
            const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
            const browserHint = browserHintFromOption(opts.browser) ?? "";
            const workspaceHint = `${opts.workspace ?? ""}`.trim();
            const sessionInfo = await chooseBrowserSession({
              ctx,
              browserHint,
              fallbackBrowserId: profileSelection.browser_id,
              requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
              sessionProjectId:
                `${opts.sessionProjectId ?? ""}`.trim() ||
                `${projectIdHint ?? ""}`.trim() ||
                undefined,
              activeOnly: !!opts.activeOnly,
            });
            const project_id = await resolveTargetProjectId({
              deps,
              ctx,
              workspace: workspaceHint,
              projectId: projectIdHint,
              sessionInfo,
            });
            const { posture, policy } = await resolveBrowserPolicyAndPosture({
              posture: opts.posture,
              policyFile: opts.policyFile,
              apiBaseUrl: ctx.apiBaseUrl,
            });
            const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
            const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
            const cleanSelector = `${selector ?? ""}`.trim();
            const state = `${opts.state ?? "visible"}`.trim().toLowerCase() as
              | "attached"
              | "visible"
              | "hidden"
              | "detached";
            if (!cleanSelector) {
              throw new Error("selector must be specified");
            }
            if (!["attached", "visible", "hidden", "detached"].includes(state)) {
              throw new Error("--state must be one of attached|visible|hidden|detached");
            }
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
            }) as BrowserSessionClient;
            const response = await browserClient.action({
              project_id,
              posture,
              policy,
              action: {
                name: "wait_for_selector",
                selector: cleanSelector,
                state,
                ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
                poll_ms: pollMs,
              },
            });
            return {
              browser_id: sessionInfo.browser_id,
              project_id,
              posture,
              ok: !!response?.ok,
              result: response?.result ?? null,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          },
        );
      },
    );

  action
    .command("wait-for-url [pattern]")
    .description("wait for URL match by exact URL, substring, or regex")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--url <value>", "exact URL match")
    .option("--includes <value>", "URL substring match")
    .option("--regex <value>", "JavaScript regex pattern")
    .option(
      "--timeout <duration>",
      "timeout for wait operation (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 100ms, 1s)",
      "100ms",
    )
    .action(
      async (
        pattern: string | undefined,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          url?: string;
          includes?: string;
          regex?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action wait-for-url", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
          const cleanPattern = `${pattern ?? ""}`.trim();
          const url = `${opts.url ?? ""}`.trim();
          const includes = `${opts.includes ?? cleanPattern}`.trim();
          const regex = `${opts.regex ?? ""}`.trim();
          if (!url && !includes && !regex) {
            throw new Error(
              "URL matcher required: pass [pattern], --url, --includes, or --regex",
            );
          }
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "wait_for_url",
              ...(url ? { url } : {}),
              ...(includes ? { includes } : {}),
              ...(regex ? { regex } : {}),
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              poll_ms: pollMs,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("reload")
    .description("reload the targeted browser session page")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--hard",
      "best-effort hard refresh; appends a cache-busting query parameter and replaces current URL",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          hard?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action reload", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: ctx.timeoutMs,
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "reload",
              hard: !!opts.hard,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("navigate <url>")
    .description("navigate browser session to a URL")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--replace", "replace current history entry instead of pushing")
    .option(
      "--wait-for-url <duration>",
      "after navigate, wait up to this duration for URL change",
    )
    .action(
      async (
        url: string,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          replace?: boolean;
          waitForUrl?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action navigate", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const cleanUrl = `${url ?? ""}`.trim();
          if (!cleanUrl) {
            throw new Error("url must be specified");
          }
          const waitForUrlMs = parseOptionalDurationMs(opts.waitForUrl, 5_000);
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.waitForUrl, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "navigate",
              url: cleanUrl,
              replace: !!opts.replace,
              ...(waitForUrlMs != null ? { wait_for_url_ms: waitForUrlMs } : {}),
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("scroll-by <dy> [dx]")
    .description("scroll viewport by delta values")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--behavior <auto|smooth>", "scroll behavior", "auto")
    .action(
      async (
        dy: string,
        dx: string | undefined,
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          behavior?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action scroll-by", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const dyValue = parseRequiredNumber(dy, "dy");
          const dxValue = dx == null ? 0 : parseRequiredNumber(dx, "dx");
          const behavior = parseScrollBehavior(opts.behavior);
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "scroll_by",
              dx: dxValue,
              dy: dyValue,
              behavior,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("scroll-to")
    .description(
      "scroll to selector (recommended) or explicit top/left coordinates",
    )
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option("--selector <css>", "CSS selector target to bring into view")
    .option("--top <n>", "absolute vertical scroll position")
    .option("--left <n>", "absolute horizontal scroll position")
    .option("--behavior <auto|smooth>", "scroll behavior", "auto")
    .option(
      "--block <start|center|end|nearest>",
      "vertical alignment when selector is provided",
      "center",
    )
    .option(
      "--inline <start|center|end|nearest>",
      "horizontal alignment when selector is provided",
      "nearest",
    )
    .option(
      "--timeout <duration>",
      "timeout when waiting for selector (e.g. 30s, 2m)",
    )
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting for selector",
      "100ms",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          selector?: string;
          top?: string;
          left?: string;
          behavior?: string;
          block?: string;
          inline?: string;
          timeout?: string;
          pollMs?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action scroll-to", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const selector = `${opts.selector ?? ""}`.trim();
          const top =
            opts.top == null || `${opts.top}`.trim() === ""
              ? undefined
              : parseRequiredNumber(opts.top, "top");
          const left =
            opts.left == null || `${opts.left}`.trim() === ""
              ? undefined
              : parseRequiredNumber(opts.left, "left");
          if (!selector && top == null && left == null) {
            throw new Error("pass --selector or at least one of --top/--left");
          }
          const behavior = parseScrollBehavior(opts.behavior);
          const block = parseScrollAlign(opts.block, "block");
          const inline = parseScrollAlign(opts.inline, "inline");
          const timeoutMs = parseOptionalDurationMs(opts.timeout, ctx.timeoutMs);
          const pollMs = Math.max(20, durationToMs(`${opts.pollMs ?? "100ms"}`, 100));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "scroll_to",
              ...(selector ? { selector } : {}),
              ...(top != null ? { top } : {}),
              ...(left != null ? { left } : {}),
              behavior,
              block,
              inline,
              ...(timeoutMs != null ? { timeout_ms: timeoutMs } : {}),
              poll_ms: pollMs,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  action
    .command("batch")
    .description(
      "execute multiple typed actions in one call using a JSON file (array or {actions, continue_on_error})",
    )
    .requiredOption("--file <path>", "JSON file describing action batch")
    .option("-w, --workspace <workspace>", "workspace id or name")
    .option(
      "--project-id <id>",
      "workspace/project id (overrides --workspace); defaults to COCALC_PROJECT_ID when set",
    )
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--posture <dev|prod>",
      "browser automation posture; default is dev on loopback targets, prod otherwise",
    )
    .option("--policy-file <path>", "JSON file with browser exec policy")
    .option(
      "--continue-on-error",
      "continue remaining steps after a step fails",
    )
    .option(
      "--timeout <duration>",
      "rpc timeout for batch execution",
    )
    .action(
      async (
        opts: {
          file?: string;
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          posture?: string;
          policyFile?: string;
          continueOnError?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser action batch", async (ctx) => {
          const file = `${opts.file ?? ""}`.trim();
          if (!file) {
            throw new Error("--file is required");
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(file, "utf8"));
          } catch (err) {
            throw new Error(`invalid batch json file '${file}': ${err}`);
          }
          const parsedObject =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : undefined;
          const actions = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsedObject?.actions)
              ? parsedObject?.actions
              : undefined;
          if (!Array.isArray(actions) || actions.length === 0) {
            throw new Error("batch file must contain an action array or { actions: [...] }");
          }
          const continueOnErrorFromFile =
            parsedObject?.continue_on_error == null
              ? undefined
              : !!parsedObject.continue_on_error;
          const continueOnError =
            opts.continueOnError || continueOnErrorFromFile === true;

          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery: workspaceHint.length === 0 && projectIdHint.length === 0,
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          const project_id = await resolveTargetProjectId({
            deps,
            ctx,
            workspace: workspaceHint,
            projectId: projectIdHint,
            sessionInfo,
          });
          const { posture, policy } = await resolveBrowserPolicyAndPosture({
            posture: opts.posture,
            policyFile: opts.policyFile,
            apiBaseUrl: ctx.apiBaseUrl,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const response = await browserClient.action({
            project_id,
            posture,
            policy,
            action: {
              name: "batch",
              actions: actions as any,
              continue_on_error: continueOnError,
            },
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            posture,
            ok: !!response?.ok,
            result: response?.result ?? null,
            ...sessionTargetContext(ctx, sessionInfo, project_id),
          };
        });
      },
    );

  browser
    .command("exec-get <exec_id>")
    .description("get status/result for an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--timeout <duration>",
      "rpc timeout per status request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-get", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const op = await browserClient.getExec({ exec_id });
          return {
            browser_id: sessionInfo.browser_id,
            ...op,
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  browser
    .command("exec-wait <exec_id>")
    .description("wait for completion of an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--poll-ms <duration>",
      "poll interval while waiting (e.g. 250ms, 2s)",
      "1s",
    )
    .option(
      "--timeout <duration>",
      "maximum total wait duration (e.g. 30s, 5m, 1h)",
    )
    .action(
      async (
        exec_id: string,
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          pollMs?: string;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-wait", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const timeoutMs = Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs));
          const pollMs = Math.max(100, durationToMs(opts.pollMs, 1_000));
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const op = await waitForExecOperation({
            browserClient,
            exec_id,
            pollMs,
            timeoutMs,
          });
          if (op.status === "failed") {
            throw new Error(op.error ?? `browser exec ${op.exec_id} failed`);
          }
          if (op.status === "canceled") {
            throw new Error(`browser exec ${op.exec_id} was canceled`);
          }
          return {
            browser_id: sessionInfo.browser_id,
            ...op,
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  browser
    .command("exec-cancel <exec_id>")
    .description("request cancellation of an async browser exec operation")
    .option(
      "--browser <id>",
      "browser id (or unique prefix); defaults to COCALC_BROWSER_ID when set",
    )
    .option(
      "--session-project-id <id>",
      "prefer browser sessions with this active/open workspace/project id",
    )
    .option("--active-only", "only target active (non-stale) sessions")
    .option(
      "--timeout <duration>",
      "rpc timeout for cancel request (e.g. 30s, 5m)",
    )
    .action(
      async (
        exec_id: string,
        opts: {
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          timeout?: string;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser exec-cancel", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint: browserHintFromOption(opts.browser),
            fallbackBrowserId: profileSelection.browser_id,
            sessionProjectId: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
            activeOnly: !!opts.activeOnly,
          });
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: Math.max(1_000, durationToMs(opts.timeout, ctx.timeoutMs)),
          }) as BrowserSessionClient;
          const canceled = await browserClient.cancelExec({ exec_id });
          return {
            browser_id: sessionInfo.browser_id,
            ...canceled,
            ...sessionTargetContext(ctx, sessionInfo),
          };
        });
      },
    );

  return browser;
}
