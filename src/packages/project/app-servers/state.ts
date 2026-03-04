/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AppExposureMode = "private" | "public";
export type AppExposureFrontAuth = "none" | "token";

export interface AppExposureState {
  mode: AppExposureMode;
  auth_front: AppExposureFrontAuth;
  token?: string;
  exposed_at_ms?: number;
  expires_at_ms?: number;
  ttl_s?: number;
  random_subdomain?: string;
  public_hostname?: string;
  public_url?: string;
}

interface RuntimeStateV1 {
  version: 1;
  updated_at_ms: number;
  exposures: Record<string, AppExposureState>;
}

const DEFAULT_STATE: RuntimeStateV1 = {
  version: 1,
  updated_at_ms: 0,
  exposures: {},
};

function appsDir(): string {
  const home = process.env.HOME ?? ".";
  return join(home, ".local", "share", "cocalc", "apps");
}

function statePath(): string {
  return join(appsDir(), "runtime-state.json");
}

async function ensureAppsDir(): Promise<void> {
  await mkdir(appsDir(), { recursive: true });
}

function normalizeExposureState(input: unknown): AppExposureState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { mode: "private", auth_front: "none" };
  }
  const obj = input as Record<string, any>;
  const mode: AppExposureMode = obj.mode === "public" ? "public" : "private";
  const auth_front: AppExposureFrontAuth =
    obj.auth_front === "token" ? "token" : "none";
  const token = typeof obj.token === "string" && obj.token.trim().length > 0
    ? obj.token.trim()
    : undefined;
  const exposed_at_ms = Number(obj.exposed_at_ms);
  const expires_at_ms = Number(obj.expires_at_ms);
  const ttl_s = Number(obj.ttl_s);
  const random_subdomain =
    typeof obj.random_subdomain === "string" && obj.random_subdomain.trim().length > 0
      ? obj.random_subdomain.trim()
      : undefined;
  const public_hostname =
    typeof obj.public_hostname === "string" && obj.public_hostname.trim().length > 0
      ? obj.public_hostname.trim()
      : undefined;
  const public_url =
    typeof obj.public_url === "string" && obj.public_url.trim().length > 0
      ? obj.public_url.trim()
      : undefined;
  return {
    mode,
    auth_front,
    token,
    exposed_at_ms: Number.isFinite(exposed_at_ms) ? exposed_at_ms : undefined,
    expires_at_ms: Number.isFinite(expires_at_ms) ? expires_at_ms : undefined,
    ttl_s: Number.isFinite(ttl_s) ? ttl_s : undefined,
    random_subdomain,
    public_hostname,
    public_url,
  };
}

function normalizeState(input: unknown): RuntimeStateV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_STATE };
  }
  const obj = input as Record<string, any>;
  const version = Number(obj.version ?? 1);
  if (version !== 1) {
    return { ...DEFAULT_STATE };
  }
  const exposuresIn =
    obj.exposures && typeof obj.exposures === "object" && !Array.isArray(obj.exposures)
      ? (obj.exposures as Record<string, unknown>)
      : {};
  const exposures: Record<string, AppExposureState> = {};
  for (const [key, value] of Object.entries(exposuresIn)) {
    exposures[key] = normalizeExposureState(value);
  }
  return {
    version: 1,
    updated_at_ms: Number.isFinite(Number(obj.updated_at_ms))
      ? Number(obj.updated_at_ms)
      : 0,
    exposures,
  };
}

async function readStateRaw(): Promise<RuntimeStateV1> {
  await ensureAppsDir();
  const path = statePath();
  try {
    const raw = await readFile(path, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }
    throw err;
  }
}

async function writeStateRaw(state: RuntimeStateV1): Promise<void> {
  await ensureAppsDir();
  const path = statePath();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = {
    ...state,
    version: 1,
    updated_at_ms: Date.now(),
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function isExpired(exposure: AppExposureState, now = Date.now()): boolean {
  if (exposure.mode !== "public") return false;
  if (!Number.isFinite(exposure.expires_at_ms)) return false;
  return (exposure.expires_at_ms as number) <= now;
}

function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function randomSubdomainLabel(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

export async function getAppExposureState(
  app_id: string,
): Promise<AppExposureState | undefined> {
  const state = await readStateRaw();
  const exposure = state.exposures[app_id];
  if (!exposure) return;
  if (isExpired(exposure)) {
    delete state.exposures[app_id];
    await writeStateRaw(state);
    return;
  }
  return exposure;
}

export async function listAppExposureStates(): Promise<Record<string, AppExposureState>> {
  const state = await readStateRaw();
  let changed = false;
  for (const [app_id, exposure] of Object.entries(state.exposures)) {
    if (isExpired(exposure)) {
      delete state.exposures[app_id];
      changed = true;
    }
  }
  if (changed) {
    await writeStateRaw(state);
  }
  return state.exposures;
}

export async function exposeApp({
  app_id,
  ttl_s,
  auth_front = "token",
  random_subdomain = true,
  subdomain_label,
  public_hostname,
  public_url,
}: {
  app_id: string;
  ttl_s: number;
  auth_front?: AppExposureFrontAuth;
  random_subdomain?: boolean;
  subdomain_label?: string;
  public_hostname?: string;
  public_url?: string;
}): Promise<AppExposureState> {
  const now = Date.now();
  const ttl = Math.max(60, Math.floor(Number(ttl_s) || 0));
  const expires = now + ttl * 1000;
  const exposure: AppExposureState = {
    mode: "public",
    auth_front,
    exposed_at_ms: now,
    expires_at_ms: expires,
    ttl_s: ttl,
    random_subdomain:
      subdomain_label ?? (random_subdomain ? randomSubdomainLabel() : undefined),
    public_hostname,
    public_url,
    token: auth_front === "token" ? randomToken() : undefined,
  };
  const state = await readStateRaw();
  state.exposures[app_id] = exposure;
  await writeStateRaw(state);
  return exposure;
}

export async function unexposeApp(app_id: string): Promise<boolean> {
  const state = await readStateRaw();
  const existed = state.exposures[app_id] != null;
  if (existed) {
    delete state.exposures[app_id];
    await writeStateRaw(state);
  }
  return existed;
}
