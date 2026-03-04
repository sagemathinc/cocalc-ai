/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SPEC_EXT = ".json";
const APP_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/i;

export type AppSpecKind = "service" | "static";

export interface AppServiceSpec {
  version: 1;
  id: string;
  title?: string;
  kind: "service";
  command: {
    exec: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  network: {
    listen_host: string;
    port?: number;
    protocol: "http" | "https" | "ws";
  };
  proxy: {
    base_path: string;
    strip_prefix: boolean;
    websocket: boolean;
    health_path?: string;
    readiness_timeout_s: number;
  };
  wake: {
    enabled: boolean;
    keep_warm_s: number;
    startup_timeout_s: number;
  };
}

export interface AppStaticSpec {
  version: 1;
  id: string;
  title?: string;
  kind: "static";
  static: {
    root: string;
    index?: string;
    cache_control?: string;
  };
  proxy: {
    base_path: string;
    strip_prefix: boolean;
    websocket: false;
    readiness_timeout_s: number;
  };
  wake: {
    enabled: false;
    keep_warm_s: number;
    startup_timeout_s: number;
  };
}

export type AppSpec = AppServiceSpec | AppStaticSpec;

export interface AppSpecRecord {
  id: string;
  path: string;
  mtime?: number;
  spec?: AppSpec;
  error?: string;
}

function assertAppId(id: string): string {
  const normalized = `${id ?? ""}`.trim();
  if (!APP_ID_RE.test(normalized)) {
    throw new Error(
      `invalid app id '${id}'; expected ${APP_ID_RE.toString()} (1-64 chars)`,
    );
  }
  return normalized;
}

function asObject(input: unknown, context: string): Record<string, any> {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${context} must be an object`);
  }
  return input as Record<string, any>;
}

function asOptionalString(input: unknown): string | undefined {
  if (input == null) return undefined;
  const value = `${input}`.trim();
  return value.length > 0 ? value : undefined;
}

function asString(input: unknown, context: string): string {
  const value = asOptionalString(input);
  if (!value) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function asOptionalPositiveInt(input: unknown, context: string): number | undefined {
  if (input == null || input === "") return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
}

function asOptionalBoolean(input: unknown, defaultValue: boolean): boolean {
  if (input == null) return defaultValue;
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  const text = `${input}`.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(text)) return true;
  if (["false", "0", "no", "n", "off"].includes(text)) return false;
  return defaultValue;
}

function asStringArray(input: unknown, context: string): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error(`${context} must be a list of strings`);
  }
  return input.map((value, idx) => asString(value, `${context}[${idx}]`));
}

function asStringRecord(input: unknown, context: string): Record<string, string> | undefined {
  if (input == null) return undefined;
  const obj = asObject(input, context);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const valueText = asOptionalString(value);
    if (valueText == null) continue;
    out[`${key}`] = valueText;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeServiceSpec(input: Record<string, any>): AppServiceSpec {
  const id = assertAppId(asString(input.id, "spec.id"));
  const title = asOptionalString(input.title);

  const commandIn = asObject(input.command, "spec.command");
  const command = {
    exec: asString(commandIn.exec, "spec.command.exec"),
    args: asStringArray(commandIn.args, "spec.command.args"),
    cwd: asOptionalString(commandIn.cwd),
    env: asStringRecord(commandIn.env, "spec.command.env"),
  };

  const networkIn = asObject(input.network ?? {}, "spec.network");
  const protocolRaw = asOptionalString(networkIn.protocol) ?? "http";
  const protocol = ["http", "https", "ws"].includes(protocolRaw)
    ? (protocolRaw as "http" | "https" | "ws")
    : "http";
  const network = {
    listen_host: asOptionalString(networkIn.listen_host) ?? "127.0.0.1",
    port: asOptionalPositiveInt(networkIn.port, "spec.network.port"),
    protocol,
  };

  const proxyIn = asObject(input.proxy ?? {}, "spec.proxy");
  const proxy = {
    base_path: asOptionalString(proxyIn.base_path) ?? `/apps/${id}`,
    strip_prefix: asOptionalBoolean(proxyIn.strip_prefix, true),
    websocket: asOptionalBoolean(proxyIn.websocket, true),
    health_path: asOptionalString(proxyIn.health_path),
    readiness_timeout_s:
      asOptionalPositiveInt(proxyIn.readiness_timeout_s, "spec.proxy.readiness_timeout_s") ??
      45,
  };

  const wakeIn = asObject(input.wake ?? {}, "spec.wake");
  const wake = {
    enabled: asOptionalBoolean(wakeIn.enabled, true),
    keep_warm_s: asOptionalPositiveInt(wakeIn.keep_warm_s, "spec.wake.keep_warm_s") ?? 1800,
    startup_timeout_s:
      asOptionalPositiveInt(wakeIn.startup_timeout_s, "spec.wake.startup_timeout_s") ?? 120,
  };

  return {
    version: 1,
    id,
    title,
    kind: "service",
    command,
    network,
    proxy,
    wake,
  };
}

function normalizeStaticSpec(input: Record<string, any>): AppStaticSpec {
  const id = assertAppId(asString(input.id, "spec.id"));
  const title = asOptionalString(input.title);
  const staticIn = asObject(input.static, "spec.static");
  const proxyIn = asObject(input.proxy ?? {}, "spec.proxy");

  return {
    version: 1,
    id,
    title,
    kind: "static",
    static: {
      root: asString(staticIn.root, "spec.static.root"),
      index: asOptionalString(staticIn.index),
      cache_control: asOptionalString(staticIn.cache_control),
    },
    proxy: {
      base_path: asOptionalString(proxyIn.base_path) ?? `/apps/${id}`,
      strip_prefix: asOptionalBoolean(proxyIn.strip_prefix, true),
      websocket: false,
      readiness_timeout_s:
        asOptionalPositiveInt(proxyIn.readiness_timeout_s, "spec.proxy.readiness_timeout_s") ?? 45,
    },
    wake: {
      enabled: false,
      keep_warm_s: 0,
      startup_timeout_s: 0,
    },
  };
}

export function normalizeAppSpec(input: unknown): AppSpec {
  const obj = asObject(input, "spec");
  const version = Number(obj.version ?? 1);
  if (version !== 1) {
    throw new Error(`unsupported spec.version '${obj.version}' (expected 1)`);
  }
  const kind = asOptionalString(obj.kind) ?? "service";
  if (kind === "service") {
    return normalizeServiceSpec(obj);
  }
  if (kind === "static") {
    return normalizeStaticSpec(obj);
  }
  throw new Error(`unsupported spec.kind '${obj.kind}'`);
}

function appsDir(): string {
  const home = process.env.HOME ?? ".";
  return join(home, ".local", "share", "cocalc", "apps");
}

function specFilePath(id: string): string {
  return join(appsDir(), `${assertAppId(id)}${SPEC_EXT}`);
}

async function ensureAppsDir(): Promise<string> {
  const dir = appsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function getAppSpec(id: string): Promise<AppSpec> {
  const path = specFilePath(id);
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeAppSpec(parsed);
}

export async function upsertAppSpec(spec: unknown): Promise<{ id: string; path: string; spec: AppSpec }> {
  const normalized = normalizeAppSpec(spec);
  await ensureAppsDir();
  const path = specFilePath(normalized.id);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return { id: normalized.id, path, spec: normalized };
}

export async function deleteAppSpec(id: string): Promise<{ id: string; deleted: boolean; path: string }> {
  const normalized = assertAppId(id);
  const path = specFilePath(normalized);
  try {
    await unlink(path);
    return { id: normalized, deleted: true, path };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { id: normalized, deleted: false, path };
    }
    throw err;
  }
}

export async function listAppSpecs(): Promise<AppSpecRecord[]> {
  const dir = await ensureAppsDir();
  const names = await readdir(dir).catch((err: any) => {
    if (err?.code === "ENOENT") return [] as string[];
    throw err;
  });
  const records: AppSpecRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(SPEC_EXT)) continue;
    const id = name.slice(0, -SPEC_EXT.length);
    const path = join(dir, name);
    try {
      assertAppId(id);
      const [raw, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      const parsed = JSON.parse(raw);
      const spec = normalizeAppSpec(parsed);
      records.push({
        id: spec.id,
        path,
        mtime: stats.mtimeMs,
        spec,
      });
    } catch (err) {
      records.push({
        id,
        path,
        error: `${err}`,
      });
    }
  }
  return records;
}

export async function readAppSpecFile(path: string): Promise<AppSpec> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeAppSpec(parsed);
}
