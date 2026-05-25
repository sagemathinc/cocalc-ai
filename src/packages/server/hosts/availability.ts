/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getPool from "@cocalc/database/pool";
import type {
  HostAvailabilityCategory,
  HostAvailabilityEvent,
  HostAvailabilityReport,
  HostAvailabilityState,
} from "@cocalc/conat/hub/api/hosts";

const TABLE = "project_host_availability_events";
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 370;
const HOST_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let schemaReady: Promise<void> | undefined;

type HostAvailabilityObservation = {
  host_id: string;
  state: HostAvailabilityState;
  planned?: boolean;
  category?: HostAvailabilityCategory;
  source: string;
  summary?: string | null;
  details?: Record<string, any>;
  observed_at?: Date;
};

type HostAvailabilityRow = {
  id: string;
  host_id: string;
  started_at: Date | string;
  ended_at?: Date | string | null;
  state: HostAvailabilityState;
  planned: boolean;
  category: HostAvailabilityCategory;
  source: string;
  summary?: string | null;
  details?: Record<string, any> | null;
  admin_note?: string | null;
  admin_note_visibility?: "private" | "public" | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
};

type ProjectHostAvailabilitySnapshot = {
  id: string;
  status?: string | null;
  deleted?: Date | string | null;
  last_seen?: Date | string | null;
  metadata?: Record<string, any> | null;
};

function pool() {
  return getPool();
}

export async function ensureHostAvailabilitySchema(): Promise<void> {
  schemaReady ??= (async () => {
    await pool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id UUID PRIMARY KEY,
        host_id UUID NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        state TEXT NOT NULL,
        planned BOOLEAN NOT NULL DEFAULT FALSE,
        category TEXT NOT NULL DEFAULT 'unknown',
        source TEXT NOT NULL DEFAULT 'unknown',
        summary TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        admin_note TEXT,
        admin_note_visibility TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (state IN ('online', 'unavailable', 'recovering', 'degraded'))
      )
    `);
    await pool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_host_started_idx
       ON ${TABLE} (host_id, started_at DESC)`,
    );
    await pool().query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_one_open_idx
       ON ${TABLE} (host_id)
       WHERE ended_at IS NULL`,
    );
  })();
  return schemaReady;
}

function normalizeDate(value?: Date | string | null): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function serializeRow(row: HostAvailabilityRow): HostAvailabilityEvent {
  return {
    id: row.id,
    host_id: row.host_id,
    started_at: normalizeDate(row.started_at)?.toISOString() ?? "",
    ended_at: normalizeDate(row.ended_at)?.toISOString(),
    state: row.state,
    planned: row.planned,
    category: row.category,
    source: row.source,
    summary: row.summary ?? undefined,
    details: row.details ?? {},
    admin_note: row.admin_note ?? undefined,
    admin_note_visibility: row.admin_note_visibility ?? "private",
  };
}

function normalizeCategory(value?: string | null): HostAvailabilityCategory {
  switch (value) {
    case "spot_interruption":
    case "provider_repair":
    case "provider_offline":
    case "host_reboot":
    case "maintenance":
    case "resize_disk":
    case "deploy":
    case "overload":
    case "user_stopped":
    case "host_stale":
      return value;
    default:
      return "unknown";
  }
}

function eventEquivalent(
  row: HostAvailabilityRow | undefined,
  observation: Required<
    Pick<HostAvailabilityObservation, "state" | "planned" | "category">
  > & { summary?: string | null },
): boolean {
  return (
    !!row &&
    row.state === observation.state &&
    row.planned === observation.planned &&
    row.category === observation.category &&
    (row.summary ?? null) === (observation.summary ?? null)
  );
}

export async function recordHostAvailabilityObservation(
  observation: HostAvailabilityObservation,
): Promise<void> {
  const hostId = `${observation.host_id ?? ""}`.trim();
  if (!hostId) throw Error("host_id must be specified");
  await ensureHostAvailabilitySchema();
  const observedAt = observation.observed_at ?? new Date();
  const normalized = {
    state: observation.state,
    planned: observation.planned === true,
    category: normalizeCategory(observation.category),
    source: `${observation.source ?? "unknown"}`.trim() || "unknown",
    summary: observation.summary ?? null,
    details: observation.details ?? {},
  };
  const { rows } = await pool().query<HostAvailabilityRow>(
    `SELECT *
       FROM ${TABLE}
      WHERE host_id=$1 AND ended_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1`,
    [hostId],
  );
  const open = rows[0];
  if (eventEquivalent(open, normalized)) {
    return;
  }
  await pool().query(
    `UPDATE ${TABLE}
        SET ended_at=$2, updated_at=NOW()
      WHERE host_id=$1 AND ended_at IS NULL`,
    [hostId, observedAt],
  );
  await pool().query(
    `INSERT INTO ${TABLE}
       (id, host_id, started_at, state, planned, category, source, summary, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      randomUUID(),
      hostId,
      observedAt,
      normalized.state,
      normalized.planned,
      normalized.category,
      normalized.source,
      normalized.summary,
      JSON.stringify(normalized.details),
    ],
  );
}

