/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Maintenance windows announced to users of a host's projects, stored in
// project_hosts.maintenance and shown as a banner on project pages.

import getPool from "@cocalc/database/pool";
import type {
  HostMaintenanceNotice,
  HostMaintenanceState,
} from "@cocalc/conat/hub/api/hosts";

const STATES: HostMaintenanceState[] = [
  "scheduled",
  "preparing",
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
  const raw = { ...(value as Record<string, any>) };
  let state = STATES.find((s) => s === raw.state);
  if (!state || state === "completed") return undefined;
  // Users keep working while a relocation prepares; to them the window is
  // still upcoming.
  if (state === "preparing") {
    state = "scheduled";
    if (!raw.scheduled_for) {
      raw.scheduled_for = raw.updated_at ?? new Date(now).toISOString();
    }
  }
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
  if (
    !Number.isFinite(minutes) ||
    minutes <= 0 ||
    minutes > MAX_EXPECTED_MINUTES
  ) {
    throw new Error(
      `expected minutes must be between 1 and ${MAX_EXPECTED_MINUTES}`,
    );
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

// Replace the host's notice, but only if it is still the one the caller
// decided on (compare-and-swap): a relocation may have taken the lease since.
// Returns whether it was written.
export async function setHostMaintenanceMetadata(
  host_id: string,
  notice: HostMaintenanceNotice | null,
  { expected }: { expected: unknown },
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE project_hosts SET maintenance=$2::jsonb, updated=NOW()
      WHERE id=$1 AND maintenance IS NOT DISTINCT FROM $3::jsonb`,
    [
      host_id,
      notice == null
        ? null
        : JSON.stringify({ ...notice, updated_at: new Date().toISOString() }),
      expected == null ? null : JSON.stringify(expected),
    ],
  );
  return (rowCount ?? 0) > 0;
}

// Host lifecycle changes (start, stop, restart, delete, drain, machine and
// software changes, Spot probes and returns) belong to the relocation while
// it holds the host's lease, including a failed relocation awaiting an admin.
export function hostLifecycleFenced(notice: unknown): boolean {
  const state = `${(notice as any)?.state ?? ""}`;
  return state === "preparing" || state === "in_progress" || state === "failed";
}

// The host is down, or in an unknown state after a failed rollback: project
// starts and provider reconciliation must stay away.
export function hostOfflineFenced(notice: unknown): boolean {
  const state = `${(notice as any)?.state ?? ""}`;
  return state === "in_progress" || state === "failed";
}

const FENCED_STATES_SQL = "('preparing','in_progress','failed')";

// Claim the host for a relocation, atomically: of concurrent claims exactly
// one succeeds, and none while another relocation (or a failed one) holds
// it. A scheduled announcement's time and message are kept.
export async function acquireRelocationLease({
  host_id,
  lease_id,
}: {
  host_id: string;
  lease_id: string;
}): Promise<boolean> {
  const lease = {
    kind: "relocation",
    state: "preparing",
    lease_id,
    updated_at: new Date().toISOString(),
  };
  const { rowCount } = await getPool().query(
    `UPDATE project_hosts
        SET maintenance = COALESCE(
              CASE WHEN maintenance->>'state' = 'scheduled' THEN maintenance END,
              '{}'::jsonb
            ) || $2::jsonb,
            updated=NOW()
      WHERE id=$1
        AND deleted IS NULL
        AND COALESCE(maintenance->>'state', '') NOT IN ${FENCED_STATES_SQL}`,
    [host_id, JSON.stringify(lease)],
  );
  return (rowCount ?? 0) > 0;
}

// Record the owning operation on the lease.
export async function attachRelocationLeaseOp({
  host_id,
  lease_id,
  op_id,
}: {
  host_id: string;
  lease_id: string;
  op_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE project_hosts
        SET maintenance = maintenance || jsonb_build_object('op_id', $3::text),
            updated=NOW()
      WHERE id=$1 AND maintenance->>'lease_id' = $2`,
    [host_id, lease_id, op_id],
  );
  if (!rowCount) {
    throw new Error(
      "the relocation lost the host's lease before it was queued",
    );
  }
}

// Write the relocation's notice (null releases the lease), only while this
// relocation still holds the lease: an admin may have cleared it.
export async function setRelocationNotice({
  host_id,
  lease_id,
  notice,
}: {
  host_id: string;
  lease_id: string;
  notice: HostMaintenanceNotice | null;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `UPDATE project_hosts SET maintenance=$3::jsonb, updated=NOW()
      WHERE id=$1 AND maintenance->>'lease_id' = $2`,
    [
      host_id,
      lease_id,
      notice == null
        ? null
        : JSON.stringify({
            ...notice,
            lease_id,
            updated_at: new Date().toISOString(),
          }),
    ],
  );
  if (!rowCount) {
    throw new Error("the relocation no longer holds this host's lease");
  }
}

export async function releaseRelocationLease({
  host_id,
  lease_id,
}: {
  host_id: string;
  lease_id: string;
}): Promise<void> {
  await getPool().query(
    `UPDATE project_hosts SET maintenance=NULL, updated=NOW()
      WHERE id=$1 AND maintenance->>'lease_id' = $2`,
    [host_id, lease_id],
  );
}

export interface HostActivity {
  cloud_work: number;
  host_operations: number;
  project_operations: number;
}

export async function hostActivity({
  host_id,
  own_op_id,
}: {
  host_id: string;
  own_op_id?: string;
}): Promise<HostActivity> {
  // A project operation is attributed to the host through its project's
  // current host and through the hosts its input names: a move changes the
  // project's host early but keeps using the source until it cleans up.
  // Hard deletes are account-scoped and name their project in the input.
  const { rows } = await getPool().query(
    `SELECT
       (SELECT count(*)::int FROM cloud_vm_work
         WHERE vm_id=$1 AND state IN ('queued','in_progress')) AS cloud_work,
       (SELECT count(*)::int FROM long_running_operations
         WHERE scope_type='host' AND scope_id::text=$1
           AND status IN ('queued','running')
           AND ($2::text IS NULL OR op_id::text <> $2)) AS host_operations,
       (SELECT count(*)::int FROM long_running_operations l
         WHERE l.scope_type <> 'host'
           AND l.status IN ('queued','running')
           AND (l.input->>'source_host_id' = $1
                OR l.input->>'dest_host_id' = $1
                OR EXISTS (
                  SELECT 1 FROM projects p
                   WHERE p.host_id::text = $1
                     AND p.project_id::text = COALESCE(
                       CASE WHEN l.scope_type = 'project' THEN l.scope_id::text END,
                       l.input->>'project_id')))) AS project_operations`,
    [host_id, own_op_id ?? null],
  );
  return rows[0];
}

// Project operations that touch a host's data (moves, backups, restores,
// copies, hard deletes, RootFS publishing) must not run while the host is down
// for a relocation or after a failed one. They check when they start running,
// after being claimed: one already running when the window began is counted
// by quiesce and waited out, and one that starts later fails here.
export async function assertProjectHostsNotUnderMaintenance({
  project_ids = [],
  host_ids = [],
}: {
  project_ids?: Array<string | null | undefined>;
  host_ids?: Array<string | null | undefined>;
}): Promise<void> {
  const projects = project_ids.filter((id): id is string => !!id);
  const hosts = host_ids.filter((id): id is string => !!id);
  if (projects.length === 0 && hosts.length === 0) return;
  const { rows } = await getPool().query(
    `SELECT h.id FROM project_hosts h
      WHERE COALESCE(h.maintenance->>'state', '') IN ('in_progress','failed')
        AND (h.id::text = ANY($2::text[])
             OR h.id::text IN (SELECT p.host_id::text FROM projects p
                                WHERE p.project_id::text = ANY($1::text[])))`,
    [projects, hosts],
  );
  if (rows.length > 0) {
    throw Object.assign(
      new Error(
        "This project's server is down for scheduled maintenance and will be back shortly.",
      ),
      { code: "host_maintenance_in_progress" },
    );
  }
}

// Settle everything that could act on the host before its window: queued
// cloud work is cancelled (its handlers would race the move), and running
// cloud work, other host operations, and project operations on the host
// (starts, backups, restores, moves) are waited out. New ones are refused by
// the fence meanwhile; queued ones fail on it when they run. Quiet means
// nothing active on two consecutive checks.
export async function quiesceHostActivity({
  host_id,
  own_op_id,
  timeoutMs = 10 * 60 * 1000,
  pollMs = 5_000,
  onWait,
}: {
  host_id: string;
  own_op_id?: string;
  timeoutMs?: number;
  pollMs?: number;
  onWait?: (activity: HostActivity) => Promise<void>;
}): Promise<void> {
  const pool = getPool();
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  let activity: HostActivity | undefined;
  while (Date.now() < deadline) {
    await pool.query(
      `UPDATE cloud_vm_work
          SET state='failed', error='canceled by a host relocation', updated_at=NOW()
        WHERE vm_id=$1 AND state='queued'`,
      [host_id],
    );
    activity = await hostActivity({ host_id, own_op_id });
    const busy =
      activity.cloud_work +
      activity.host_operations +
      activity.project_operations;
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return;
    if (busy > 0) await onWait?.(activity);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(
    `host activity did not settle (cloud work ${activity?.cloud_work ?? "?"}, host operations ${activity?.host_operations ?? "?"}, project operations ${activity?.project_operations ?? "?"})`,
  );
}
