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
import { join, resolve as resolvePath } from "node:path";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import { basePathCookieName, isValidUUID } from "@cocalc/util/misc";
import { durationToMs } from "../../core/utils";

type BrowserSessionClient = {
  getExecApiDeclaration: () => Promise<string>;
  startExec: (opts: {
    project_id: string;
    code: string;
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
  }) => Promise<{ ok: true; result: unknown }>;
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

function normalizeBrowserId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim();
  return id.length > 0 ? id : undefined;
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

function browserScreenshotScript({
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
  wait_for_idle_ms: waitForIdleMs,
  wait_for_idle_timed_out,
  png_data_url,
};
`.trim();
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
    .option("--headless", "launch Chromium in headless mode")
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
          readyTimeout?: string;
          timeout?: string;
          use?: boolean;
        },
        command: Command,
      ) => {
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
          writeDaemonConfig(daemonConfigPath, {
            spawn_id: spawnId,
            state_file: stateFile,
            target_url: markedTargetUrl,
            headless: !!opts.headless,
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
      "--selector <css>",
      "CSS selector for screenshot root element",
      "body",
    )
    .option(
      "--scale <n>",
      "render scale for screenshot capture",
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
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          selector?: string;
          scale?: string;
          out?: string;
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
          const project_id = projectIdHint
            ? projectIdHint
            : workspaceHint
              ? (await deps.resolveWorkspace(ctx, workspaceHint)).project_id
              : sessionInfo.active_project_id
                ? (await deps.resolveWorkspace(ctx, sessionInfo.active_project_id)).project_id
                : sessionInfo.open_projects?.length === 1 &&
                    sessionInfo.open_projects[0]?.project_id
                  ? (
                      await deps.resolveWorkspace(
                        ctx,
                        sessionInfo.open_projects[0].project_id,
                      )
                    ).project_id
                  : (() => {
                      throw new Error(
                        "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
                      );
                    })();

          const selector = `${opts.selector ?? "body"}`.trim() || "body";
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
          const browserClient = deps.createBrowserSessionClient({
            account_id: ctx.accountId,
            browser_id: sessionInfo.browser_id,
            client: ctx.remote.client,
            timeout: timeoutMs,
          }) as BrowserSessionClient;
          const started = await browserClient.startExec({
            project_id,
            code: browserScreenshotScript({ selector, scale, waitForIdleMs }),
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
          const result = (op?.result ?? {}) as any;
          const pngDataUrl = `${result?.png_data_url ?? ""}`.trim();
          if (!pngDataUrl.startsWith("data:image/png;base64,")) {
            throw new Error("browser screenshot capture returned invalid PNG data");
          }
          const base64 = pngDataUrl.slice("data:image/png;base64,".length);
          const png = Buffer.from(base64, "base64");
          await writeFile(outputPath, png);

          return {
            browser_id: sessionInfo.browser_id,
            project_id,
            output_path: resolvePath(outputPath),
            bytes: png.byteLength,
            width: Number(result?.width ?? 0),
            height: Number(result?.height ?? 0),
            selector,
            wait_for_idle_ms: Number(result?.wait_for_idle_ms ?? waitForIdleMs),
            wait_for_idle_timed_out: !!result?.wait_for_idle_timed_out,
            page_url: `${result?.page_url ?? ""}`,
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
          const project_id = projectIdHint
            ? projectIdHint
            : workspaceHint
              ? (await deps.resolveWorkspace(ctx, workspaceHint)).project_id
              : sessionInfo.active_project_id
                ? (await deps.resolveWorkspace(ctx, sessionInfo.active_project_id)).project_id
                : sessionInfo.open_projects?.length === 1 &&
                    sessionInfo.open_projects[0]?.project_id
                  ? (
                      await deps.resolveWorkspace(
                        ctx,
                        sessionInfo.open_projects[0].project_id,
                      )
                    ).project_id
                  : (() => {
                      throw new Error(
                        "workspace/project is required; pass --project-id, -w/--workspace, or focus a workspace tab in the target browser session",
                      );
                    })();
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
          if (opts.async) {
            const started = await browserClient.startExec({
              project_id,
              code: script,
            });
            if (!opts.wait) {
              return {
                browser_id: sessionInfo.browser_id,
                project_id,
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
              ...op,
              ...sessionTargetContext(ctx, sessionInfo, project_id),
            };
          }
          const response = await browserClient.exec({
            project_id,
            code: script,
          });
          return {
            browser_id: sessionInfo.browser_id,
            project_id,
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
