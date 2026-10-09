/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Maintenance windows announced to users of a host's projects, stored in
// project_hosts.metadata.maintenance and shown as a banner on project pages.

import getPool from "@cocalc/database/pool";
import type {
  HostMaintenanceNotice,
  HostMaintenanceState,
} from "@cocalc/conat/hub/api/hosts";

const STATES: HostMaintenanceState[] = [
  "scheduled",
  "in_progress",
  "completed",
  "failed",
];
const MAX_MESSAGE_LENGTH = 500;
// An announcement whose start passed long ago without the work starting is
// stale; one far in the future is not worth a banner yet.
const SCHEDULED_STALE_MS = 6 * 60 * 60 * 1000;
const SCHEDULED_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_EXPECTED_MINUTES = 24 * 60;

function iso(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const ms = Date.parse(`${value}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// The notice to show users, or undefined (none, completed, or stale).
export function normalizeHostMaintenanceNotice(
  value: unknown,
  now = Date.now(),
): HostMaintenanceNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, any>;
  const state = STATES.find((s) => s === raw.state);
  if (!state || state === "completed") return undefined;
  const kind = raw.kind === "relocation" ? "relocation" : "maintenance";
  const scheduled_for = iso(raw.scheduled_for);
  if (state === "scheduled") {
    const at = scheduled_for ? Date.parse(scheduled_for) : NaN;
    if (
      !Number.isFinite(at) ||
      at < now - SCHEDULED_STALE_MS ||
      at > now + SCHEDULED_HORIZON_MS
    ) {
      return undefined;
    }
  }
  const expected = Number(raw.expected_duration_ms);
  const message = `${raw.message ?? ""}`.trim().slice(0, MAX_MESSAGE_LENGTH);
  const notice: HostMaintenanceNotice = { kind, state };
  if (scheduled_for) notice.scheduled_for = scheduled_for;
  const started_at = iso(raw.started_at);
  if (started_at) notice.started_at = started_at;
  if (Number.isFinite(expected) && expected > 0) {
    notice.expected_duration_ms = Math.round(expected);
  }
  const expected_end_at = iso(raw.expected_end_at);
  if (expected_end_at) notice.expected_end_at = expected_end_at;
  if (message) notice.message = message;
  const updated_at = iso(raw.updated_at);
  if (updated_at) notice.updated_at = updated_at;
  return notice;
}

export function scheduledMaintenanceNotice(opts: {
  scheduled_for: string;
  expected_minutes: number;
  message?: string;
  now?: number;
}): HostMaintenanceNotice {
  const at = Date.parse(opts.scheduled_for);
  if (!Number.isFinite(at)) {
    throw new Error(`invalid time '${opts.scheduled_for}'`);
  }
  const now = opts.now ?? Date.now();
  if (at < now - 60_000) {
    throw new Error("the maintenance time is in the past");
  }
  if (at > now + SCHEDULED_HORIZON_MS) {
    throw new Error("the maintenance time is more than 14 days away");
  }
  const minutes = Number(opts.expected_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_EXPECTED_MINUTES) {
    throw new Error(`expected minutes must be between 1 and ${MAX_EXPECTED_MINUTES}`);
  }
  const expected_duration_ms = Math.round(minutes * 60_000);
  const message = `${opts.message ?? ""}`.trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`message is longer than ${MAX_MESSAGE_LENGTH} characters`);
  }
  return {
    kind: "maintenance",
    state: "scheduled",
    scheduled_for: new Date(at).toISOString(),
    expected_duration_ms,
    expected_end_at: new Date(at + expected_duration_ms).toISOString(),
    ...(message ? { message } : {}),
    updated_at: new Date(now).toISOString(),
  };
}

export async function setHostMaintenanceMetadata(
  host_id: string,
  notice: HostMaintenanceNotice | null,
): Promise<void> {
  if (notice == null) {
    await getPool().query(
      `UPDATE project_hosts SET metadata = metadata - 'maintenance', updated=NOW() WHERE id=$1`,
      [host_id],
    );
    return;
  }
  await getPool().query(
    `UPDATE project_hosts
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{maintenance}', $2::jsonb),
           updated=NOW()
     WHERE id=$1`,
    [host_id, JSON.stringify({ ...notice, updated_at: new Date().toISOString() })],
  );
}
