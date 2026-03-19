/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPort from "get-port";
import { spawn } from "node:child_process";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { delay } from "awaiting";
import basePath from "@cocalc/backend/base-path";
import { conat } from "@cocalc/conat/client";
import { project_id } from "@cocalc/project/data";
import { hubApi } from "@cocalc/project/conat/hub";
import { getLogger } from "@cocalc/project/logger";
import type { AppTemplateCatalogEntry } from "@cocalc/conat/project/api/apps";
import {
  type AppStaticSpec,
  type AppServiceSpec,
  type AppSpec,
  deleteAppSpec,
  getAppSpec,
  listAppSpecs,
  type AppSpecRecord,
  upsertAppSpec as upsertAppSpecRaw,
} from "./specs";
import type { AppStaticIntegrationSpec } from "./public-viewer";
import {
  appIdForRunningServicePort,
  clearRunningServicePort,
  type AppExposureFrontAuth,
  type AppExposureState,
  exposeApp as exposeAppState,
  getAppExposureState,
  listAppExposureStates,
  setRunningServicePort,
  unexposeApp as unexposeAppState,
} from "./state";
import {
  deleteAppMetrics,
  getAppMetrics as getAppMetricsState,
  listAppMetrics as listAppMetricsState,
  recordAppWake,
} from "./metrics";
import { parseLsofListenOutput, parseSsOutput } from "./listen-parsers";
import { listAppTemplates as listAppTemplatesFromCatalog } from "./template-catalog";
import { resolveProxyListenPort } from "../servers/proxy/config";
export { listAppTemplatesFromCatalog as listAppTemplates };

const logger = getLogger("app-servers:control");
export const APP_PUBLIC_TOKEN_QUERY_PARAM = "cocalc_app_token";

interface RunningApp {
  id: string;
  spec: AppServiceSpec;
  child: ReturnType<typeof spawn>;
  host: string;
  port: number;
  url: string;
  stdout: Buffer;
  stderr: Buffer;
  ready?: boolean;
  spawnError?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}

interface StaticRefreshState {
  running?: Promise<void>;
  last_hit_ms?: number;
  last_started_ms?: number;
  last_finished_ms?: number;
  last_success_ms?: number;
  last_error?: string;
  last_reason?: "first-hit" | "stale-hit";
  stdout: Buffer;
  stderr: Buffer;
}

const children: Record<string, RunningApp> = Object.create(null);
const staticRefresh: Record<string, StaticRefreshState> = Object.create(null);
let routeCache:
  | {
      at: number;
      specs: AppSpec[];
    }
  | undefined;

export interface AppStatus {
  id: string;
  state: "running" | "stopped";
  kind?: AppSpec["kind"];
  title?: string;
  path?: string;
  mtime?: number;
  port?: number;
  url?: string;
  ready?: boolean;
  pid?: number;
  stdout?: Buffer;
  stderr?: Buffer;
  spawnError?: unknown;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  exposure?: AppExposureState;
  warnings?: string[];
  error?: string;
}

export interface DetectedAppPort {
  port: number;
  hosts: string[];
  managed: boolean;
  managed_app_ids: string[];
  proxy_url: string;
  source: "ss" | "lsof" | "procfs";
}

export interface InstalledAppTemplate {
  key: string;
  label: string;
  available: boolean;
  status?: "available" | "missing" | "unknown";
  details?: string;
}

export interface AppAuditCheck {
  id: string;
  level: "info" | "warning" | "error";
  status: "pass" | "warn" | "fail";
  message: string;
  suggestion?: string;
}

export interface AppPublicReadinessAudit {
  app_id: string;
  title?: string;
  kind: "service" | "static";
  status: AppStatus;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: AppAuditCheck[];
  suggested_actions: string[];
  agent_prompt: string;
}

export async function appMetrics(id: string, opts?: { minutes?: number }) {
  return getAppMetricsState(id, opts);
}

export async function listMetrics(opts?: { minutes?: number }) {
  return listAppMetricsState(opts);
}

export type AppProxyTarget =
  | {
      app_id: string;
      kind: "service";
      port: number;
      rewritePath?: string;
    }
  | {
      app_id: string;
      kind: "static";
      root: string;
      index?: string;
      cache_control?: string;
      integration?: AppStaticIntegrationSpec;
      rewritePath: string;
    };

const MAX_APP_LOG_BYTES = 1 * 1024 * 1024;

type StartAppOptions = {
  preferredPort?: number;
  publicMode?: boolean;
};

function getProxyUrl(port: number): string {
  return join(basePath, `/${project_id}/proxy/${port}/`);
}

function appendLimited(
  prev: Buffer,
  chunk: Buffer,
  maxBytes = MAX_APP_LOG_BYTES,
): Buffer {
  if (prev.length + chunk.length <= maxBytes) {
    return Buffer.concat([prev, chunk], prev.length + chunk.length);
  }
  if (chunk.length >= maxBytes) {
    return chunk.subarray(chunk.length - maxBytes);
  }
  const keep = prev.subarray(prev.length - (maxBytes - chunk.length));
  return Buffer.concat([keep, chunk], maxBytes);
}

