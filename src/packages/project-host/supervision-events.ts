/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import fs from "node:fs";
import path from "node:path";

export type HealthCheckDiagnostic = {
  url: string;
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
  timeout_seconds?: number;
};

export type SupervisionEvent = {
  ts?: string;
  source: "daemon" | "host-agent";
  component: "project-host" | "conat-router" | "conat-persist" | "host-agent";
  action:
    | "started"
    | "healthy"
    | "warming_up"
    | "forensics_captured"
    | "forensics_failed"
    | "restart_requested"
    | "restart_completed"
    | "missing_process"
    | "stale_pid"
    | "rollback_tracking"
    | "rollback_completed"
    | "rollback_accepted"
    | "reconcile_failed"
    | "shutdown";
  message: string;
  pid?: number;
  selected_version?: string;
  current_version?: string;
  running_version?: string;
  previous_version?: string;
  target_version?: string;
  deadline_at?: string;
  health?: HealthCheckDiagnostic;
  metadata?: Record<string, unknown>;
};

const EVENTS_FILE = "supervision-events.jsonl";

function trimBody(body?: string): string | undefined {
  const normalized = `${body ?? ""}`.trim();
  if (!normalized) return;
  if (normalized.length <= 300) {
    return normalized;
  }
  return `${normalized.slice(0, 300)}...`;
}

function normalizeDiagnostic(
  diagnostic?: HealthCheckDiagnostic,
): HealthCheckDiagnostic | undefined {
  if (!diagnostic) return;
  return {
    ...diagnostic,
    body: trimBody(diagnostic.body),
    error: trimBody(diagnostic.error),
  };
}

export function appendSupervisionEvent(
  dataDir: string,
  event: SupervisionEvent,
): void {
  const file = path.join(dataDir, EVENTS_FILE);
  const payload = {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
    health: normalizeDiagnostic(event.health),
  };
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}
