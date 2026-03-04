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
import { project_id } from "@cocalc/project/data";
import { getLogger } from "@cocalc/project/logger";
import {
  type AppServiceSpec,
  type AppSpec,
  deleteAppSpec,
  getAppSpec,
  listAppSpecs,
  type AppSpecRecord,
  upsertAppSpec as upsertAppSpecRaw,
} from "./specs";

const logger = getLogger("app-servers:control");

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
      specs: AppServiceSpec[];
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
  error?: string;
}

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

export async function startApp(id: string): Promise<AppStatus> {
  const spec = assertServiceSpec(await getAppSpec(id));
  const existing = children[spec.id];
  if (existing) {
    const running = existing.child.exitCode == null;
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
  if (!running || running.child.exitCode != null) {
    return;
  }
  running.child.kill("SIGTERM");
  await delay(1000);
  if (running.child.exitCode == null) {
    running.child.kill("SIGKILL");
  }
}

export async function statusApp(id: string): Promise<AppStatus> {
  const spec = await getAppSpec(id);
  const status: AppStatus = {
    id: spec.id,
    state: "stopped",
    kind: spec.kind,
    title: spec.title,
  };
  if (spec.kind !== "service") {
    status.error = "runtime not implemented for static apps yet";
    return status;
  }

  const running = children[spec.id];
  if (!running || running.child.exitCode != null) {
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
      out.push(status);
    } catch (err) {
      out.push({
        id: record.spec.id,
        state: "stopped",
        kind: record.spec.kind,
        title: record.spec.title,
        path: record.path,
        mtime: record.mtime,
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
  const result = await deleteAppSpec(id);
  invalidateRouteCache();
  return result;
}

function normalizePrefix(value: string): string {
  const withLeading = value.startsWith("/") ? value : `/${value}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

async function serviceSpecsForRouting(): Promise<AppServiceSpec[]> {
  const now = Date.now();
  if (routeCache && now - routeCache.at < 1000) {
    return routeCache.specs;
  }
  const rows = await listAppSpecs();
  const specs = rows
    .map((row) => row.spec)
    .filter((spec): spec is AppServiceSpec => !!spec && spec.kind === "service");
  routeCache = { at: now, specs };
  return specs;
}

export async function resolveAppProxyTarget({
  base,
  url,
}: {
  base: string;
  url: string;
}): Promise<
  | {
      app_id: string;
      port: number;
      rewritePath?: string;
    }
  | undefined
> {
  const specs = await serviceSpecsForRouting();
  const basePrefix = normalizePrefix(base);
  for (const spec of specs) {
    const localPrefix = normalizePrefix(spec.proxy.base_path);
    const fullPrefix = normalizePrefix(`${basePrefix}${localPrefix}`);
    if (!(url === fullPrefix || url.startsWith(`${fullPrefix}/`))) {
      continue;
    }
    const startupTimeout = Math.max(
      1_000,
      (spec.wake.startup_timeout_s || 120) * 1000,
    );
    const status = spec.wake.enabled
      ? await ensureRunning(spec.id, { timeout: startupTimeout, interval: 500 })
      : await statusApp(spec.id);
    if (status.state !== "running" || !status.port) {
      throw new Error(`app '${spec.id}' is not running`);
    }
    const suffix =
      url.length > fullPrefix.length ? url.slice(fullPrefix.length) : "";
    const rewritePath = spec.proxy.strip_prefix ? suffix || "/" : undefined;
    return {
      app_id: spec.id,
      port: status.port,
      rewritePath,
    };
  }
  return undefined;
}

function closeAll() {
  for (const app of Object.values(children)) {
    if (app.child.exitCode == null) {
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
