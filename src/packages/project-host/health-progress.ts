/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import path from "node:path";

export type ProjectHostActivityKind = "start" | "stop";

export type ProjectHostActivitySnapshot = {
  pid: number;
  active_operations: number;
  active_starts: number;
  active_stops: number;
  last_activity_ms: number;
  updated_at: string;
};

const ACTIVITY_FILE = "project-host-activity.json";
const HEARTBEAT_MS = 5000;
const PROGRESS_WRITE_MIN_INTERVAL_MS = 2000;

const activeOperations = new Map<string, ProjectHostActivityKind>();
let lastActivityMs = 0;
let lastWriteMs = 0;
let heartbeatTimer: NodeJS.Timeout | undefined;

function resolveDataDir(): string | undefined {
  const value = `${process.env.COCALC_DATA ?? process.env.DATA ?? ""}`.trim();
  return value || undefined;
}

export function projectHostActivityFilePath(
  dataDir = resolveDataDir(),
): string | undefined {
  if (!dataDir) return;
  return path.join(dataDir, ACTIVITY_FILE);
}

function snapshot(nowMs = Date.now()): ProjectHostActivitySnapshot {
  let activeStarts = 0;
  let activeStops = 0;
  for (const kind of activeOperations.values()) {
    if (kind === "start") {
      activeStarts += 1;
    } else if (kind === "stop") {
      activeStops += 1;
    }
  }
  return {
    pid: process.pid,
    active_operations: activeOperations.size,
    active_starts: activeStarts,
    active_stops: activeStops,
    last_activity_ms: lastActivityMs || nowMs,
    updated_at: new Date(nowMs).toISOString(),
  };
}

function writeSnapshot(opts?: { force?: boolean }): void {
  const force = opts?.force === true;
  const dataDir = resolveDataDir();
  if (!dataDir) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastWriteMs < PROGRESS_WRITE_MIN_INTERVAL_MS) {
    return;
  }
  const file = path.join(dataDir, ACTIVITY_FILE);
  const tmp = `${file}.tmp`;
  const payload = JSON.stringify(snapshot(nowMs));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
    lastWriteMs = nowMs;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

function ensureHeartbeat(): void {
  if (activeOperations.size === 0) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    return;
  }
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (activeOperations.size === 0) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      return;
    }
    lastActivityMs = Date.now();
    writeSnapshot();
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

export function beginProjectHostActivity(
  id: string,
  kind: ProjectHostActivityKind,
): void {
  activeOperations.set(id, kind);
  lastActivityMs = Date.now();
  ensureHeartbeat();
  writeSnapshot({ force: true });
}

export function noteProjectHostActivityProgress(id: string): void {
  if (!activeOperations.has(id)) return;
  lastActivityMs = Date.now();
  writeSnapshot();
}

export function endProjectHostActivity(id: string): void {
  const had = activeOperations.delete(id);
  if (!had) return;
  lastActivityMs = Date.now();
  ensureHeartbeat();
  writeSnapshot({ force: true });
}

export function getProjectHostActivitySnapshot(): ProjectHostActivitySnapshot {
  return snapshot();
}

export function readProjectHostActivitySnapshot(
  dataDir: string,
): ProjectHostActivitySnapshot | undefined {
  const file = path.join(dataDir, ACTIVITY_FILE);
  if (!fs.existsSync(file)) return;
  try {
    const value = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as ProjectHostActivitySnapshot;
    if (!value || typeof value !== "object") return;
    if (!Number.isInteger(value.pid) || value.pid <= 0) return;
    if (
      !Number.isFinite(value.active_operations) ||
      !Number.isFinite(value.active_starts) ||
      !Number.isFinite(value.active_stops) ||
      !Number.isFinite(value.last_activity_ms)
    ) {
      return;
    }
    return value;
  } catch {
    return;
  }
}

export function resetProjectHostActivityStateForTesting(): void {
  activeOperations.clear();
  lastActivityMs = 0;
  lastWriteMs = 0;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}
