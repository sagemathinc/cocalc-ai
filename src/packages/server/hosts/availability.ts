/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { ensureProjectHostMetricsSamplesSchema } from "@cocalc/database/postgres/project-host-metrics";
import { createLro, ensureLroSchema } from "@cocalc/server/lro/lro-db";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { runProjectHostRuntimeMaintenance } from "./runtime-maintenance";
import type {
  HostAvailabilityCategory,
  HostAvailabilityEvent,
  HostAvailabilityReport,
  HostAvailabilityState,
} from "@cocalc/conat/hub/api/hosts";

const TABLE = "project_host_availability_events";
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 370;
// Availability history is for operator-facing uptime charts. Give it a wider
// grace window so transient control-plane/notification stalls do not create
// false outage bars. Placement, recovery, and start/upgrade decisions use the
// stricter 2 minute operational heartbeat window in hosts-normalization.ts.
const HOST_AVAILABILITY_HEARTBEAT_GRACE_MS = 10 * 60 * 1000;
const HOST_RUNNING_STALE_ALERT_MS = Math.max(
  60_000,
  Number(process.env.COCALC_HOST_RUNNING_STALE_ALERT_MS ?? 5 * 60_000),
);
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 1000;
const STALE_ALERT_LIMIT = 25;
const HOST_RECONCILE_LRO_KIND = "host-reconcile-software";
const RUNNING_STALE_REPAIR_LIMIT = Math.max(
  0,
  Math.floor(Number(process.env.COCALC_HOST_RUNNING_STALE_REPAIR_LIMIT ?? 3)) ||
    0,
);
const RUNNING_STALE_REPAIR_SUPPRESS_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_RUNNING_STALE_REPAIR_SUPPRESS_MS ?? 30 * 60_000,
  ),
);
const PRESSURE_ALERT_LIMIT = 25;
const RUNTIME_DEGRADED_ALERT_LIMIT = 25;
const RUNTIME_DEGRADED_ALERT_FAILURES = Math.max(
  2,
  Math.floor(
    Number(process.env.COCALC_HOST_RUNTIME_DEGRADED_ALERT_FAILURES ?? 2),
  ) || 2,
);
const PRESSURE_ALERT_STALE_EVALUATION_MS = Math.max(
  5 * 60_000,
  Number(
    process.env.COCALC_HOST_PRESSURE_ALERT_STALE_EVALUATION_MS ?? 30 * 60_000,
  ),
);
const PRESSURE_ALERT_FRESH_METRICS_MS = Math.max(
  60_000,
  Number(process.env.COCALC_HOST_PRESSURE_ALERT_FRESH_METRICS_MS ?? 5 * 60_000),
);
const RECONCILE_NUDGE_CATEGORIES = new Set<HostAvailabilityCategory>([
  "host_stale",
  "provider_offline",
  "spot_interruption",
]);

const logger = getLogger("server:hosts:availability");

let schemaReady: Promise<void> | undefined;
let maintenanceStarted = false;

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

type RunningStaleHostRow = ProjectHostAvailabilitySnapshot & {
  public_url?: string | null;
  internal_url?: string | null;
  owner_account_id?: string | null;
  stale_ms: number;
};

type HostPressureAlertRow = ProjectHostAvailabilitySnapshot & {
  public_url?: string | null;
  metric_collected_at?: Date | string | null;
  metric_memory_used_percent?: number | string | null;
  metric_memory_available_bytes?: number | string | null;
  metric_running_project_count?: number | string | null;
  pressure_zone: "pressure" | "emergency";
  pressure_action_status: "no_candidates" | "stop_failed";
  pressure_reason?: string;
};