function decodeIpv4Hex(hex: string): string {
  if (hex.length !== 8) return "0.0.0.0";
  const bytes: number[] = [];
  for (let i = 0; i < 8; i += 2) {
    bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  bytes.reverse();
  return bytes.join(".");
}

function decodeIpv6Hex(hex: string): string {
  if (hex.length !== 32) return "::";
  const groups: string[] = [];
  for (let i = 0; i < 32; i += 4) {
    groups.push(hex.slice(i, i + 4));
  }
  return groups.join(":").replace(/(^|:)0{1,3}/g, "$1");
}

async function parseProcTcp(
  path: string,
  family: "tcp" | "tcp6",
): Promise<Array<{ host: string; port: number }>> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Array<{ host: string; port: number }> = [];
  const lines = raw.split(/\r?\n/).slice(1);
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    const cols = text.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1] ?? "";
    const state = cols[3] ?? "";
    if (state !== "0A") continue; // LISTEN
    const m = local.match(/^([0-9A-Fa-f]+):([0-9A-Fa-f]+)$/);
    if (!m) continue;
    const ipHex = m[1];
    const portHex = m[2];
    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0) continue;
    const host = family === "tcp" ? decodeIpv4Hex(ipHex) : decodeIpv6Hex(ipHex);
    out.push({ host, port });
  }
  return out;
}

async function detectListeningPorts(): Promise<DetectedAppPort[]> {
  const fromSs = await new Promise<
    Array<{ host: string; port: number }> | undefined
  >((resolve) => {
    const child = spawn("ss", ["-ltnH"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      if (code !== 0) return resolve(undefined);
      resolve(parseSsOutput(Buffer.concat(chunks).toString("utf8")));
    });
  });
  const fromLsof =
    fromSs == null
      ? await new Promise<Array<{ host: string; port: number }> | undefined>(
          (resolve) => {
            const child = spawn(
              "lsof",
              ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"],
              {
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
            const chunks: Buffer[] = [];
            child.stdout?.on("data", (c: Buffer) => chunks.push(c));
            child.once("error", () => resolve(undefined));
            child.once("close", (code) => {
              if (code !== 0) return resolve(undefined);
              resolve(
                parseLsofListenOutput(Buffer.concat(chunks).toString("utf8")),
              );
            });
          },
        )
      : undefined;
  const source: "ss" | "lsof" | "procfs" = fromSs
    ? "ss"
    : fromLsof
      ? "lsof"
      : "procfs";
  const sockets = [
    ...(fromSs ?? fromLsof ?? []),
    ...(fromSs == null && fromLsof == null
      ? [
          ...(await parseProcTcp("/proc/net/tcp", "tcp")),
          ...(await parseProcTcp("/proc/net/tcp6", "tcp6")),
        ]
      : []),
  ];
  const byPort = new Map<number, Set<string>>();
  for (const { host, port } of sockets) {
    if (!byPort.has(port)) byPort.set(port, new Set());
    byPort.get(port)!.add(host);
  }
  const managedByPort = new Map<number, string[]>();
  const statuses = await listAppStatuses();
  for (const row of statuses) {
    if (row.kind !== "service" || row.state !== "running" || !row.port)
      continue;
    if (!managedByPort.has(row.port)) managedByPort.set(row.port, []);
    managedByPort.get(row.port)!.push(row.id);
  }
  const ignoredPorts = new Set<number>();
  const proxyPort = resolveProxyListenPort(
    process.env.COCALC_PROXY_PORT == null
      ? undefined
      : Number(process.env.COCALC_PROXY_PORT),
  );
  if (Number.isInteger(proxyPort) && proxyPort > 0) ignoredPorts.add(proxyPort);
  const hubPort = Number(process.env.HUB_PORT ?? 0);
  if (Number.isInteger(hubPort) && hubPort > 0) ignoredPorts.add(hubPort);
  const entries: DetectedAppPort[] = [];
  for (const [port, hostSet] of byPort.entries()) {
    if (ignoredPorts.has(port)) continue;
    const managed_app_ids = managedByPort.get(port) ?? [];
    entries.push({
      port,
      hosts: [...hostSet].sort(),
      managed: managed_app_ids.length > 0,
      managed_app_ids,
      proxy_url: getProxyUrl(port),
      source,
    });
  }
  entries.sort((a, b) => a.port - b.port);
  return entries;
}

function normalizeProbeHost(hosts: string[]): string {
  for (const host of hosts) {
    if (host === "127.0.0.1" || host === "::1") return host;
  }
  return "127.0.0.1";
}

async function portLooksHttp(port: number, host: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750);
    socket.once("connect", () => {
      socket.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    });
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.startsWith("HTTP/")) {
        finish(true);
      }
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => {
      if (!settled) {
        const text = Buffer.concat(chunks).toString("utf8");
        finish(text.startsWith("HTTP/"));
      }
    });
  });
}

async function detectHttpPorts(
  entries: DetectedAppPort[],
): Promise<DetectedAppPort[]> {
  const out: DetectedAppPort[] = [];
  for (const entry of entries) {
    const host = normalizeProbeHost(entry.hosts);
    if (await portLooksHttp(entry.port, host)) {
      out.push(entry);
    }
  }
  return out;
}

