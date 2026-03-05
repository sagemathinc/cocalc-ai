/*
Spawn/session state helpers for browser automation sessions.

This module owns lifecycle state persisted under ~/.local/share/cocalc/browser-sessions.
*/

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserSessionInfo } from "@cocalc/conat/hub/api/system";
import { basePathCookieName } from "@cocalc/util/misc";
import { durationToMs } from "../../../core/utils";
import type {
  BrowserCommandContext,
  PlaywrightDaemonConfig,
  SpawnCookie,
  SpawnStateRecord,
} from "./types";

export const SPAWN_MARKER_QUERY_PARAM = "_cocalc_browser_spawn";
export const DEFAULT_READY_TIMEOUT_MS = 20_000;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 45_000;
export const DEFAULT_DESTROY_TIMEOUT_MS = 10_000;
export const SPAWN_STATE_DIR = join(
  homedir() || process.cwd(),
  ".local",
  "share",
  "cocalc",
  "browser-sessions",
  "v1",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSpawnStateDir(): void {
  mkdirSync(SPAWN_STATE_DIR, { recursive: true });
}

function readJsonFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

function cookieNameFor(apiUrl: string, name: string): string {
  const pathname = new URL(apiUrl).pathname || "/";
  const basePath = pathname.replace(/\/+$/, "") || "/";
  return basePathCookieName({ basePath, name });
}

export function spawnMarkerFromUrl(url: string | undefined): string | undefined {
  const clean = `${url ?? ""}`.trim();
  if (!clean) return undefined;
  try {
    const parsed = new URL(clean);
    const marker = `${parsed.searchParams.get(SPAWN_MARKER_QUERY_PARAM) ?? ""}`.trim();
    return marker || undefined;
  } catch {
    const match = clean.match(
      new RegExp(`[?&]${SPAWN_MARKER_QUERY_PARAM}=([^&#]+)`),
    );
    if (!match?.[1]) return undefined;
    try {
      return decodeURIComponent(match[1]).trim() || undefined;
    } catch {
      return `${match[1]}`.trim() || undefined;
    }
  }
}

export function sessionMatchesSpawnMarker(
  session: BrowserSessionInfo,
  marker: string,
): boolean {
  const clean = `${marker ?? ""}`.trim();
  if (!clean) return false;
  return spawnMarkerFromUrl(`${session.url ?? ""}`) === clean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomSpawnId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `pw-${Date.now().toString(36)}-${rand}`;
}

export function isSeaMode(): boolean {
  try {
    const sea = require("node:sea") as { isSea?: () => boolean };
    return typeof sea?.isSea === "function" ? !!sea.isSea() : false;
  } catch {
    return false;
  }
}

export function spawnStateFile(spawnId: string): string {
  const clean = `${spawnId ?? ""}`.trim();
  if (!clean || !/^[A-Za-z0-9._-]+$/.test(clean)) {
    throw new Error("spawn id must match /^[A-Za-z0-9._-]+$/");
  }
  return join(SPAWN_STATE_DIR, `${clean}.json`);
}

export function readSpawnState(path: string): SpawnStateRecord | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const row = readJsonFile(path);
    if (!row || typeof row !== "object") return undefined;
    return row as SpawnStateRecord;
  } catch {
    return undefined;
  }
}

export function writeSpawnState(path: string, value: SpawnStateRecord): void {
  ensureSpawnStateDir();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, path);
}