type RuntimeDegradedHostRow = ProjectHostAvailabilitySnapshot & {
  public_url?: string | null;
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
    await pool().query(`
      /* CREATE TABLE IF NOT EXISTS ${TABLE}: state-check-v2 migration */
      DO $migration$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('${TABLE}:state-check-v2'));
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid='${TABLE}'::regclass
             AND conname='${TABLE}_state_check'
             AND pg_get_constraintdef(oid) LIKE '%unobserved%'
        ) THEN
          ALTER TABLE ${TABLE}
            DROP CONSTRAINT IF EXISTS ${TABLE}_state_check;
          ALTER TABLE ${TABLE}
            ADD CONSTRAINT ${TABLE}_state_check
            CHECK (state IN ('online', 'unobserved', 'unavailable', 'recovering', 'degraded'));
        END IF;
        UPDATE ${TABLE}
           SET state='unobserved', updated_at=NOW()
         WHERE admin_note IS NULL
           AND state <> 'unobserved'
           AND (
             (category='host_stale' AND planned=FALSE)
             OR (
               category='runtime_degraded'
               AND summary LIKE 'Host synthetic project probe failed:%'
             )
           );
      END
      $migration$;
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
    case "runtime_degraded":
    case "public_route_degraded":
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

function isServingSpotFallbackPhase(value: unknown): boolean {
  return value === "running_standard_fallback" || value === "probing_spot";
}

function isMisclassifiedServingSpotFallbackEvent(
  row: HostAvailabilityRow | undefined,
  observation: Required<
    Pick<
      HostAvailabilityObservation,
      "state" | "planned" | "category" | "source" | "details"
    >
  > & { summary?: string | null },
): boolean {
  return (
    !!row &&
    row.state === "recovering" &&
    row.category === "spot_interruption" &&
    observation.state === "online" &&
    observation.planned === false &&
    observation.category === "unknown" &&
    isServingSpotFallbackPhase(row.details?.recovery_phase) &&
    isServingSpotFallbackPhase(observation.details?.recovery_phase)
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
  if (isMisclassifiedServingSpotFallbackEvent(open, normalized)) {
    await pool().query(
      `UPDATE ${TABLE}
          SET state=$2,
              planned=$3,
              category=$4,
              source=$5,
              summary=$6,
              details=$7::jsonb,
              updated_at=NOW()
        WHERE id=$1`,
      [
        open.id,
        normalized.state,
        normalized.planned,
        normalized.category,
        normalized.source,
        normalized.summary,
        JSON.stringify(normalized.details),
      ],
    );
    return;
  }
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

function cloudProviderForAvailabilityNudge(
  row: ProjectHostAvailabilitySnapshot,
): string | undefined {
  const provider = `${row.metadata?.machine?.cloud ?? ""}`.trim();
  if (!provider || provider === "local" || provider === "self-host") {
    return undefined;
  }
  return provider;
}

function shouldNudgeCloudReconcile(
  observation: HostAvailabilityObservation,
): boolean {
  if (observation.planned) return false;
  if (!observation.category) return false;
  return RECONCILE_NUDGE_CATEGORIES.has(observation.category);
}

async function nudgeCloudReconcile(providers: Set<string>): Promise<void> {
  const values = Array.from(providers).filter(Boolean);
  if (!values.length) return;
  await pool().query(
    `
      INSERT INTO cloud_reconcile_state
        (provider, next_run_at, last_error, updated_at)
      SELECT provider, NOW(), NULL, NOW()
      FROM unnest($1::text[]) AS provider
      ON CONFLICT (provider)
      DO UPDATE SET
        next_run_at = LEAST(
          COALESCE(cloud_reconcile_state.next_run_at, NOW()),
          NOW()
        ),
        last_error = NULL,
        updated_at = NOW()
    `,
    [values],
  );
}

export function classifyHostAvailabilitySnapshot(
  row: ProjectHostAvailabilitySnapshot,
  source = "host_snapshot",
): HostAvailabilityObservation {
  const metadata = row.metadata ?? {};
  const desiredState = metadata.desired_state;
  const recoveryPhase = metadata.spot_recovery_state?.phase;
  const runtimeHealth = metadata.runtime_health ?? {};
  const syntheticProbe = metadata.runtime_synthetic_probe ?? {};
  const publicRouteProbe = metadata.public_route_probe ?? {};
  const runtimeStatus = `${runtimeHealth.status ?? ""}`.trim();
  const status = `${row.status ?? ""}`.trim();
  const lastSeen = normalizeDate(row.last_seen);
  const heartbeatFresh =
    !!lastSeen &&
    Date.now() - lastSeen.getTime() < HOST_AVAILABILITY_HEARTBEAT_GRACE_MS;
  const base = {
    host_id: row.id,
    source,
    details: {
      status,
      desired_state: desiredState,
      last_seen: lastSeen?.toISOString(),
      recovery_phase: recoveryPhase,
      runtime_health: runtimeHealth,
      synthetic_probe: syntheticProbe,
      public_route_probe: publicRouteProbe,
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
  if (
    status === "running" &&
    heartbeatFresh &&
    syntheticProbe.quarantined === true
  ) {
    return {
      ...base,
      state: "degraded",
      planned: false,
      category: "runtime_degraded",
      summary: syntheticProbe.error
        ? `Host synthetic project probe failed: ${syntheticProbe.error}`
        : "Host synthetic project probe failed.",
    };
  }
  if (status === "running" && heartbeatFresh && runtimeStatus === "starting") {
    return {
      ...base,
      state: "recovering",
      planned: false,
      category: "runtime_degraded",
      summary: "Host project runtime is starting.",
    };
  }
  if (
    status === "running" &&
    heartbeatFresh &&
    runtimeStatus &&
    (runtimeStatus !== "ready" || runtimeHealth.ready !== true)
  ) {
    return {
      ...base,
      state: "degraded",
      planned: false,
      category: "runtime_degraded",
      summary: runtimeHealth.error
        ? `Host project runtime is degraded: ${runtimeHealth.error}`
        : `Host project runtime is ${runtimeStatus}.`,
    };
  }
  if (
    status === "running" &&
    heartbeatFresh &&
    publicRouteProbe.quarantined === true
  ) {
    return {
      ...base,
      state: "degraded",
      planned: false,
      category: "public_route_degraded",
      summary: publicRouteProbe.error
        ? `Host public browser route is degraded: ${publicRouteProbe.error}`
        : publicRouteProbe.status === "recovering"
          ? "Host public browser route is recovering."
          : "Host public browser route is degraded.",
    };
  }
  if (isServingSpotFallbackPhase(recoveryPhase)) {
    if (status === "running" && heartbeatFresh) {
      return {
        ...base,
        state: "online",
        planned: false,
        category: "unknown",
        summary: "Host is online on standard fallback.",
      };
    }
    if (status === "running") {
      return {
        ...base,
        state: "unobserved",
        planned: false,
        category: "host_stale",
        summary:
          "Host is expected to be running, but control-plane observation is stale.",
      };
    }
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
      state: "unobserved",
      planned: false,
      category: "host_stale",
      summary:
        "Host is expected to be running, but control-plane observation is stale.",
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

export async function reconcileCurrentHostAvailability({
  limit = 10_000,
}: { limit?: number } = {}): Promise<number> {
  await ensureHostAvailabilitySchema();
  const { rows } = await pool().query<ProjectHostAvailabilitySnapshot>(
    `SELECT id, status, deleted, last_seen, metadata
       FROM project_hosts
      WHERE deleted IS NULL
      ORDER BY updated DESC
      LIMIT $1`,
    [Math.max(1, Math.floor(limit))],
  );
  const nudgeProviders = new Set<string>();
  for (const row of rows) {
    const observation = classifyHostAvailabilitySnapshot(
      row,
      "availability_maintenance",
    );
    await recordHostAvailabilityObservation(observation);
    if (shouldNudgeCloudReconcile(observation)) {
      const provider = cloudProviderForAvailabilityNudge(row);
      if (provider) nudgeProviders.add(provider);
    }
  }
  await nudgeCloudReconcile(nudgeProviders);
  return rows.length;
}

function staleHostName(row: RunningStaleHostRow): string {
  const metadataName =
    `${row.metadata?.name ?? row.metadata?.display_name ?? ""}`.trim();
  return metadataName || row.id;
}

function formatStaleDuration(ms: number): string {
  const normalized = Number(ms);
  const minutes = Math.max(
    1,
    Math.floor((Number.isFinite(normalized) ? normalized : 0) / 60_000),
  );
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h${remainder}m` : `${hours}h`;
}

function formatRunningStaleHostAlertBody(rows: RunningStaleHostRow[]): string {
  return [
    `${rows.length} project host${rows.length === 1 ? " is" : "s are"} marked running but not reporting heartbeats for at least ${formatStaleDuration(HOST_RUNNING_STALE_ALERT_MS)}.`,
    "",
    "This indicates a VM/provider state that is up while the project-host app is not connected to the hub, or a control-plane heartbeat observation problem.",
    "",
    `Automatic remediation: up to ${RUNNING_STALE_REPAIR_LIMIT} deduped host reconcile job${RUNNING_STALE_REPAIR_LIMIT === 1 ? "" : "s"} will be requested per maintenance tick, with a ${formatStaleDuration(RUNNING_STALE_REPAIR_SUPPRESS_MS)} per-host suppression window.`,
    "",
    "Hosts:",
    "",
    ...rows
      .slice(0, STALE_ALERT_LIMIT)
      .map((row) =>
        [
          `- ${staleHostName(row)}`,
          `host_id=${row.id}`,
          `stale>=${formatStaleDuration(HOST_RUNNING_STALE_ALERT_MS)}`,
          row.public_url ? `url=${row.public_url}` : undefined,
        ]
          .filter((part) => part != null)
          .join(" "),
      ),
    rows.length > STALE_ALERT_LIMIT
      ? `- ... ${rows.length - STALE_ALERT_LIMIT} more`
      : undefined,
  ]
    .filter((line) => line != null)
    .join("\n");
}

async function getRunningStaleHosts(): Promise<RunningStaleHostRow[]> {
  const { rows } = await pool().query<RunningStaleHostRow>(
    `
      SELECT
        id,
        status,
        deleted,
        last_seen,
        metadata,
        public_url,
        internal_url,
        metadata ->> 'owner' AS owner_account_id,
        GREATEST(
          0,
          FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(last_seen, to_timestamp(0)))) * 1000)
        )::bigint AS stale_ms
      FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND COALESCE(last_seen, to_timestamp(0)) < NOW() - ($1::double precision * INTERVAL '1 millisecond')
      ORDER BY last_seen ASC NULLS FIRST
      LIMIT $2
    `,
    [HOST_RUNNING_STALE_ALERT_MS, STALE_ALERT_LIMIT + 1],
  );
  return rows;
}

function ownerAccountId(row: RunningStaleHostRow): string | undefined {
  return (
    `${row.owner_account_id ?? row.metadata?.owner ?? ""}`.trim() || undefined
  );
}

async function recentRunningStaleRepairExists(
  host_id: string,
): Promise<boolean> {
  await ensureLroSchema();
  const { rows } = await pool().query(
    `
      SELECT 1
      FROM long_running_operations
      WHERE scope_type='host'
        AND scope_id=$1
        AND kind=$2
        AND dedupe_key=$3
        AND updated_at > NOW() - ($4::double precision * INTERVAL '1 millisecond')
      LIMIT 1
    `,
    [
      host_id,
      HOST_RECONCILE_LRO_KIND,
      `${HOST_RECONCILE_LRO_KIND}:${host_id}`,
      RUNNING_STALE_REPAIR_SUPPRESS_MS,
    ],
  );
  return rows.length > 0;
}

async function enqueueRunningStaleHostRepairs(
  rows: RunningStaleHostRow[],
): Promise<number> {
  if (RUNNING_STALE_REPAIR_LIMIT <= 0) return 0;
  let queued = 0;
  for (const row of rows.slice(0, RUNNING_STALE_REPAIR_LIMIT)) {
    const account_id = ownerAccountId(row);
    if (!account_id) {
      logger.warn("skipping stale-running host repair without owner", {
        host_id: row.id,
      });
      continue;
    }
    try {
      if (await recentRunningStaleRepairExists(row.id)) {
        continue;
      }
      await createLro({
        kind: HOST_RECONCILE_LRO_KIND,
        scope_type: "host",
        scope_id: row.id,
        created_by: account_id,
        routing: "hub",
        input: {
          id: row.id,
          account_id,
          reason: "running_stale_heartbeat",
          source: "host_availability_maintenance",
        },
        dedupe_key: `${HOST_RECONCILE_LRO_KIND}:${row.id}`,
        status: "queued",
      });
      queued += 1;
    } catch (err) {
      logger.warn("failed to enqueue stale-running host repair", {
        host_id: row.id,
        err: `${err}`,
      });
    }
  }
  return queued;
}

export async function runRunningStaleHostAlertCheck(): Promise<number> {
  const rows = await getRunningStaleHosts();
  if (!rows.length) return 0;
  const repairCount = await enqueueRunningStaleHostRepairs(rows);
  await adminAlert({
    subject: "Running project hosts are not reporting",
    body: formatRunningStaleHostAlertBody(rows),
    dedupMinutes: 30,
  });
  if (repairCount) {
    logger.warn("enqueued stale-running host reconcile repairs", {
      count: repairCount,
    });
  }
  return rows.length;
}

function pressureAlertHostName(row: HostPressureAlertRow): string {
  const metadataName =
    `${row.metadata?.name ?? row.metadata?.display_name ?? ""}`.trim();
  return metadataName || row.id;
}

function numericValue(value: unknown): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  const time =
    value instanceof Date ? value.getTime() : new Date(`${value}`).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function pressureAlertRow(
  row: ProjectHostAvailabilitySnapshot & {
    public_url?: string | null;
    metric_collected_at?: Date | string | null;
    metric_memory_used_percent?: number | string | null;
    metric_memory_available_bytes?: number | string | null;
    metric_running_project_count?: number | string | null;
  },
  now = Date.now(),
): HostPressureAlertRow | undefined {
  const pressure = row.metadata?.pressure ?? {};
  const zone = `${pressure.zone ?? ""}`.trim();
  const actionStatus = `${pressure.last_action_status ?? ""}`.trim();
  if (zone !== "pressure" && zone !== "emergency") return undefined;
  if (actionStatus !== "no_candidates" && actionStatus !== "stop_failed") {
    return undefined;
  }
  const evaluatedAtMs = numericValue(pressure.evaluated_at_ms);
  if (
    evaluatedAtMs != null &&
    now - evaluatedAtMs > PRESSURE_ALERT_STALE_EVALUATION_MS
  ) {
    return undefined;
  }
  const metricCollectedAtMs = timestampMs(row.metric_collected_at);
  if (
    metricCollectedAtMs != null &&
    now - metricCollectedAtMs <= PRESSURE_ALERT_FRESH_METRICS_MS
  ) {
    const usedPercent = numericValue(row.metric_memory_used_percent);
    const runningProjects = numericValue(row.metric_running_project_count);
    const reason = `${pressure.last_action_reason ?? pressure.reason ?? ""}`;
    const isMemoryPressureReason =
      reason.includes("memory_used_percent") ||
      reason.includes("memory_available_bytes");
    if (isMemoryPressureReason && usedPercent != null && usedPercent < 80) {
      return undefined;
    }
    if (
      actionStatus === "no_candidates" &&
      runningProjects === 0 &&
      usedPercent != null &&
      usedPercent < 80
    ) {
      return undefined;
    }
  }
  return {
    ...row,
    pressure_zone: zone,
    pressure_action_status: actionStatus,
    pressure_reason:
      `${pressure.last_action_reason ?? pressure.reason ?? ""}`.trim() ||
      undefined,
  };
}

function formatHostPressureAlertBody(rows: HostPressureAlertRow[]): string {
  return [
    `${rows.length} project host${rows.length === 1 ? " has" : "s have"} unresolved host-local pressure actions.`,
    "",
    "This means the host is under memory/resource pressure but the automatic pressure controller either could not find a project to stop or failed to stop one.",
    "",
    "Hosts:",
    "",
    ...rows
      .slice(0, PRESSURE_ALERT_LIMIT)
      .map((row) =>
        [
          `- ${pressureAlertHostName(row)}`,
          `host_id=${row.id}`,
          `zone=${row.pressure_zone}`,
          `action=${row.pressure_action_status}`,
          row.public_url ? `url=${row.public_url}` : undefined,
        ]
          .filter((part) => part != null)
          .join(" "),
      ),
    rows.length > PRESSURE_ALERT_LIMIT
      ? "- ... more hosts not shown"
      : undefined,
  ]
    .filter((line) => line != null)
    .join("\n");
}

async function getHostPressureAlertRows(): Promise<HostPressureAlertRow[]> {
  await ensureProjectHostMetricsSamplesSchema();
  const { rows } = await pool().query<
    ProjectHostAvailabilitySnapshot & { public_url?: string | null }
  >(
    `
      SELECT
        h.id,
        h.status,
        h.deleted,
        h.last_seen,
        h.metadata,
        h.public_url,
        m.collected_at AS metric_collected_at,
        m.memory_used_percent AS metric_memory_used_percent,
        m.memory_available_bytes AS metric_memory_available_bytes,
        m.running_project_count AS metric_running_project_count
      FROM project_hosts h
      LEFT JOIN LATERAL (
        SELECT
          collected_at,
          memory_used_percent,
          memory_available_bytes,
          running_project_count
        FROM project_host_metrics_samples
        WHERE host_id = h.id
        ORDER BY collected_at DESC
        LIMIT 1
      ) m ON true
      WHERE h.deleted IS NULL
        AND h.status = 'running'
        AND h.metadata ? 'pressure'
      ORDER BY h.last_seen DESC NULLS LAST
      LIMIT 1000
    `,
  );
  return rows.map(pressureAlertRow).filter((row) => row != null);
}

export async function runHostPressureAlertCheck(): Promise<number> {
  const rows = await getHostPressureAlertRows();
  if (!rows.length) return 0;
  await adminAlert({
    subject: "Project hosts have unresolved pressure actions",
    body: formatHostPressureAlertBody(rows),
    dedupMinutes: 30,
  });
  return rows.length;
}

function runtimeDegradedHostName(row: RuntimeDegradedHostRow): string {
  return (
    `${row.metadata?.name ?? row.metadata?.display_name ?? ""}`.trim() || row.id
  );
}

function formatRuntimeDegradedHostAlertBody(
  rows: RuntimeDegradedHostRow[],
): string {
  return [
    `${rows.length} project host${rows.length === 1 ? " has" : "s have"} fresh heartbeats but a failing container-runtime probe.`,
    "",
    "These hosts are excluded from project placement and restart recovery. Investigate the captured project-host diagnostics before rebooting so the underlying failure is not erased.",
    "",
    "Hosts:",
    "",
    ...rows.slice(0, RUNTIME_DEGRADED_ALERT_LIMIT).map((row) => {
      const runtime = row.metadata?.runtime_health ?? {};
      return [
        `- ${runtimeDegradedHostName(row)}`,
        `host_id=${row.id}`,
        `failures=${runtime.consecutive_failures ?? "unknown"}`,
        runtime.checked_at ? `checked_at=${runtime.checked_at}` : undefined,
        runtime.error ? `error=${runtime.error}` : undefined,
        row.public_url ? `url=${row.public_url}` : undefined,
      ]
        .filter((part) => part != null)
        .join(" ");
    }),
    rows.length > RUNTIME_DEGRADED_ALERT_LIMIT
      ? `- ... ${rows.length - RUNTIME_DEGRADED_ALERT_LIMIT} more`
      : undefined,
  ]
    .filter((line) => line != null)
    .join("\n");
}

async function getRuntimeDegradedHosts(): Promise<RuntimeDegradedHostRow[]> {
  const { rows } = await pool().query<RuntimeDegradedHostRow>(
    `
      SELECT id, status, deleted, last_seen, metadata, public_url
      FROM project_hosts
      WHERE deleted IS NULL
        AND status = 'running'
        AND COALESCE(last_seen, to_timestamp(0)) >= NOW() - ($1::double precision * INTERVAL '1 millisecond')
        AND metadata -> 'runtime_health' ->> 'status' = 'degraded'
        AND COALESCE(
          (metadata -> 'runtime_health' ->> 'consecutive_failures')::integer,
          0
        ) >= $2
      ORDER BY last_seen DESC
      LIMIT $3
    `,
    [
      HOST_AVAILABILITY_HEARTBEAT_GRACE_MS,
      RUNTIME_DEGRADED_ALERT_FAILURES,
      RUNTIME_DEGRADED_ALERT_LIMIT + 1,
    ],
  );
  return rows;
}

export async function runRuntimeDegradedHostAlertCheck(): Promise<number> {
  const rows = await getRuntimeDegradedHosts();
  if (!rows.length) return 0;
  await adminAlert({
    subject: "Project hosts have degraded container runtimes",
    body: formatRuntimeDegradedHostAlertBody(rows),
    dedupMinutes: 15,
  });
  return rows.length;
}

export function startHostAvailabilityMaintenance({
  interval_ms = DEFAULT_MAINTENANCE_INTERVAL_MS,
}: { interval_ms?: number } = {}): void {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  const run = async () => {
    try {
      const count = await reconcileCurrentHostAvailability();
      const staleRunning = await runRunningStaleHostAlertCheck();
      const pressureProblems = await runHostPressureAlertCheck();
      const runtimeProblems = await runRuntimeDegradedHostAlertCheck();
      void runProjectHostRuntimeMaintenance().catch((err) => {
        logger.warn("project-host runtime maintenance failed", {
          err: `${err}`,
        });
      });
      logger.debug("host availability maintenance complete", { count });
      if (staleRunning) {
        logger.warn("running project hosts are not reporting", {
          count: staleRunning,
        });
      }
      if (pressureProblems) {
        logger.warn("project hosts have unresolved pressure actions", {
          count: pressureProblems,
        });
      }
      if (runtimeProblems) {
        logger.warn("project hosts have degraded container runtimes", {
          count: runtimeProblems,
        });
      }
    } catch (err) {
      logger.warn("host availability maintenance failed", { err: `${err}` });
    }
  };
  void run();
  const timer = setInterval(() => void run(), interval_ms);
  timer.unref?.();
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
  const { rows: hostRows } = await pool().query<{
    last_seen?: Date | string | null;
    metadata?: Record<string, any> | null;
  }>(
    `SELECT last_seen, metadata
       FROM project_hosts
      WHERE id=$1
      LIMIT 1`,
    [hostId],
  );
  const hostRow = hostRows[0];
  const hostMetadata = hostRow?.metadata ?? {};
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
      unobserved_ms: number;
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
      unobserved_ms: 0,
      planned_downtime_ms: 0,
      unplanned_downtime_ms: 0,
      outage_count: 0,
      events: [],
    });
  }
  let onlineMs = 0;
  let unobservedMs = 0;
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
    } else if (event.state === "unobserved") {
      unobservedMs += eventWindowMs;
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
      } else if (event.state === "unobserved") {
        day.unobserved_ms += ms;
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
  const intendedOnlineMs = onlineMs + unplannedDowntimeMs;
  const observedWindowMs = Math.max(0, windowMs - unobservedMs);
  const hostBootStartedAt = normalizeDate(hostMetadata.host_boot_started_at);
  const sampledHostUptimeMs = Number(hostMetadata.host_uptime_s) * 1000;
  const lastSeenAt = normalizeDate(hostRow?.last_seen);
  const sampleAgeMs = lastSeenAt
    ? Math.max(0, now.getTime() - lastSeenAt.getTime())
    : 0;
  const machineUptimeMs = hostBootStartedAt
    ? Math.max(0, now.getTime() - hostBootStartedAt.getTime())
    : Number.isFinite(sampledHostUptimeMs)
      ? Math.max(0, sampledHostUptimeMs + sampleAgeMs)
      : undefined;
  const hostSessionStartedAt = normalizeDate(
    hostMetadata.host_session_started_at,
  );
  const syntheticProbe = hostMetadata.runtime_synthetic_probe ?? {};
  const syntheticTotal = Math.max(0, Number(syntheticProbe.total_checks) || 0);
  const syntheticPassed = Math.max(
    0,
    Number(syntheticProbe.passed_checks) || 0,
  );
  const syntheticFailed = Math.max(
    0,
    Number(syntheticProbe.failed_checks) || 0,
  );
  const syntheticStatus = `${syntheticProbe.status ?? ""}`;
  return {
    host_id: hostId,
    generated_at: now.toISOString(),
    window_days: windowDays,
    summary: {
      current_state: currentEvent?.state ?? "unavailable",
      current_healthy_interval_ms: currentUptimeMs,
      current_uptime_ms: currentUptimeMs,
      machine_uptime_ms: machineUptimeMs,
      machine_boot_started_at: hostBootStartedAt?.toISOString(),
      project_host_session_uptime_ms: hostSessionStartedAt
        ? Math.max(0, now.getTime() - hostSessionStartedAt.getTime())
        : undefined,
      project_host_session_started_at: hostSessionStartedAt?.toISOString(),
      window_uptime_percent:
        observedWindowMs > 0 ? (onlineMs / observedWindowMs) * 100 : 0,
      reliability_percent:
        intendedOnlineMs > 0 ? (onlineMs / intendedOnlineMs) * 100 : 100,
      intended_online_ms: intendedOnlineMs,
      planned_downtime_ms: plannedDowntimeMs,
      unplanned_downtime_ms: unplannedDowntimeMs,
      unobserved_ms: unobservedMs,
      unplanned_outage_count: unplannedOutageCount,
      longest_outage_ms: longestOutageMs,
      current_event: currentEvent,
      synthetic_probe: ["running", "passed", "failed"].includes(syntheticStatus)
        ? {
            status: syntheticStatus as "running" | "passed" | "failed",
            checked_at: normalizeDate(
              syntheticProbe.checked_at ?? syntheticProbe.claimed_at,
            )?.toISOString(),
            consecutive_failures: Math.max(
              0,
              Number(syntheticProbe.consecutive_failures) || 0,
            ),
            quarantined: syntheticProbe.quarantined === true,
            total_checks: syntheticTotal,
            passed_checks: syntheticPassed,
            failed_checks: syntheticFailed,
            pass_percent:
              syntheticTotal > 0
                ? (syntheticPassed / syntheticTotal) * 100
                : undefined,
            error: `${syntheticProbe.error ?? ""}`.trim() || undefined,
          }
        : undefined,
    },
    days: Array.from(daysMap, ([date, day]) => ({
      date,
      uptime_percent:
        day.total_ms - day.unobserved_ms > 0
          ? Math.min(
              100,
              (day.online_ms / (day.total_ms - day.unobserved_ms)) * 100,
            )
          : 0,
      online_ms: day.online_ms,
      unobserved_ms: day.unobserved_ms,
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

export const _test = {
  formatHostPressureAlertBody,
  formatRuntimeDegradedHostAlertBody,
  formatRunningStaleHostAlertBody,
  formatStaleDuration,
  pressureAlertRow,
};