async function runAvailabilityCheck({
  cmd,
  timeoutMs = 12000,
}: {
  cmd: string;
  timeoutMs?: number;
}): Promise<{
  available: boolean;
  status: "available" | "missing" | "unknown";
  details?: string;
}> {
  return await new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve({
          available: false,
          status: "unknown",
          details: "install check timed out",
        });
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ available: false, status: "unknown", details: `${err}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const text = Buffer.concat([...stdout, ...stderr])
        .toString("utf8")
        .trim();
      const defaultDetails = (() => {
        if (code === 0) return undefined;
        const commandV = cmd.match(/^\s*command -v\s+([A-Za-z0-9._-]+)/);
        if (commandV?.[1]) {
          return `${commandV[1]} not found in PATH`;
        }
        return `install check exited with code ${code ?? "unknown"}`;
      })();
      resolve({
        available: code === 0,
        status: code === 0 ? "available" : "missing",
        details: text ? text.split(/\r?\n/)[0].slice(0, 160) : defaultDetails,
      });
    });
  });
}

function templateInstallLabel(
  template: Pick<AppTemplateCatalogEntry, "title" | "short_label">,
): string {
  return template.short_label ?? template.title;
}

export async function detectInstalledTemplatesFromCatalog(
  templates: Array<
    Pick<
      AppTemplateCatalogEntry,
      "id" | "title" | "short_label" | "detect" | "preset"
    >
  >,
  runCheck: (opts: { cmd: string; timeoutMs?: number }) => Promise<{
    available: boolean;
    status: "available" | "missing" | "unknown";
    details?: string;
  }> = runAvailabilityCheck,
): Promise<InstalledAppTemplate[]> {
  return await Promise.all(
    templates.map(async (template) => {
      const key = template.id;
      const label = templateInstallLabel(template);
      if (template.preset.kind === "static") {
        return {
          key,
          label,
          available: true,
          status: "available",
          details: "built in static hosting",
        };
      }
      const commands = (template.detect?.commands ?? []).filter(
        (cmd): cmd is string => typeof cmd === "string" && cmd.trim() !== "",
      );
      if (commands.length === 0) {
        return {
          key,
          label,
          available: false,
          status: "unknown",
          details: "no install check defined in template catalog",
        };
      }

      let firstMissing:
        | {
            status: "missing";
            details?: string;
          }
        | undefined;
      let firstUnknown:
        | {
            status: "unknown";
            details?: string;
          }
        | undefined;

      for (const cmd of commands) {
        const result = await runCheck({ cmd });
        if (result.available) {
          return {
            key,
            label,
            available: true,
            status: "available",
            details: result.details,
          };
        }
        if (result.status === "missing" && firstMissing == null) {
          firstMissing = { status: "missing", details: result.details };
        } else if (result.status === "unknown" && firstUnknown == null) {
          firstUnknown = { status: "unknown", details: result.details };
        }
      }

      const finalStatus = firstUnknown != null ? "unknown" : "missing";
      const details =
        (firstUnknown?.details ?? firstMissing?.details) ||
        "install check unavailable";
      return {
        key,
        label,
        available: false,
        status: finalStatus,
        details,
      };
    }),
  );
}

function auditSummary(checks: AppAuditCheck[]) {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const c of checks) {
    if (c.status === "pass") pass += 1;
    else if (c.status === "warn") warn += 1;
    else fail += 1;
  }
  return { pass, warn, fail };
}

function invalidateRouteCache(): void {
  routeCache = undefined;
}

function assertServiceSpec(spec: AppSpec): AppServiceSpec {
  if (spec.kind !== "service") {
    throw new Error(
      `app '${spec.id}' has kind='${spec.kind}', but service runtime is not implemented for this kind yet`,
    );
  }
  return spec;
}

function assertStaticSpec(spec: AppSpec): AppStaticSpec {
  if (spec.kind !== "static") {
    throw new Error(
      `app '${spec.id}' has kind='${spec.kind}', expected 'static'`,
    );
  }
  return spec;
}

function toStatusFromRecord(record: AppSpecRecord): AppStatus {
  if (record.error) {
    return {
      id: record.id,
      state: "stopped",
      path: record.path,
      mtime: record.mtime,
      error: record.error,
    };
  }
  const spec = record.spec;
  if (!spec) {
    return {
      id: record.id,
      state: "stopped",
      path: record.path,
      mtime: record.mtime,
      error: "spec missing",
    };
  }
  return {
    id: spec.id,
    state: "stopped",
    kind: spec.kind,
    title: spec.title,
    path: record.path,
    mtime: record.mtime,
  };
}

function watchOutput(server: RunningApp): void {
  const { child } = server;
  if (!child.stdout || !child.stderr) {
    throw new Error("spawn requires stdout/stderr pipes");
  }

  child.stdout.on("data", (chunk: Buffer) => {
    server.stdout = appendLimited(server.stdout, chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    server.stderr = appendLimited(server.stderr, chunk);
  });

  child.on("error", (err) => {
    server.spawnError = err;
  });

  child.on("exit", (code, signal) => {
    server.exit = { code, signal };
    server.ready = false;
    void clearRunningServicePort(server.id);
  });
}

async function isServerReady(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 500,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function clearChild(id: string): void {
  const existing = children[id];
  if (!existing) return;
  existing.child.stdout?.removeAllListeners();
  existing.child.stderr?.removeAllListeners();
  existing.child.removeAllListeners();
  delete children[id];
  void clearRunningServicePort(id);
}

function getStaticRefreshState(id: string): StaticRefreshState {
  if (!staticRefresh[id]) {
    staticRefresh[id] = {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }
  return staticRefresh[id];
}

function clearStaticRefreshState(id: string): void {
  delete staticRefresh[id];
}

function isChildRunning(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode == null && child.signalCode == null;
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (!isChildRunning(child)) return true;
  return await new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (exited: boolean) => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(!isChildRunning(child)), timeoutMs);
  });
}

async function runStaticRefresh(
  spec: AppStaticSpec,
  reason: "first-hit" | "stale-hit",
): Promise<void> {
  const refreshSpec = spec.static.refresh;
  if (!refreshSpec) return;
  const state = getStaticRefreshState(spec.id);
  if (state.running) {
    await state.running;
    return;
  }
  const timeoutMs = Math.max(1, refreshSpec.timeout_s || 120) * 1000;
  const cmd = refreshSpec.command.exec;
  const args = refreshSpec.command.args ?? [];
  const cwd = refreshSpec.command.cwd ?? spec.static.root ?? process.env.HOME;
  const env = {
    ...process.env,
    ...(refreshSpec.command.env ?? {}),
    APP_ID: spec.id,
    APP_STATIC_ROOT: spec.static.root,
    APP_BASE_PATH: spec.proxy.base_path,
  };
  const run = (async () => {
    state.last_reason = reason;
    state.last_started_ms = Date.now();
    state.last_error = undefined;
    state.stdout = Buffer.alloc(0);
    state.stderr = Buffer.alloc(0);
    logger.debug("start static refresh", {
      id: spec.id,
      reason,
      cmd,
      args,
      cwd,
      timeoutMs,
    });
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      state.stdout = appendLimited(state.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      state.stderr = appendLimited(state.stderr, chunk);
    });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            child.kill("SIGKILL");
          }
        }, 1000);
      }, timeoutMs);
    }
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", () => resolve({ code: 1, signal: null }));
    });
    if (timer) clearTimeout(timer);
    state.last_finished_ms = Date.now();
    if (timedOut) {
      state.last_error = `timed out after ${refreshSpec.timeout_s}s`;
      logger.warn("static refresh timed out", {
        id: spec.id,
        reason,
      });
      return;
    }
    if (result.code === 0) {
      state.last_success_ms = Date.now();
      state.last_error = undefined;
      return;
    }
    state.last_error = `exit code ${result.code ?? "unknown"}${result.signal ? ` (signal ${result.signal})` : ""}`;
    logger.warn("static refresh failed", {
      id: spec.id,
      reason,
      code: result.code,
      signal: result.signal,
      stderr: state.stderr.toString("utf8").slice(-1000),
    });
  })();
  state.running = run;
  try {
    await run;
  } finally {
    state.running = undefined;
  }
}

async function maybeRefreshStaticOnHit(spec: AppStaticSpec): Promise<void> {
  const refreshSpec = spec.static.refresh;
  if (!refreshSpec?.trigger_on_hit) return;
  const state = getStaticRefreshState(spec.id);
  const now = Date.now();
  state.last_hit_ms = now;
  if (state.running) {
    await state.running;
    return;
  }
  const staleAfterMs = Math.max(1, refreshSpec.stale_after_s || 3600) * 1000;
  const lastSuccess = state.last_success_ms;
  const reason: "first-hit" | "stale-hit" | undefined =
    lastSuccess == null
      ? "first-hit"
      : now - lastSuccess >= staleAfterMs
        ? "stale-hit"
        : undefined;
  if (!reason) return;
  try {
    await runStaticRefresh(spec, reason);
  } catch (err) {
    state.last_error = `${err}`;
    logger.warn("static refresh on-hit failed", {
      id: spec.id,
      err: `${err}`,
    });
  }
}

function staticRefreshWarnings(spec: AppStaticSpec): string[] {
  const refreshSpec = spec.static.refresh;
  if (!refreshSpec) return [];
  const state = staticRefresh[spec.id];
  if (!state) return [];
  const warnings: string[] = [];
  if (state.running) {
    warnings.push("Static refresh is running.");
  }
  if (state.last_error) {
    warnings.push(`Last static refresh failed: ${state.last_error}.`);
  }
  return warnings;
}

export async function startApp(
  id: string,
  opts?: StartAppOptions,
): Promise<AppStatus> {
  const spec = assertServiceSpec(await getAppSpec(id));
  const existing = children[spec.id];
  if (existing) {
    const running = isChildRunning(existing.child);
    if (running) {
      return await statusApp(spec.id);
    }
    clearChild(spec.id);
  }

  const exposure = await getAppExposureState(spec.id);
  const publicMode = opts?.publicMode ?? exposure?.mode === "public";
  const preferredPort = opts?.preferredPort ?? spec.network.port;
  const host = spec.network.listen_host || "127.0.0.1";
  const port = await getPort({ port: preferredPort, host });
  const localUrl = getProxyUrl(port);
  const appBaseUrl = publicMode ? "/" : localUrl;
  const cmd = spec.command.exec;
  const args = spec.command.args ?? [];
  logger.debug("start app", {
    id: spec.id,
    cmd,
    args,
    host,
    port,
    localUrl,
    appBaseUrl,
    publicMode,
  });

  const child = spawn(cmd, args, {
    cwd: spec.command.cwd ?? process.env.HOME,
    env: {
      ...process.env,
      ...(spec.command.env ?? {}),
      PORT: `${port}`,
      HOST: host,
      APP_BASE_URL: appBaseUrl,
      APP_LOCAL_BASE_URL: localUrl,
      APP_PUBLIC_EXPOSED: publicMode ? "1" : "0",
    },
  });

  children[spec.id] = {
    id: spec.id,
    spec,
    child,
    host,
    port,
    url: localUrl,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  watchOutput(children[spec.id]);
  await setRunningServicePort(spec.id, port);

  return await statusApp(spec.id);
}

export async function stopApp(id: string): Promise<void> {
  const spec = await getAppSpec(id);
  const running = children[spec.id];
  if (!running || !isChildRunning(running.child)) {
    await clearRunningServicePort(spec.id);
    return;
  }
  running.child.kill("SIGTERM");
  const exitedGracefully = await waitForChildExit(running.child, 1000);
  if (exitedGracefully) {
    await clearRunningServicePort(spec.id);
    return;
  }
  if (isChildRunning(running.child)) {
    running.child.kill("SIGKILL");
    await waitForChildExit(running.child, 2000);
  }
  await clearRunningServicePort(spec.id);
}

export async function statusApp(id: string): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  const status: AppStatus = {
    id: spec.id,
    state: "stopped",
    kind: spec.kind,
    title: spec.title,
    exposure: await getAppExposureState(spec.id),
  };
  if (spec.kind === "static") {
    const staticSpec = assertStaticSpec(spec);
    const refreshState = staticRefresh[spec.id];
    const warnings = staticRefreshWarnings(staticSpec);
    status.state = "running";
    status.ready = true;
    status.url = normalizePrefix(staticSpec.proxy.base_path);
    if (refreshState?.stdout?.length) status.stdout = refreshState.stdout;
    if (refreshState?.stderr?.length) status.stderr = refreshState.stderr;
    if (warnings.length > 0) status.warnings = warnings;
    return status;
  }

  const running = children[spec.id];
  if (!running) {
    return status;
  }
  if (!isChildRunning(running.child)) {
    return {
      ...status,
      ready: false,
      port: running.port,
      url: running.url,
      pid: running.child.pid,
      stdout: running.stdout,
      stderr: running.stderr,
      spawnError: running.spawnError,
      exit: running.exit,
    };
  }

  if (running.ready !== true) {
    running.ready = await isServerReady(running.port, "127.0.0.1");
  }

  return {
    id: spec.id,
    state: "running",
    kind: spec.kind,
    title: spec.title,
    exposure: status.exposure,
    port: running.port,
    url: running.url,
    ready: running.ready,
    pid: running.child.pid,
    stdout: running.stdout,
    stderr: running.stderr,
    spawnError: running.spawnError,
    exit: running.exit,
  };
}

export async function waitForAppState(
  id: string,
  target: "running" | "stopped",
  opts?: { timeout?: number; interval?: number },
): Promise<boolean> {
  const timeout = opts?.timeout ?? 30000;
  const interval = opts?.interval ?? 500;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await statusApp(id);
    if (target === "running") {
      if (s.state === "running" && s.ready === true) {
        return true;
      }
    } else if (s.state === "stopped") {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(interval, remaining));
  }
  return false;
}

export async function ensureRunning(
  id: string,
  opts?: {
    timeout?: number;
    interval?: number;
    preferredPort?: number;
    publicMode?: boolean;
  },
): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  if (spec.kind === "static") {
    return await statusApp(id);
  }
  await startApp(id, {
    preferredPort: opts?.preferredPort,
    publicMode: opts?.publicMode,
  });
  const ok = await waitForAppState(id, "running", opts);
  const status = await statusApp(id);
  if (!ok) {
    throw new Error(
      `timed out waiting for app '${id}' to become ready` +
        (status.stderr && status.stderr.length > 0
          ? `: ${status.stderr.toString().trim()}`
          : ""),
    );
  }
  return status;
}

export async function listAppStatuses(): Promise<AppStatus[]> {
  const specs = await listAppSpecs();
  const exposures = await listAppExposureStates();
  const out: AppStatus[] = [];
  for (const record of specs) {
    if (record.error || !record.spec) {
      out.push(toStatusFromRecord(record));
      continue;
    }
    try {
      const status = await statusApp(record.spec.id);
      status.path = record.path;
      status.mtime = record.mtime;
      status.exposure = exposures[record.spec.id];
      out.push(status);
    } catch (err) {
      out.push({
        id: record.spec.id,
        state: "stopped",
        kind: record.spec.kind,
        title: record.spec.title,
        path: record.path,
        mtime: record.mtime,
        exposure: exposures[record.spec.id],
        error: `${err}`,
      });
    }
  }
  return out;
}

export { getAppSpec, listAppSpecs };

export async function upsertAppSpec(spec: unknown): Promise<{
  id: string;
  path: string;
  spec: AppSpec;
}> {
  const saved = await upsertAppSpecRaw(spec);
  clearStaticRefreshState(saved.id);
  invalidateRouteCache();
  return saved;
}

export async function deleteApp(
  id: string,
): Promise<{ id: string; deleted: boolean; path: string }> {
  try {
    await stopApp(id);
  } catch {
    // keep delete behavior robust
  }
  clearChild(id);
  clearStaticRefreshState(id);
  try {
    await unexposeApp(id);
  } catch {
    await unexposeAppState(id);
  }
  const result = await deleteAppSpec(id);
  deleteAppMetrics(id);
  invalidateRouteCache();
  return result;
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

async function specsForRouting(): Promise<AppSpec[]> {
  const now = Date.now();
  if (routeCache && now - routeCache.at < 1000) {
    return routeCache.specs;
  }
  const rows = await listAppSpecs();
  const specs = rows
    .map((row) => row.spec)
    .filter((spec): spec is AppSpec => !!spec);
  routeCache = { at: now, specs };
  return specs;
}

export async function resolveAppProxyTarget({
  base,
  url,
  exposureMode: _exposureMode = "private",
}: {
  base: string;
  url: string;
  exposureMode?: "private" | "public";
}): Promise<AppProxyTarget | undefined> {
  const specs = await specsForRouting();
  const parsed = new URL(url, "http://project.local");
  const pathname = parsed.pathname;
  const basePrefix = normalizePrefix(base);
  for (const spec of specs) {
    const localPrefix = normalizePrefix(spec.proxy.base_path);
    const fullPrefix = normalizePrefix(`${basePrefix}${localPrefix}`);
    if (!(pathname === fullPrefix || pathname.startsWith(`${fullPrefix}/`))) {
      continue;
    }
    const suffix =
      pathname.length > fullPrefix.length
        ? pathname.slice(fullPrefix.length)
        : "";
    const stripPrefixPath = `${suffix || "/"}${parsed.search ?? ""}`;
    const finalPath = spec.proxy.strip_prefix
      ? stripPrefixPath
      : `${pathname}${parsed.search ?? ""}`;
    if (spec.kind === "static") {
      const staticSpec = assertStaticSpec(spec);
      await maybeRefreshStaticOnHit(staticSpec);
      return {
        app_id: spec.id,
        kind: "static",
        root: staticSpec.static.root,
        index: staticSpec.static.index,
        cache_control: staticSpec.static.cache_control,
        integration: staticSpec.integration,
        rewritePath: finalPath,
      };
    }

    const serviceSpec = assertServiceSpec(spec);
    const startupTimeout = Math.max(
      1_000,
      (serviceSpec.wake.startup_timeout_s || 120) * 1000,
    );
    const current =
      serviceSpec.wake.enabled || children[serviceSpec.id]
        ? await statusApp(serviceSpec.id)
        : undefined;
    if (serviceSpec.wake.enabled && current?.state !== "running") {
      recordAppWake(serviceSpec.id);
    }
    const status = serviceSpec.wake.enabled
      ? await ensureRunning(serviceSpec.id, {
          timeout: startupTimeout,
          interval: 500,
        })
      : (current ?? (await statusApp(serviceSpec.id)));
    if (status.state !== "running" || !status.port) {
      throw new Error(`app '${serviceSpec.id}' is not running`);
    }
    return {
      app_id: serviceSpec.id,
      kind: "service",
      port: status.port,
      rewritePath: finalPath,
    };
  }
  return undefined;
}

export async function managedServiceAppForPort(
  port: number,
): Promise<{ app_id: string; kind: "service" } | undefined> {
  const app_id = await appIdForRunningServicePort(port);
  return app_id ? { app_id, kind: "service" } : undefined;
}

async function restartServiceForExposureMode(
  spec: AppServiceSpec,
  {
    preferredPort,
    publicMode,
  }: {
    preferredPort?: number;
    publicMode: boolean;
  },
): Promise<AppStatus> {
  const running = children[spec.id];
  if (running && isChildRunning(running.child)) {
    await stopApp(spec.id);
  }
  return await ensureRunning(spec.id, {
    timeout: Math.max(1_000, (spec.wake.startup_timeout_s || 120) * 1000),
    interval: 500,
    preferredPort,
    publicMode,
  });
}

export async function exposeApp({
  id,
  ttl_s,
  auth_front = "token",
  random_subdomain = true,
  subdomain_label,
}: {
  id: string;
  ttl_s: number;
  auth_front?: AppExposureFrontAuth;
  random_subdomain?: boolean;
  subdomain_label?: string;
}): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  const warnings: string[] = [];
  const publicRestart =
    spec.kind === "service" ? assertServiceSpec(spec) : undefined;
  let preferredServicePort: number | undefined;
  let restartIntoPublicMode = false;
  let reserved:
    | {
        hostname: string;
        label: string;
        url_public: string;
      }
    | undefined;
  if (publicRestart) {
    const current = await statusApp(id);
    restartIntoPublicMode = current.state === "running";
    preferredServicePort = current.port ?? publicRestart.network.port;
    if (!preferredServicePort) {
      const started = await ensureRunning(id, {
        timeout: Math.max(
          1_000,
          (publicRestart.wake.startup_timeout_s || 120) * 1000,
        ),
        interval: 500,
      });
      restartIntoPublicMode = true;
      preferredServicePort = started.port ?? publicRestart.network.port;
    }
  }
  try {
    const hub = hubApi(conat());
    const policy = await hub.system.getProjectAppPublicPolicy({ project_id });
    warnings.push(...(policy?.warnings ?? []));
    if (policy?.enabled) {
      const value = await hub.system.reserveProjectAppPublicSubdomain({
        project_id,
        app_id: id,
        base_path: spec.proxy?.base_path ?? `/apps/${id}`,
        ttl_s,
        preferred_label: `${subdomain_label ?? ""}`.trim() || undefined,
        random_subdomain,
      });
      reserved = value;
      warnings.push(...(value?.warnings ?? []));
    }
  } catch (err) {
    logger.warn("failed to reserve app public subdomain", {
      app_id: id,
      err: `${err}`,
    });
    warnings.push(`App subdomain allocation failed: ${err}`);
  }

  try {
    await exposeAppState({
      app_id: id,
      ttl_s,
      auth_front,
      random_subdomain,
      subdomain_label: reserved?.label ?? subdomain_label,
      public_hostname: reserved?.hostname,
      public_url: reserved?.url_public,
    });
  } catch (err) {
    if (reserved) {
      try {
        const hub = hubApi(conat());
        await hub.system.releaseProjectAppPublicSubdomain({
          project_id,
          app_id: id,
        });
      } catch {
        // ignore cleanup errors after a failed local state write
      }
    }
    throw err;
  }
  const status =
    publicRestart && restartIntoPublicMode
      ? await restartServiceForExposureMode(publicRestart, {
          preferredPort: preferredServicePort,
          publicMode: true,
        })
      : await statusApp(id);
  if (warnings.length > 0) {
    status.warnings = [...new Set(warnings)];
  }
  return status;
}

export async function unexposeApp(id: string): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  const publicRestart =
    spec.kind === "service" ? assertServiceSpec(spec) : undefined;
  const current = publicRestart ? await statusApp(id) : undefined;
  const preferredServicePort = current?.port ?? publicRestart?.network.port;
  try {
    const hub = hubApi(conat());
    await hub.system.releaseProjectAppPublicSubdomain({
      project_id,
      app_id: id,
    });
  } catch (err) {
    logger.warn("failed to release app public subdomain", {
      app_id: id,
      err: `${err}`,
    });
  }
  await unexposeAppState(id);
  if (publicRestart && current?.state === "running") {
    return await restartServiceForExposureMode(publicRestart, {
      preferredPort: preferredServicePort,
      publicMode: false,
    });
  }
  return await statusApp(id);
}

export async function appLogs(id: string): Promise<{
  id: string;
  state: "running" | "stopped";
  stdout: string;
  stderr: string;
}> {
  const status = await statusApp(id);
  const stdout = status.stdout?.toString("utf8").replace(/\u0000+$/g, "") ?? "";
  const stderr = status.stderr?.toString("utf8").replace(/\u0000+$/g, "") ?? "";
  return {
    id: status.id,
    state: status.state,
    stdout,
    stderr,
  };
}

export async function detectApps(opts?: {
  include_managed?: boolean;
  limit?: number;
  http_only?: boolean;
}): Promise<DetectedAppPort[]> {
  const includeManaged = !!opts?.include_managed;
  const limit = Math.max(1, Math.floor(Number(opts?.limit ?? 200)));
  let detected = await detectListeningPorts();
  if (opts?.http_only) {
    detected = await detectHttpPorts(detected);
  }
  const filtered = includeManaged
    ? detected
    : detected.filter((d) => !d.managed);
  return filtered.slice(0, limit);
}

export async function detectInstalledTemplates(): Promise<
  InstalledAppTemplate[]
> {
  return await detectInstalledTemplatesFromCatalog(
    await listAppTemplatesFromCatalog(),
  );
}

export async function auditAppPublicReadiness(
  id: string,
): Promise<AppPublicReadinessAudit> {
  const spec = await getAppSpec(id);
  const status = await statusApp(id);
  const checks: AppAuditCheck[] = [];
  const add = (check: AppAuditCheck) => checks.push(check);

  add({
    id: "app.exists",
    level: "info",
    status: "pass",
    message: `App '${id}' is defined with kind='${spec.kind}'.`,
  });

  if (!spec.proxy?.base_path?.startsWith("/")) {
    add({
      id: "proxy.base_path",
      level: "error",
      status: "fail",
      message: "proxy.base_path is not absolute.",
      suggestion: "Set proxy.base_path to an absolute path like /apps/my-app.",
    });
  } else {
    add({
      id: "proxy.base_path",
      level: "info",
      status: "pass",
      message: `proxy.base_path='${spec.proxy.base_path}'.`,
    });
  }

  if (spec.kind === "service") {
    const host = `${spec.network.listen_host ?? ""}`.trim();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      add({
        id: "service.listen_host",
        level: "info",
        status: "pass",
        message: `Service binds to loopback host '${host}'.`,
      });
    } else {
      add({
        id: "service.listen_host",
        level: "warning",
        status: "warn",
        message: `Service listen_host='${host || "unset"}' is not strict loopback.`,
        suggestion: "Use 127.0.0.1 unless you explicitly need broader binding.",
      });
    }
    if (status.state === "running" && status.ready === true) {
      add({
        id: "service.running",
        level: "info",
        status: "pass",
        message: `Service is running and ready on port ${status.port}.`,
      });
    } else if (status.state === "running") {
      add({
        id: "service.running",
        level: "warning",
        status: "warn",
        message:
          "Service process is running but readiness is not confirmed yet.",
        suggestion:
          "Inspect logs and health endpoint, then retry readiness check.",
      });
    } else {
      add({
        id: "service.running",
        level: "warning",
        status: "warn",
        message: "Service is stopped.",
        suggestion: `Run 'cocalc workspace app start ${id} --wait'.`,
      });
    }
  } else {
    const cacheControl = `${spec.static.cache_control ?? ""}`.trim();
    if (cacheControl) {
      add({
        id: "static.cache_control",
        level: "info",
        status: "pass",
        message: `Static cache_control is configured: '${cacheControl}'.`,
      });
    } else {
      add({
        id: "static.cache_control",
        level: "warning",
        status: "warn",
        message: "Static app has no explicit cache_control.",
        suggestion:
          "Set cache_control for better CDN behavior and egress control.",
      });
    }
    const refresh = spec.static.refresh;
    if (!refresh) {
      add({
        id: "static.refresh",
        level: "info",
        status: "pass",
        message: "Static app has no refresh job configured.",
      });
    } else if (!refresh.trigger_on_hit) {
      add({
        id: "static.refresh",
        level: "warning",
        status: "warn",
        message: "Static refresh job is configured but trigger_on_hit=false.",
        suggestion:
          "Enable trigger_on_hit or run refresh manually to keep generated content current.",
      });
    } else {
      add({
        id: "static.refresh",
        level: "info",
        status: "pass",
        message: `Static refresh job is configured (stale_after=${refresh.stale_after_s}s, timeout=${refresh.timeout_s}s).`,
      });
    }
  }

  const exposure = status.exposure;
  if (!exposure || exposure.mode !== "public") {
    add({
      id: "exposure.public",
      level: "warning",
      status: "warn",
      message: "App is not currently publicly exposed.",
      suggestion: `Use 'cocalc workspace app expose ${id} --ttl 10m'.`,
    });
  } else {
    add({
      id: "exposure.public",
      level: "info",
      status: "pass",
      message: `Public exposure active${exposure.public_url ? ` at ${exposure.public_url}` : ""}.`,
    });
    if (exposure.auth_front === "token") {
      add({
        id: "exposure.front_auth",
        level: "info",
        status: "pass",
        message: "Front auth token is enabled for public access.",
      });
    } else {
      add({
        id: "exposure.front_auth",
        level: "warning",
        status: "warn",
        message: "Front auth is disabled (publicly unauthenticated).",
        suggestion:
          "Use front auth token unless your app intentionally supports anonymous access.",
      });
    }
  }

  const launchpad =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad";
  const suggested_actions: string[] = [];
  if (launchpad) {
    try {
      const policy = await hubApi(conat()).system.getProjectAppPublicPolicy({
        project_id,
      });
      for (const warning of policy.warnings ?? []) {
        add({
          id: `policy.${warning
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40)}`,
          level: "warning",
          status: "warn",
          message: warning,
        });
      }
      if (policy.metered_egress) {
        suggested_actions.push(
          "Enable aggressive Cloudflare caching and keep public TTL short on metered-egress hosts.",
        );
      }
    } catch (err) {
      add({
        id: "policy.lookup",
        level: "warning",
        status: "warn",
        message: `Could not read launchpad public app policy: ${err}`,
      });
    }
  }

  suggested_actions.push(`cocalc workspace app logs ${id} --tail 200`);
  if (status.state !== "running") {
    suggested_actions.push(`cocalc workspace app start ${id} --wait`);
  }
  if (!exposure || exposure.mode !== "public") {
    suggested_actions.push(`cocalc workspace app expose ${id} --ttl 10m`);
  }

  const summary = auditSummary(checks);
  const agent_prompt = [
    `Audit and improve public readiness for app '${id}'.`,
    `- Kind: ${spec.kind}`,
    `- Base path: ${spec.proxy.base_path}`,
    `- Current state: ${status.state}${status.ready === true ? " (ready)" : ""}`,
    `- Exposure mode: ${exposure?.mode ?? "private"}`,
    "",
    "Steps:",
    "1. Review app logs and runtime status.",
    "2. Fix readiness/start issues if needed.",
    "3. Verify loopback binding and proxy/base-path behavior.",
    "4. Apply safer public settings (token auth, TTL) when appropriate.",
    "5. Re-run readiness checks and summarize remaining risks.",
    "",
    `Quick commands: ${suggested_actions.join(" ; ")}`,
  ].join("\n");

  return {
    app_id: id,
    title: spec.title,
    kind: spec.kind,
    status,
    summary,
    checks,
    suggested_actions: [...new Set(suggested_actions)],
    agent_prompt,
  };
}

function closeAll() {
  for (const app of Object.values(children)) {
    if (isChildRunning(app.child)) {
      app.child.kill("SIGKILL");
    }
  }
}

process.once("exit", closeAll);
["SIGINT", "SIGTERM", "SIGQUIT"].forEach((sig) => {
  process.once(sig, () => {
    process.exit();
  });
});