export function classifyHostAvailabilitySnapshot(
  row: ProjectHostAvailabilitySnapshot,
  source = "host_snapshot",
): HostAvailabilityObservation {
  const metadata = row.metadata ?? {};
  const desiredState = metadata.desired_state;
  const recoveryPhase = metadata.spot_recovery_state?.phase;
  const status = `${row.status ?? ""}`.trim();
  const lastSeen = normalizeDate(row.last_seen);
  const heartbeatFresh =
    !!lastSeen && Date.now() - lastSeen.getTime() < HOST_ONLINE_WINDOW_MS;
  const base = {
    host_id: row.id,
    source,
    details: {
      status,
      desired_state: desiredState,
      last_seen: lastSeen?.toISOString(),
      recovery_phase: recoveryPhase,
    },
  };
  if (row.deleted) {
    return {
      ...base,
      state: "unavailable",
      planned: true,
      category: "user_stopped",
      summary: "Host is deleted.",
    };
  }
  if (recoveryPhase && recoveryPhase !== "idle") {
    return {
      ...base,
      state: "recovering",
      planned: false,
      category: "spot_interruption",
      summary: `Host is recovering (${recoveryPhase}).`,
    };
  }
  if (status === "running" && heartbeatFresh) {
    return {
      ...base,
      state: "online",
      planned: false,
      category: "unknown",
      summary: "Host is online.",
    };
  }
  if (status === "running") {
    return {
      ...base,
      state: "unavailable",
      planned: false,
      category: "host_stale",
      summary: "Host is running at the provider but not reporting.",
    };
  }
  if (["starting", "restarting", "provisioning"].includes(status)) {
    return {
      ...base,
      state: "recovering",
      planned: false,
      category: "provider_offline",
      summary: "Host is starting or recovering.",
    };
  }
  if (["stopping", "draining", "deprovisioning"].includes(status)) {
    return {
      ...base,
      state: "unavailable",
      planned: true,
      category: "maintenance",
      summary: "Host is intentionally stopping.",
    };
  }
  if (["off", "stopped", "deprovisioned"].includes(status)) {
    return {
      ...base,
      state: "unavailable",
      planned: desiredState !== "running",
      category:
        desiredState === "running" ? "provider_offline" : "user_stopped",
      summary:
        desiredState === "running"
          ? "Host is unexpectedly offline."
          : "Host is intentionally stopped.",
    };
  }
  if (status === "error") {
    return {
      ...base,
      state: "unavailable",
      planned: false,
      category: "provider_offline",
      summary: "Host is in an error state.",
    };
  }
  return {
    ...base,
    state: "unavailable",
    planned: false,
    category: "unknown",
    summary: "Host availability is unknown.",
  };
}

export async function recordHostAvailabilityFromSnapshot(
  row: ProjectHostAvailabilitySnapshot,
  source = "host_snapshot",
): Promise<void> {
  await recordHostAvailabilityObservation(
    classifyHostAvailabilitySnapshot(row, source),
  );
}

export async function recordCurrentHostAvailability(
  host_id: string,
  source = "host_snapshot",
): Promise<void> {
  const { rows } = await pool().query<ProjectHostAvailabilitySnapshot>(
    `SELECT id, status, deleted, last_seen, metadata
       FROM project_hosts
      WHERE id=$1
      LIMIT 1`,
    [host_id],
  );
  if (rows[0]) {
    await recordHostAvailabilityFromSnapshot(rows[0], source);
  }
}

function clampWindowDays(days?: number): number {
  const parsed = Math.floor(Number(days) || DEFAULT_WINDOW_DAYS);
  return Math.max(1, Math.min(MAX_WINDOW_DAYS, parsed));
}

function clampMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function overlapMs(
  start: Date,
  end: Date,
  windowStart: Date,
  windowEnd: Date,
): number {
  return clampMs(
    Math.min(end.getTime(), windowEnd.getTime()) -
      Math.max(start.getTime(), windowStart.getTime()),
  );
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export async function getHostAvailabilityReport({
  host_id,
  days,
}: {
  host_id: string;
  days?: number;
}): Promise<HostAvailabilityReport> {
  const hostId = `${host_id ?? ""}`.trim();
  if (!hostId) throw Error("host_id must be specified");
  await recordCurrentHostAvailability(hostId, "report_snapshot");
  await ensureHostAvailabilitySchema();
  const windowDays = clampWindowDays(days);
  const now = new Date();
  const todayStart = utcDayStart(now);
  const windowStart = new Date(
    todayStart.getTime() - (windowDays - 1) * DAY_MS,
  );
  const { rows } = await pool().query<HostAvailabilityRow>(
    `SELECT *
       FROM ${TABLE}
      WHERE host_id=$1
        AND started_at <= $3
        AND COALESCE(ended_at, $3) >= $2
      ORDER BY started_at ASC`,
    [hostId, windowStart, now],
  );
  const events = rows.map(serializeRow);
  const daysMap = new Map<
    string,
    {
      total_ms: number;
      online_ms: number;
      planned_downtime_ms: number;
      unplanned_downtime_ms: number;
      outage_count: number;
      events: HostAvailabilityEvent[];
    }
  >();
  for (let i = windowDays - 1; i >= 0; i--) {
    const start = new Date(now.getTime() - i * DAY_MS);
    const key = dayKey(start);
    const dayStart = new Date(`${key}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    daysMap.set(key, {
      total_ms: overlapMs(dayStart, dayEnd, windowStart, now),
      online_ms: 0,
      planned_downtime_ms: 0,
      unplanned_downtime_ms: 0,
      outage_count: 0,
      events: [],
    });
  }
  let onlineMs = 0;
  let plannedDowntimeMs = 0;
  let unplannedDowntimeMs = 0;
  let unplannedOutageCount = 0;
  let longestOutageMs = 0;
  for (const event of events) {
    const start = normalizeDate(event.started_at);
    const end = normalizeDate(event.ended_at) ?? now;
    if (!start) continue;
    const eventWindowMs = overlapMs(start, end, windowStart, now);
    if (event.state === "online") {
      onlineMs += eventWindowMs;
    } else if (event.planned) {
      plannedDowntimeMs += eventWindowMs;
    } else {
      unplannedDowntimeMs += eventWindowMs;
      if (eventWindowMs > 0) unplannedOutageCount += 1;
      longestOutageMs = Math.max(longestOutageMs, eventWindowMs);
    }
    for (const [key, day] of daysMap) {
      const dayStart = new Date(`${key}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart.getTime() + DAY_MS);
      const ms = overlapMs(start, end, dayStart, dayEnd);
      if (ms <= 0) continue;
      day.events.push(event);
      if (event.state === "online") {
        day.online_ms += ms;
      } else if (event.planned) {
        day.planned_downtime_ms += ms;
      } else {
        day.unplanned_downtime_ms += ms;
        day.outage_count += 1;
      }
    }
  }
  const windowMs = now.getTime() - windowStart.getTime();
  const currentEvent = events.find((event) => !event.ended_at);
  const currentStartedAt = normalizeDate(currentEvent?.started_at);
  const currentUptimeMs =
    currentEvent?.state === "online" && currentStartedAt
      ? now.getTime() - currentStartedAt.getTime()
      : 0;
  return {
    host_id: hostId,
    generated_at: now.toISOString(),
    window_days: windowDays,
    summary: {
      current_state: currentEvent?.state ?? "unavailable",
      current_uptime_ms: currentUptimeMs,
      window_uptime_percent: windowMs > 0 ? (onlineMs / windowMs) * 100 : 0,
      planned_downtime_ms: plannedDowntimeMs,
      unplanned_downtime_ms: unplannedDowntimeMs,
      unplanned_outage_count: unplannedOutageCount,
      longest_outage_ms: longestOutageMs,
      current_event: currentEvent,
    },
    days: Array.from(daysMap, ([date, day]) => ({
      date,
      uptime_percent:
        day.total_ms > 0
          ? Math.min(100, (day.online_ms / day.total_ms) * 100)
          : 0,
      online_ms: day.online_ms,
      planned_downtime_ms: day.planned_downtime_ms,
      unplanned_downtime_ms: day.unplanned_downtime_ms,
      outage_count: day.outage_count,
      events: day.events,
    })),
    events,
  };
}

export async function annotateHostAvailabilityEvent({
  event_id,
  admin_note,
  category,
  planned,
  summary,
  admin_note_visibility,
}: {
  event_id: string;
  admin_note?: string | null;
  category?: HostAvailabilityCategory;
  planned?: boolean;
  summary?: string | null;
  admin_note_visibility?: "private" | "public";
}): Promise<HostAvailabilityEvent> {
  await ensureHostAvailabilitySchema();
  const sets: string[] = ["updated_at=NOW()"];
  const params: any[] = [event_id];
  let idx = 2;
  if (admin_note !== undefined) {
    sets.push(`admin_note=$${idx++}`);
    params.push(admin_note);
  }
  if (category !== undefined) {
    sets.push(`category=$${idx++}`);
    params.push(normalizeCategory(category));
  }
  if (planned !== undefined) {
    sets.push(`planned=$${idx++}`);
    params.push(planned);
  }
  if (summary !== undefined) {
    sets.push(`summary=$${idx++}`);
    params.push(summary);
  }
  if (admin_note_visibility !== undefined) {
    sets.push(`admin_note_visibility=$${idx++}`);
    params.push(admin_note_visibility);
  }
  const { rows } = await pool().query<HostAvailabilityRow>(
    `UPDATE ${TABLE}
        SET ${sets.join(", ")}
      WHERE id=$1
      RETURNING *`,
    params,
  );
  if (!rows[0]) throw Error("availability event not found");
  return serializeRow(rows[0]);
}
