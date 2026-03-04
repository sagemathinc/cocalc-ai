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
import {
  type AppExposureFrontAuth,
  type AppExposureState,
  exposeApp as exposeAppState,
  getAppExposureState,
  listAppExposureStates,
  unexposeApp as unexposeAppState,
} from "./state";

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

const children: Record<string, RunningApp> = Object.create(null);
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
  source: "ss" | "procfs";
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
      rewritePath: string;
    };

function getProxyUrl(port: number): string {
  return join(basePath, `/${project_id}/proxy/${port}/`);
}

function parseSsOutput(raw: string): Array<{ host: string; port: number }> {
  const out: Array<{ host: string; port: number }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const cols = text.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[3];
    const m = local.match(/^(.*):(\d+)$/);
    if (!m) continue;
    let host = m[1] ?? "";
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ host: host || "0.0.0.0", port });
  }
  return out;
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

async function parseProcTcp(path: string, family: "tcp" | "tcp6"): Promise<Array<{ host: string; port: number }>> {
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
  const fromSs = await new Promise<Array<{ host: string; port: number }> | undefined>((resolve) => {
    const child = spawn("ss", ["-ltnH"], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      if (code !== 0) return resolve(undefined);
      resolve(parseSsOutput(Buffer.concat(chunks).toString("utf8")));
    });
  });
  const source: "ss" | "procfs" = fromSs ? "ss" : "procfs";
  const sockets =
    fromSs ??
    [
      ...(await parseProcTcp("/proc/net/tcp", "tcp")),
      ...(await parseProcTcp("/proc/net/tcp6", "tcp6")),
    ];
  const byPort = new Map<number, Set<string>>();
  for (const { host, port } of sockets) {
    if (!byPort.has(port)) byPort.set(port, new Set());
    byPort.get(port)!.add(host);
  }
  const managedByPort = new Map<number, string[]>();
  const statuses = await listAppStatuses();
  for (const row of statuses) {
    if (row.kind !== "service" || row.state !== "running" || !row.port) continue;
    if (!managedByPort.has(row.port)) managedByPort.set(row.port, []);
    managedByPort.get(row.port)!.push(row.id);
  }
  const ignoredPorts = new Set<number>();
  const proxyPort = Number(process.env.COCALC_PROXY_PORT ?? 0);
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
    throw new Error(`app '${spec.id}' has kind='${spec.kind}', expected 'static'`);
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

  const MAX = 1 * 1024 * 1024;
  const append = (prev: Buffer, chunk: Buffer) => {
    if (prev.length + chunk.length <= MAX) {
      return Buffer.concat([prev, chunk], prev.length + chunk.length);
    }
    if (chunk.length >= MAX) {
      return chunk.subarray(chunk.length - MAX);
    }
    const keep = prev.subarray(prev.length - (MAX - chunk.length));
    return Buffer.concat([keep, chunk], MAX);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    server.stdout = append(server.stdout, chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    server.stderr = append(server.stderr, chunk);
  });

  child.on("error", (err) => {
    server.spawnError = err;
  });

  child.on("exit", (code, signal) => {
    server.exit = { code, signal };
    server.ready = false;
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

export async function startApp(id: string): Promise<AppStatus> {
  const spec = assertServiceSpec(await getAppSpec(id));
  const existing = children[spec.id];
  if (existing) {
    const running = isChildRunning(existing.child);
    if (running) {
      return await statusApp(spec.id);
    }
    clearChild(spec.id);
  }

  const preferredPort = spec.network.port;
  const port = await getPort({ port: preferredPort });
  const host = spec.network.listen_host || "127.0.0.1";
  const url = getProxyUrl(port);
  const cmd = spec.command.exec;
  const args = spec.command.args ?? [];
  logger.debug("start app", { id: spec.id, cmd, args, host, port, url });

  const child = spawn(cmd, args, {
    cwd: spec.command.cwd ?? process.env.HOME,
    env: {
      ...process.env,
      ...(spec.command.env ?? {}),
      PORT: `${port}`,
      HOST: host,
      APP_BASE_URL: url,
    },
  });

  children[spec.id] = {
    id: spec.id,
    spec,
    child,
    host,
    port,
    url,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
  watchOutput(children[spec.id]);

  return await statusApp(spec.id);
}

export async function stopApp(id: string): Promise<void> {
  const spec = await getAppSpec(id);
  const running = children[spec.id];
  if (!running || !isChildRunning(running.child)) {
    return;
  }
  running.child.kill("SIGTERM");
  const exitedGracefully = await waitForChildExit(running.child, 1000);
  if (exitedGracefully) return;
  if (isChildRunning(running.child)) {
    running.child.kill("SIGKILL");
    await waitForChildExit(running.child, 2000);
  }
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
    status.state = "running";
    status.ready = true;
    status.url = normalizePrefix(staticSpec.proxy.base_path);
    return status;
  }

  const running = children[spec.id];
  if (!running || !isChildRunning(running.child)) {
    return status;
  }

  if (running.ready !== true) {
    running.ready = await isServerReady(running.port, "127.0.0.1");
  }

  return {
    id: spec.id,
    state: "running",
    kind: spec.kind,
    title: spec.title,
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
  opts?: { timeout?: number; interval?: number },
): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  if (spec.kind === "static") {
    return await statusApp(id);
  }
  await startApp(id);
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
  invalidateRouteCache();
  return saved;
}

export async function deleteApp(id: string): Promise<{ id: string; deleted: boolean; path: string }> {
  try {
    await stopApp(id);
  } catch {
    // keep delete behavior robust
  }
  clearChild(id);
  try {
    await unexposeApp(id);
  } catch {
    await unexposeAppState(id);
  }
  const result = await deleteAppSpec(id);
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
  const specs = rows.map((row) => row.spec).filter((spec): spec is AppSpec => !!spec);
  routeCache = { at: now, specs };
  return specs;
}

export async function resolveAppProxyTarget({
  base,
  url,
}: {
  base: string;
  url: string;
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
      pathname.length > fullPrefix.length ? pathname.slice(fullPrefix.length) : "";
    const stripPrefixPath = `${suffix || "/"}${parsed.search ?? ""}`;
    const finalPath = spec.proxy.strip_prefix
      ? stripPrefixPath
      : `${pathname}${parsed.search ?? ""}`;
    if (spec.kind === "static") {
      const staticSpec = assertStaticSpec(spec);
      return {
        app_id: spec.id,
        kind: "static",
        root: staticSpec.static.root,
        index: staticSpec.static.index,
        cache_control: staticSpec.static.cache_control,
        rewritePath: finalPath,
      };
    }

    const serviceSpec = assertServiceSpec(spec);
    const startupTimeout = Math.max(
      1_000,
      (serviceSpec.wake.startup_timeout_s || 120) * 1000,
    );
    const status = serviceSpec.wake.enabled
      ? await ensureRunning(serviceSpec.id, { timeout: startupTimeout, interval: 500 })
      : await statusApp(serviceSpec.id);
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
  const isLaunchpad =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad";
  let reserved:
    | {
        hostname: string;
        label: string;
        url_public: string;
      }
    | undefined;
  if (isLaunchpad) {
    try {
      const hub = hubApi(conat());
      const policy = await hub.system.getProjectAppPublicPolicy();
      warnings.push(...(policy?.warnings ?? []));
      if (policy?.enabled) {
        const value = await hub.system.reserveProjectAppPublicSubdomain({
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
    if (isLaunchpad && reserved) {
      try {
        const hub = hubApi(conat());
        await hub.system.releaseProjectAppPublicSubdomain({ app_id: id });
      } catch {
        // ignore cleanup errors after a failed local state write
      }
    }
    throw err;
  }
  const status = await statusApp(id);
  if (warnings.length > 0) {
    status.warnings = [...new Set(warnings)];
  }
  return status;
}

export async function unexposeApp(id: string): Promise<AppStatus> {
  await getAppSpec(id);
  const isLaunchpad =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad";
  if (isLaunchpad) {
    try {
      const hub = hubApi(conat());
      await hub.system.releaseProjectAppPublicSubdomain({ app_id: id });
    } catch (err) {
      logger.warn("failed to release app public subdomain", {
        app_id: id,
        err: `${err}`,
      });
    }
  }
  await unexposeAppState(id);
  return await statusApp(id);
}

export async function appLogs(id: string): Promise<{
  id: string;
  state: "running" | "stopped";
  stdout: string;
  stderr: string;
}> {
  const status = await statusApp(id);
  const stdout =
    status.stdout?.toString("utf8").replace(/\u0000+$/g, "") ?? "";
  const stderr =
    status.stderr?.toString("utf8").replace(/\u0000+$/g, "") ?? "";
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
}): Promise<DetectedAppPort[]> {
  const includeManaged = !!opts?.include_managed;
  const limit = Math.max(1, Math.floor(Number(opts?.limit ?? 200)));
  const detected = await detectListeningPorts();
  const filtered = includeManaged ? detected : detected.filter((d) => !d.managed);
  return filtered.slice(0, limit);
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
        message: "Service process is running but readiness is not confirmed yet.",
        suggestion: "Inspect logs and health endpoint, then retry readiness check.",
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
        suggestion: "Set cache_control for better CDN behavior and egress control.",
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
        suggestion: "Use front auth token unless your app intentionally supports anonymous access.",
      });
    }
  }

  const launchpad =
    `${process.env.COCALC_PRODUCT ?? ""}`.trim().toLowerCase() === "launchpad";
  const suggested_actions: string[] = [];
  if (launchpad) {
    try {
      const policy = await hubApi(conat()).system.getProjectAppPublicPolicy();
      for (const warning of policy.warnings ?? []) {
        add({
          id: `policy.${warning.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`,
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
