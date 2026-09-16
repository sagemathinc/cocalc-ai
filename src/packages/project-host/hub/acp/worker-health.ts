/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEGRADED_WINDOW_MS = 15 * 60 * 1000;
const MAX_EVENTS = 100;
const UNEXPECTED_TERMINATION_REASONS = new Set([
  "queue_stalled_worker",
  "unresponsive_worker",
]);

export type AcpWorkerSupervisorEvent = {
  at_ms: number;
  reason: string;
  pid?: number;
  worker_id?: string;
};

type AcpWorkerHealthState = {
  schema_version: 1;
  events: AcpWorkerSupervisorEvent[];
};

export type ProjectHostAcpWorkerHealth = {
  schema_version: 1;
  status: "healthy" | "degraded";
  checked_at: string;
  window_ms: number;
  unexpected_terminations: number;
  latest_termination_at?: string;
  latest_termination_reason?: string;
  oldest_queued_at?: string;
  oldest_queued_age_ms?: number;
};

function stateFile(dataDir: string): string {
  return path.join(dataDir, "acp-worker-health.json");
}

function normalizeEvents(value: unknown): AcpWorkerSupervisorEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((event): AcpWorkerSupervisorEvent | undefined => {
      const at_ms = Number(event?.at_ms);
      const reason = `${event?.reason ?? ""}`.trim();
      if (!Number.isFinite(at_ms) || at_ms <= 0 || !reason) return;
      const pid = Number(event?.pid);
      const worker_id = `${event?.worker_id ?? ""}`.trim();
      return {
        at_ms,
        reason,
        ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
        ...(worker_id ? { worker_id } : {}),
      };
    })
    .filter((event): event is AcpWorkerSupervisorEvent => event != null);
}

function readState(dataDir: string): AcpWorkerHealthState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(dataDir), "utf8"));
    return {
      schema_version: SCHEMA_VERSION,
      events: normalizeEvents(parsed?.events),
    };
  } catch {
    return { schema_version: SCHEMA_VERSION, events: [] };
  }
}

function writeState(dataDir: string, state: AcpWorkerHealthState): void {
  const file = stateFile(dataDir);
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function retainedEvents(
  events: AcpWorkerSupervisorEvent[],
  now: number,
): AcpWorkerSupervisorEvent[] {
  return events
    .filter((event) => now - event.at_ms <= EVENT_RETENTION_MS)
    .sort((left, right) => left.at_ms - right.at_ms)
    .slice(-MAX_EVENTS);
}

export function isUnexpectedAcpWorkerTermination(reason: string): boolean {
  return UNEXPECTED_TERMINATION_REASONS.has(reason);
}

export function recordUnexpectedAcpWorkerTermination({
  dataDir,
  reason,
  pid,
  worker_id,
  now = Date.now(),
}: {
  dataDir: string;
  reason: string;
  pid?: number;
  worker_id?: string;
  now?: number;
}): boolean {
  if (!isUnexpectedAcpWorkerTermination(reason)) return false;
  const state = readState(dataDir);
  state.events = retainedEvents(
    [...state.events, { at_ms: now, reason, pid, worker_id }],
    now,
  );
  writeState(dataDir, state);
  return true;
}

export function summarizeProjectHostAcpWorkerHealth({
  events,
  oldestQueuedAt,
  now = Date.now(),
}: {
  events: AcpWorkerSupervisorEvent[];
  oldestQueuedAt?: number;
  now?: number;
}): ProjectHostAcpWorkerHealth {
  const recent = retainedEvents(events, now).filter(
    (event) => now - event.at_ms <= DEGRADED_WINDOW_MS,
  );
  const latest = recent.at(-1);
  const validOldestQueuedAt =
    Number.isFinite(oldestQueuedAt) && Number(oldestQueuedAt) > 0
      ? Number(oldestQueuedAt)
      : undefined;
  return {
    schema_version: SCHEMA_VERSION,
    status: recent.length > 0 ? "degraded" : "healthy",
    checked_at: new Date(now).toISOString(),
    window_ms: DEGRADED_WINDOW_MS,
    unexpected_terminations: recent.length,
    ...(latest
      ? {
          latest_termination_at: new Date(latest.at_ms).toISOString(),
          latest_termination_reason: latest.reason,
        }
      : {}),
    ...(validOldestQueuedAt != null
      ? {
          oldest_queued_at: new Date(validOldestQueuedAt).toISOString(),
          oldest_queued_age_ms: Math.max(0, now - validOldestQueuedAt),
        }
      : {}),
  };
}

export function getProjectHostAcpWorkerHealth({
  dataDir,
  oldestQueuedAt,
  now = Date.now(),
}: {
  dataDir: string;
  oldestQueuedAt?: number;
  now?: number;
}): ProjectHostAcpWorkerHealth {
  return summarizeProjectHostAcpWorkerHealth({
    events: readState(dataDir).events,
    oldestQueuedAt,
    now,
  });
}

export const __test__ = {
  degradedWindowMs: DEGRADED_WINDOW_MS,
};
