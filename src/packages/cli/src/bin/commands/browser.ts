/*
Browser session commands.

These commands let CLI users discover active signed-in browser sessions, select
one for subsequent operations, and run first-pass automation tasks like listing
or opening files in that browser session.
*/

import { Command } from "commander";
import { spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import type {
  BrowserAutomationPosture,
  BrowserExecPolicyV1,
  BrowserScreenshotMetadata,
} from "@cocalc/conat/service/browser-session";
import { isValidUUID } from "@cocalc/util/misc";
import { durationToMs } from "../../core/utils";
import {
  defaultPostureForApiUrl,
  formatNetworkTraceLine,
  formatRuntimeEventLine,
  normalizeBrowserId,
  normalizeBrowserPosture,
  parseBrowserExecPolicy,
  parseCoordinateSpace,
  parseCsvStrings,
  parseNetworkDirection,
  parseNetworkPhases,
  parseNetworkProtocols,
  parseOptionalDurationMs,
  parseRequiredNumber,
  parseRuntimeEventLevels,
  parseScreenshotRenderer,
  parseScrollAlign,
  parseScrollBehavior,
} from "./browser/parse-format";
import {
  DEFAULT_DESTROY_TIMEOUT_MS,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  SPAWN_STATE_DIR,
  buildSpawnCookies,
  isProcessRunning,
  isSeaMode,
  nowIso,
  parseDiscoveryTimeout,
  randomSpawnId,
  readSpawnState,
  resolveChromiumExecutablePath,
  resolveSecret,
  resolveSpawnIpcDir,
  resolveSpawnStateByBrowserId,
  resolveSpawnStateById,
  resolveSpawnTargetUrl,
  spawnStateFile,
  terminateSpawnedProcess,
  waitForSpawnStateReady,
  waitForSpawnedSession,
  withSpawnMarker,
  writeDaemonConfig,
  writeSpawnState,
  listSpawnStates,
} from "./browser/spawn-state";
import { registerBrowserActionCommands } from "./browser/register-action-commands";
import { registerBrowserObservabilityCommands } from "./browser/register-observability-commands";
import { registerBrowserSessionCommands } from "./browser/register-session-commands";
import type {
  BrowserActionRegisterUtils,
  BrowserCommandContext,
  BrowserCommandDeps,
  BrowserExecOperation,
  BrowserExecStatus,
  BrowserObservabilityRegisterUtils,
  BrowserSessionClient,
  BrowserSessionRegisterUtils,
  ScreenshotRenderer,
  SpawnedScreenshotRequest,
  SpawnedScreenshotResponse,
  SpawnStateRecord,
} from "./browser/types";
export type { BrowserCommandDeps } from "./browser/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  ctx: Pick<BrowserCommandContext, "apiBaseUrl">,
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
  ctx: Parameters<BrowserCommandDeps["resolveWorkspace"]>[0];
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
  const activeProjectId = `${sessionInfo.active_project_id ?? ""}`.trim();
  if (activeProjectId) {
    return (await deps.resolveWorkspace(ctx, activeProjectId)).project_id;
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
  config: ReturnType<BrowserCommandDeps["loadAuthConfig"]>;
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
  ctx: BrowserCommandContext;
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
  fullPage,
  viewportWidth,
  viewportHeight,
}: {
  browser_id: string;
  selector: string;
  waitForIdleMs: number;
  timeoutMs: number;
  fullPage: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
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
    ...(fullPage ? { full_page: true } : {}),
    ...(viewportWidth != null ? { viewport_width: viewportWidth } : {}),
    ...(viewportHeight != null ? { viewport_height: viewportHeight } : {}),
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

  const sessionUtils: BrowserSessionRegisterUtils = {
    loadProfileSelection,
    saveProfileBrowserId,
    resolveBrowserSession,
    randomSpawnId,
    spawnStateFile,
    readSpawnState,
    isProcessRunning,
    resolveSpawnTargetUrl,
    withSpawnMarker,
    resolveChromiumExecutablePath,
    resolveSecret,
    buildSpawnCookies,
    writeDaemonConfig,
    parseDiscoveryTimeout,
    waitForSpawnStateReady,
    waitForSpawnedSession,
    nowIso,
    terminateSpawnedProcess,
    listSpawnStates,
    resolveSpawnStateById,
    isSeaMode,
    sessionMatchesProject,
    sessionTargetContext,
    writeSpawnState,
    DEFAULT_READY_TIMEOUT_MS,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    DEFAULT_DESTROY_TIMEOUT_MS,
    SPAWN_STATE_DIR,
    spawnProcess,
    resolvePath,
    join,
    existsSync,
    unlinkSync,
    isValidUUID,
  };
  registerBrowserSessionCommands({ browser, deps, utils: sessionUtils });

  const observabilityUtils: BrowserObservabilityRegisterUtils = {
    loadProfileSelection,
    chooseBrowserSession,
    browserHintFromOption,
    parseRuntimeEventLevels,
    formatRuntimeEventLine,
    durationToMs,
    sessionTargetContext,
    parseNetworkDirection,
    parseNetworkProtocols,
    parseNetworkPhases,
    formatNetworkTraceLine,
    parseCsvStrings,
    sleep,
  };
  registerBrowserObservabilityCommands({
    browser,
    deps,
    utils: observabilityUtils,
  });

  browser
    .command("target-resolve")
    .description(
      "dry-run browser target resolution (session + workspace/project) without performing an action",
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
      "--require-discovery",
      "force hub discovery even when browser id appears exact",
    )
    .action(
      async (
        opts: {
          workspace?: string;
          projectId?: string;
          browser?: string;
          sessionProjectId?: string;
          activeOnly?: boolean;
          requireDiscovery?: boolean;
        },
        command: Command,
      ) => {
        await deps.withContext(command, "browser target-resolve", async (ctx) => {
          const profileSelection = loadProfileSelection(deps, command);
          const projectIdHint = `${opts.projectId ?? process.env.COCALC_PROJECT_ID ?? ""}`.trim();
          const browserHint = browserHintFromOption(opts.browser) ?? "";
          const workspaceHint = `${opts.workspace ?? ""}`.trim();
          const sessionInfo = await chooseBrowserSession({
            ctx,
            browserHint,
            fallbackBrowserId: profileSelection.browser_id,
            requireDiscovery:
              !!opts.requireDiscovery ||
              (workspaceHint.length === 0 && projectIdHint.length === 0),
            sessionProjectId:
              `${opts.sessionProjectId ?? ""}`.trim() ||
              `${projectIdHint ?? ""}`.trim() ||
              undefined,
            activeOnly: !!opts.activeOnly,
          });
          let resolvedProjectId: string | undefined;
          let projectError: string | undefined;
          try {
            resolvedProjectId = await resolveTargetProjectId({
              deps,
              ctx,
              workspace: workspaceHint,
              projectId: projectIdHint,
              sessionInfo,
            });
          } catch (err) {
            projectError = `${err}`;
          }
          let workspaceSummary:
            | {
                workspace_id: string;
                title?: string;
                host_id?: string | null;
              }
            | undefined;
          if (resolvedProjectId) {
            try {
              const ws = await deps.resolveWorkspace(ctx, resolvedProjectId);
              workspaceSummary = {
                workspace_id: ws.project_id,
                ...(ws.title ? { title: ws.title } : {}),
                ...(ws.host_id != null ? { host_id: ws.host_id } : {}),
              };
            } catch {
              // best-effort enrichment only
            }
          }
          return {
            browser_id: sessionInfo.browser_id,
            session_name: sessionInfo.session_name ?? "",
            active_project_id: sessionInfo.active_project_id ?? "",
            open_projects: sessionInfo.open_projects?.length ?? 0,
            requested: {
              browser: browserHint || undefined,
              workspace: workspaceHint || undefined,
              project_id: projectIdHint || undefined,
              session_project_id: `${opts.sessionProjectId ?? ""}`.trim() || undefined,
              active_only: !!opts.activeOnly,
              require_discovery: !!opts.requireDiscovery,
            },
            resolved: {
              project_id: resolvedProjectId,
              ...(workspaceSummary ? { workspace: workspaceSummary } : {}),
              ...(projectError ? { project_error: projectError } : {}),
            },
            ...sessionTargetContext(ctx, sessionInfo, resolvedProjectId),
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
        });
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
        });
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
          });
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
          });
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
      "--fullpage",
      "capture full-page screenshot (native renderer; DOM renderer uses html root)",
    )
    .option("--viewport-width <n>", "set viewport width before capture (native)")
    .option("--viewport-height <n>", "set viewport height before capture (native)")
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
          fullpage?: boolean;
          viewportWidth?: string;
          viewportHeight?: string;
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

          const fullPage = !!opts.fullpage;
          const selectorRaw = `${opts.selector ?? ""}`.trim();
          const selector = selectorRaw || (fullPage ? "html" : "body");
          const requestedRenderer = parseScreenshotRenderer(opts.renderer);
          const scale = Number(opts.scale ?? "1");
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error("--scale must be a positive number");
          }
          const viewportWidth = `${opts.viewportWidth ?? ""}`.trim()
            ? Math.floor(Number(opts.viewportWidth))
            : undefined;
          const viewportHeight = `${opts.viewportHeight ?? ""}`.trim()
            ? Math.floor(Number(opts.viewportHeight))
            : undefined;
          if ((viewportWidth == null) !== (viewportHeight == null)) {
            throw new Error("--viewport-width and --viewport-height must be provided together");
          }
          if (
            viewportWidth != null &&
            (!Number.isFinite(viewportWidth) || viewportWidth <= 0)
          ) {
            throw new Error("--viewport-width must be a positive integer");
          }
          if (
            viewportHeight != null &&
            (!Number.isFinite(viewportHeight) || viewportHeight <= 0)
          ) {
            throw new Error("--viewport-height must be a positive integer");
          }
          if (requestedRenderer === "media" && fullPage) {
            throw new Error("--fullpage is not supported with --renderer media");
          }
          if (
            requestedRenderer === "media" &&
            (viewportWidth != null || viewportHeight != null)
          ) {
            throw new Error(
              "--viewport-width/--viewport-height are not supported with --renderer media",
            );
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
          let result: Record<string, unknown> | undefined;
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
                fullPage,
                viewportWidth,
                viewportHeight,
              });
              result = nativeResult.result;
              spawnedUsed = nativeResult.spawned;
              rendererUsed = "native";
            } catch (err) {
              if (requestedRenderer === "native") {
                throw err;
              }
              if (viewportWidth != null || viewportHeight != null) {
                throw new Error(
                  `${err}\n\nviewport controls require native screenshot capture from a spawned browser session; retry with --renderer native after 'cocalc browser session spawn --use'.`,
                );
              }
            }
          }

          if (!result) {
            const browserClient = deps.createBrowserSessionClient({
              account_id: ctx.accountId,
              browser_id: sessionInfo.browser_id,
              client: ctx.remote.client,
              timeout: timeoutMs,
            });
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
            const opResult = op?.result;
            result =
              opResult && typeof opResult === "object"
                ? (opResult as Record<string, unknown>)
                : {};
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
            full_page: !!result?.full_page || fullPage,
            ...(viewportWidth != null ? { viewport_width: viewportWidth } : {}),
            ...(viewportHeight != null ? { viewport_height: viewportHeight } : {}),
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
          });
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

  const actionUtils: BrowserActionRegisterUtils = {
    loadProfileSelection,
    browserHintFromOption,
    chooseBrowserSession,
    resolveTargetProjectId,
    resolveBrowserPolicyAndPosture,
    parseOptionalDurationMs,
    parseCoordinateSpace,
    readScreenshotMeta,
    parseRequiredNumber,
    sessionTargetContext,
    parseScrollBehavior,
    parseScrollAlign,
    durationToMs,
  };
  registerBrowserActionCommands({ browser, deps, utils: actionUtils });

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
          });
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
          });
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
          });
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