export function writeDaemonConfig(path: string, value: PlaywrightDaemonConfig): void {
  ensureSpawnStateDir();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function resolveSecret(value: unknown): string | undefined {
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

export function parseDiscoveryTimeout(
  value: string | undefined,
  fallbackMs: number,
): number {
  const clean = `${value ?? ""}`.trim();
  return clean ? Math.max(1_000, durationToMs(clean, fallbackMs)) : fallbackMs;
}

export function resolveChromiumExecutablePath(preferred?: string): string | undefined {
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

export function resolveSpawnTargetUrl({
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

export function withSpawnMarker(targetUrl: string, marker: string): string {
  const url = new URL(targetUrl);
  url.searchParams.set(SPAWN_MARKER_QUERY_PARAM, marker);
  return url.toString();
}

export function buildSpawnCookies({
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

export async function waitForSpawnStateReady({
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

export async function waitForSpawnedSession({
  ctx,
  marker,
  timeoutMs,
}: {
  ctx: BrowserCommandContext;
  marker: string;
  timeoutMs: number;
}): Promise<BrowserSessionInfo> {
  const started = Date.now();
  for (;;) {
    const sessions = (await ctx.hub.system.listBrowserSessions({
      include_stale: true,
    })) as BrowserSessionInfo[];
    const match = (sessions ?? []).find(
      (s) => sessionMatchesSpawnMarker(s, marker) && !s.stale,
    );
    if (match) return match;
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for spawned browser session heartbeat");
    }
    await sleep(1_000);
  }
}

export async function terminateSpawnedProcess({
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

export type SpawnStateReapResult = {
  spawn_id: string;
  state_file: string;
  daemon_pid: number;
  browser_pid: number;
  daemon_was_running: boolean;
  browser_was_running: boolean;
  daemon_terminated: boolean;
  daemon_force_killed: boolean;
  browser_terminated: boolean;
  browser_force_killed: boolean;
  state_file_removed: boolean;
};

export async function reapSpawnStates({
  timeoutMs,
  stopRunning,
  removeStateFiles,
}: {
  timeoutMs: number;
  stopRunning: boolean;
  removeStateFiles: boolean;
}): Promise<SpawnStateReapResult[]> {
  const rows: SpawnStateReapResult[] = [];
  const entries = listSpawnStates();
  for (const { file, state } of entries) {
    const daemonPid = Number(state.pid);
    const browserPid = Number(state.browser_pid ?? 0);
    const daemonWasRunning = isProcessRunning(daemonPid);
    const browserWasRunning = isProcessRunning(browserPid);
    let daemonTerminated = false;
    let daemonForceKilled = false;
    let browserTerminated = false;
    let browserForceKilled = false;

    if (daemonWasRunning && stopRunning) {
      const daemonStop = await terminateSpawnedProcess({
        pid: daemonPid,
        timeoutMs,
      });
      daemonTerminated = daemonStop.terminated;
      daemonForceKilled = daemonStop.killed;
    }
    const daemonRunningAfter = isProcessRunning(daemonPid);
    if (
      browserPid > 0 &&
      isProcessRunning(browserPid) &&
      (stopRunning || !daemonRunningAfter)
    ) {
      const browserStop = await terminateSpawnedProcess({
        pid: browserPid,
        timeoutMs,
      });
      browserTerminated = browserStop.terminated;
      browserForceKilled = browserStop.killed;
    }

    const daemonFinalRunning = isProcessRunning(daemonPid);
    const browserFinalRunning = isProcessRunning(browserPid);
    const fullyStopped = !daemonFinalRunning && !browserFinalRunning;
    let stateFileRemoved = false;
    if (fullyStopped) {
      const stoppedState: SpawnStateRecord = {
        ...state,
        status: "stopped",
        reason: stopRunning ? "reap-stop-running" : "reap-orphan-cleanup",
        stopped_at: nowIso(),
        updated_at: nowIso(),
      };
      if (removeStateFiles) {
        try {
          unlinkSync(file);
          stateFileRemoved = true;
        } catch {
          writeSpawnState(file, stoppedState);
        }
      } else {
        writeSpawnState(file, stoppedState);
      }
    }

    rows.push({
      spawn_id: state.spawn_id,
      state_file: file,
      daemon_pid: daemonPid,
      browser_pid: browserPid,
      daemon_was_running: daemonWasRunning,
      browser_was_running: browserWasRunning,
      daemon_terminated: daemonTerminated,
      daemon_force_killed: daemonForceKilled,
      browser_terminated: browserTerminated,
      browser_force_killed: browserForceKilled,
      state_file_removed: stateFileRemoved,
    });
  }
  return rows;
}

export function listSpawnStates(): Array<{ file: string; state: SpawnStateRecord }> {
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

export function resolveSpawnStateById(
  id: string,
): { file: string; state: SpawnStateRecord } | undefined {
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

export function resolveSpawnIpcDir({
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

export function resolveSpawnStateByBrowserId(
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
