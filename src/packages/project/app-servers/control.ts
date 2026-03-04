/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPort from "get-port";
import { spawn } from "node:child_process";
import net from "node:net";
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
