/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface RuntimeStateV1 {
  version: 1;
  updated_at_ms: number;
  running_services: Record<string, { port: number }>;
}

const DEFAULT_STATE: RuntimeStateV1 = {
  version: 1,
  updated_at_ms: 0,
  running_services: {},
};

let stateMutationQueue: Promise<void> = Promise.resolve();

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

function normalizeState(input: unknown): RuntimeStateV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_STATE };
  }
  const obj = input as Record<string, any>;
  const version = Number(obj.version ?? 1);
  if (version !== 1) {
    return { ...DEFAULT_STATE };
  }
  const runningServicesIn =
    obj.running_services &&
    typeof obj.running_services === "object" &&
    !Array.isArray(obj.running_services)
      ? (obj.running_services as Record<string, unknown>)
      : {};
  const running_services: Record<string, { port: number }> = {};
  for (const [key, value] of Object.entries(runningServicesIn)) {
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, any>)
        : undefined;
    const port = Number(obj?.port);
    if (Number.isInteger(port) && port > 0) {
      running_services[key] = { port };
    }
  }
  return {
    version: 1,
    updated_at_ms: Number.isFinite(Number(obj.updated_at_ms))
      ? Number(obj.updated_at_ms)
      : 0,
    running_services,
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  const payload = {
    ...state,
    version: 1,
    updated_at_ms: Date.now(),
  };
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function mutateState<T>(
  f: (
    state: RuntimeStateV1,
  ) =>
    | T
    | { result: T; changed?: boolean }
    | Promise<T | { result: T; changed?: boolean }>,
): Promise<T> {
  const run = async (): Promise<T> => {
    const state = await readStateRaw();
    const out = await f(state);
    const wrapped =
      out && typeof out === "object" && !Array.isArray(out) && "result" in out
        ? (out as { result: T; changed?: boolean })
        : { result: out as T, changed: true };
    if (wrapped.changed !== false) {
      await writeStateRaw(state);
    }
    return wrapped.result;
  };
  const next = stateMutationQueue.then(run, run);
  stateMutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function setRunningServicePort(
  app_id: string,
  port: number,
): Promise<void> {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return;
  await mutateState<void>((state) => {
    state.running_services[app_id] = { port: n };
    return undefined;
  });
}

export async function clearRunningServicePort(app_id: string): Promise<void> {
  await mutateState<void>((state) => {
    if (!(app_id in state.running_services)) {
      return { result: undefined, changed: false };
    }
    delete state.running_services[app_id];
    return undefined;
  });
}

export async function appIdForRunningServicePort(
  port: number,
): Promise<string | undefined> {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return;
  const state = await readStateRaw();
  for (const [app_id, value] of Object.entries(state.running_services)) {
    if (value?.port === n) return app_id;
  }
  return;
}
