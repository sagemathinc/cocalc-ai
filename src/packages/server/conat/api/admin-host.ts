/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "crypto";
import getPool from "@cocalc/database/pool";
import { loadProjectHostMetricsHistory } from "@cocalc/database/postgres/project-host-metrics";
import centralLog from "@cocalc/database/postgres/central-log";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { isValidUUID, uuid } from "@cocalc/util/misc";
import type {
  AdminHostAbuseFilesystemsRequest,
  AdminHostAbuseFilesystemsResponse,
  AdminHostAbuseProcessesRequest,
  AdminHostAbuseProcessesResponse,
  AdminHostDescribeRequest,
  AdminHostDescribeResponse,
  AdminHostEvent,
  AdminHostEventsRequest,
  AdminHostEventsResponse,
  AdminHostFilesystemRequest,
  AdminHostFilesystemResponse,
  AdminHostIntrusionSnapshotRequest,
  AdminHostIntrusionSnapshotResponse,
  AdminHostLogsRequest,
  AdminHostLogsResponse,
  AdminHostNetworkRequest,
  AdminHostNetworkResponse,
  AdminHostPodmanRequest,
  AdminHostPodmanResponse,
  AdminHostProcessRequest,
  AdminHostProcessResponse,
  AdminHostTopRequest,
  AdminHostTopResponse,
} from "@cocalc/conat/hub/api/admin-host";

type AdminAuthOpts = {
  account_id?: string;
};

const logger = getLogger("server:conat:api:admin-host");

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 5000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;
const DEFAULT_EVENTS_WINDOW_MINUTES = 24 * 60;
const MAX_EVENTS_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_METRICS_WINDOW_MINUTES = 60;
const MAX_METRICS_WINDOW_MINUTES = 7 * 24 * 60;
const DEFAULT_METRICS_POINTS = 60;
const MAX_METRICS_POINTS = 240;

function pool() {
  return getPool();
}

function normalizePositiveInt({
  value,
  fallback,
  max,
}: {
  value?: number;
  fallback: number;
  max: number;
}): number {
  const n = Math.floor(Number(value ?? fallback));
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(n, max);
}

async function requireAdminAccount({
  account_id,
}: AdminAuthOpts): Promise<string> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    throw new Error("must be signed in");
  }
  if (!(await isAdmin(accountId))) {
    throw Object.assign(new Error("admin privileges required"), { code: 403 });
  }
  return accountId;
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function filterLogText(text: string, grep?: string): string {
  const needle = `${grep ?? ""}`.trim();
  if (!needle) {
    return text;
  }
  if (needle.length > 200) {
    throw new Error("--grep must be at most 200 characters");
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes(needle))
    .join("\n");
}

function truncateText({ text, maxBytes }: { text: string; maxBytes: number }): {
  text: string;
  bytes: number;
  truncated: boolean;
} {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, bytes, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8");
  const truncated = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  return {
    text: `[truncated to last ${maxBytes} bytes]\n${truncated}`,
    bytes: maxBytes,
    truncated: true,
  };
}

async function recordAudit({
  audit_id,
  account_id,
  mode,
  host_id,
  source,
  lines,
  grep,
  reason,
  duration_ms,
  result_bytes,
  truncated,
  error,
}: {
  audit_id: string;
  account_id: string;
  mode:
    | "abuse-filesystems"
    | "abuse-processes"
    | "describe"
    | "events"
    | "filesystem"
    | "intrusion-snapshot"
    | "logs"
    | "net"
    | "podman"
    | "ps"
    | "top";
  host_id: string;
  source?: string;
  lines?: number;
  grep?: string;
  reason?: string;
  duration_ms?: number;
  result_bytes?: number;
  truncated?: boolean;
  error?: unknown;
}) {
  try {
    await centralLog({
      event: "admin_host_operator",
      value: {
        audit_id,
        account_id,
        mode,
        host_id,
        source: source ?? null,
        lines: lines ?? null,
        grep_sha256: grep ? textHash(grep) : null,
        reason: reason ?? null,
        duration_ms,
        result_bytes,
        truncated,
        error: error == null ? null : `${error}`,
      },
    });
  } catch (err) {
    logger.warn("failed to write admin host audit event", { audit_id, err });
  }
}

function normalizeDateString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(`${value}`);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function heartbeatAgeMs(lastSeen: unknown): number | undefined {
  const value = normalizeDateString(lastSeen);
  if (!value) {
    return undefined;
  }
  return Math.max(0, Date.now() - new Date(value).getTime());
}

function redactSensitiveMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveMetadata(item));
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = /token|secret|password|private/i.test(key)
      ? "[REDACTED]"
      : redactSensitiveMetadata(item);
  }
  return redacted;
}

function scrubHostRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    bay_id: row.bay_id,
    public_url: row.public_url,
    internal_url: row.internal_url,
    ssh_server: row.ssh_server,
    status: row.status,
    last_seen: normalizeDateString(row.last_seen) ?? null,
    version: row.version,
    tier: row.tier,
    created: normalizeDateString(row.created) ?? null,
    updated: normalizeDateString(row.updated) ?? null,
    deletion_protection: row.deletion_protection,
    capacity: redactSensitiveMetadata(row.capacity ?? {}),
    metadata: redactSensitiveMetadata(row.metadata ?? {}),
  };
}

async function resolveHost({
  host,
  host_id,
}: {
  host?: string;
  host_id?: string;
}): Promise<Record<string, unknown>> {
  const target = `${host_id ?? host ?? ""}`.trim();
  if (!target) {
    throw new Error("host id or name is required");
  }
  const byId = isValidUUID(target);
  const { rows } = await pool().query(
    byId
      ? `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`
      : `SELECT * FROM project_hosts WHERE name=$1 AND deleted IS NULL ORDER BY last_seen DESC NULLS LAST LIMIT 2`,
    [target],
  );
  if (rows.length === 0) {
    throw new Error("host not found");
  }
  if (!byId && rows.length > 1) {
    throw new Error(
      `multiple hosts named '${target}'; use --host-id with the UUID`,
    );
  }
  return rows[0];
}

async function loadProjectCounts(
  hostId: string,
): Promise<Record<string, number>> {
  const { rows } = await pool().query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE COALESCE(state->>'state', '')='running')::int AS running,
       count(*) FILTER (WHERE COALESCE(state->>'state', '')='stopped')::int AS stopped,
       count(*) FILTER (WHERE provisioned IS TRUE)::int AS provisioned,
       count(*) FILTER (WHERE provisioned IS NOT TRUE)::int AS not_provisioned
     FROM projects
     WHERE host_id=$1 AND deleted IS NULL`,
    [hostId],
  );
  return rows[0] ?? {};
}

async function loadRecentLros({
  hostId,
  limit,
  sinceMinutes,
}: {
  hostId: string;
  limit: number;
  sinceMinutes?: number;
}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [hostId, limit];
  let windowClause = "";
  if (sinceMinutes != null) {
    params.push(sinceMinutes * 60);
    windowClause = `AND updated_at >= now() - make_interval(secs => $3::double precision)`;
  }
  const { rows } = await pool().query(
    `SELECT op_id, kind, status, created_by, owner_type, owner_id,
            attempt, heartbeat_at, created_at, started_at, finished_at,
            updated_at, expires_at, left(coalesce(error, ''), 1000) AS error,
            progress_summary, result
     FROM long_running_operations
     WHERE scope_type='host' AND scope_id=$1::uuid
       ${windowClause}
     ORDER BY updated_at DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

async function loadAvailabilityEvents({
  hostId,
  limit,
  sinceMinutes,
}: {
  hostId: string;
  limit: number;
  sinceMinutes?: number;
}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [hostId, limit];
  let windowClause = "";
  if (sinceMinutes != null) {
    params.push(sinceMinutes * 60);
    windowClause = `AND started_at >= now() - make_interval(secs => $3::double precision)`;
  }
  const { rows } = await pool().query(
    `SELECT id, host_id, started_at, ended_at, state, planned, category,
            source, summary, details, admin_note, admin_note_visibility,
            created_at, updated_at
     FROM project_host_availability_events
     WHERE host_id=$1::uuid
       ${windowClause}
     ORDER BY started_at DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

function availabilityEvent(row: Record<string, unknown>): AdminHostEvent {
  return {
    timestamp: normalizeDateString(row.started_at) ?? "",
    category: "availability",
    summary: `${row.state ?? "unknown"} ${row.category ?? "unknown"}${row.summary ? `: ${row.summary}` : ""}`,
    details: row,
  };
}

function lroEvent(row: Record<string, unknown>): AdminHostEvent {
  return {
    timestamp:
      normalizeDateString(row.updated_at) ??
      normalizeDateString(row.created_at) ??
      "",
    category: "lro",
    summary: `${row.kind ?? "lro"} ${row.status ?? "unknown"}`,
    details: row,
  };
}

function hostRecordEvents(row: Record<string, unknown>): AdminHostEvent[] {
  const events: AdminHostEvent[] = [];
  const lastSeen = normalizeDateString(row.last_seen);
  if (lastSeen) {
    events.push({
      timestamp: lastSeen,
      category: "heartbeat",
      summary: `last heartbeat from ${row.name ?? row.id}`,
      details: { host_id: row.id, status: row.status },
    });
  }
  const updated = normalizeDateString(row.updated);
  if (updated) {
    events.push({
      timestamp: updated,
      category: "host-record",
      summary: "host record updated",
      details: { host_id: row.id, status: row.status, version: row.version },
    });
  }
  return events;
}

export async function describe({
  account_id,
  host,
  host_id,
  recent_limit,
  include_live = true,
  reason,
}: AdminAuthOpts &
  AdminHostDescribeRequest): Promise<AdminHostDescribeResponse> {
  const accountId = await requireAdminAccount({ account_id });
  const audit_id = uuid();
  const limit = normalizePositiveInt({
    value: recent_limit,
    fallback: DEFAULT_RECENT_LIMIT,
    max: MAX_RECENT_LIMIT,
  });
  const row = await resolveHost({ host, host_id });
  const hostId = `${row.id}`;
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode: "describe",
    host_id: hostId,
    reason,
  });
  const started = Date.now();
  try {
    const [projectCounts, recentLros, availabilityEvents] = await Promise.all([
      loadProjectCounts(hostId),
      loadRecentLros({ hostId, limit }),
      loadAvailabilityEvents({ hostId, limit }),
    ]);
    const liveErrors: string[] = [];
    let hostAgentStatus: Record<string, unknown> | undefined;
    let managedComponents: Record<string, unknown>[] | undefined;
    if (include_live) {
      try {
        const client = await getRoutedHostControlClient({
          host_id: hostId,
          timeout: 10_000,
          fresh: true,
        });
        const [agent, components] = await Promise.all([
          client.getHostAgentStatus(),
          client.getManagedComponentStatus(),
        ]);
        hostAgentStatus = agent as unknown as Record<string, unknown>;
        managedComponents = components as unknown as Record<string, unknown>[];
      } catch (err) {
        liveErrors.push(`${err}`);
      }
    }
    const result: AdminHostDescribeResponse = {
      audit_id,
      host_id: hostId,
      server_time: new Date().toISOString(),
      host: scrubHostRow(row),
      heartbeat_age_ms: heartbeatAgeMs(row.last_seen),
      project_counts: projectCounts,
      recent_lros: recentLros,
      availability_events: availabilityEvents,
      host_agent_status: hostAgentStatus,
      managed_components: managedComponents,
      live_errors: liveErrors.length ? liveErrors : undefined,
    };
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "describe",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      truncated: false,
    });
    return result;
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "describe",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export async function events({
  account_id,
  host,
  host_id,
  since_minutes,
  limit,
  reason,
}: AdminAuthOpts & AdminHostEventsRequest): Promise<AdminHostEventsResponse> {
  const accountId = await requireAdminAccount({ account_id });
  const audit_id = uuid();
  const row = await resolveHost({ host, host_id });
  const hostId = `${row.id}`;
  const normalizedLimit = normalizePositiveInt({
    value: limit,
    fallback: 100,
    max: 1000,
  });
  const sinceMinutes = normalizePositiveInt({
    value: since_minutes,
    fallback: DEFAULT_EVENTS_WINDOW_MINUTES,
    max: MAX_EVENTS_WINDOW_MINUTES,
  });
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode: "events",
    host_id: hostId,
    reason,
  });
  const started = Date.now();
  try {
    const [lros, availability] = await Promise.all([
      loadRecentLros({
        hostId,
        limit: normalizedLimit + 1,
        sinceMinutes,
      }),
      loadAvailabilityEvents({
        hostId,
        limit: normalizedLimit + 1,
        sinceMinutes,
      }),
    ]);
    const events = [
      ...hostRecordEvents(row),
      ...availability.map(availabilityEvent),
      ...lros.map(lroEvent),
    ]
      .filter((event) => !!event.timestamp)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const truncated = events.length > normalizedLimit;
    const limited = truncated ? events.slice(0, normalizedLimit) : events;
    const result: AdminHostEventsResponse = {
      audit_id,
      host_id: hostId,
      server_time: new Date().toISOString(),
      events: limited,
      truncated,
    };
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "events",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      truncated,
    });
    return result;
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "events",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export async function top({
  account_id,
  host,
  host_id,
  window_minutes,
  max_points,
  reason,
}: AdminAuthOpts & AdminHostTopRequest): Promise<AdminHostTopResponse> {
  const accountId = await requireAdminAccount({ account_id });
  const audit_id = uuid();
  const row = await resolveHost({ host, host_id });
  const hostId = `${row.id}`;
  const windowMinutes = normalizePositiveInt({
    value: window_minutes,
    fallback: DEFAULT_METRICS_WINDOW_MINUTES,
    max: MAX_METRICS_WINDOW_MINUTES,
  });
  const maxPoints = normalizePositiveInt({
    value: max_points,
    fallback: DEFAULT_METRICS_POINTS,
    max: MAX_METRICS_POINTS,
  });
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode: "top",
    host_id: hostId,
    reason,
  });
  const started = Date.now();
  try {
    const history = (
      await loadProjectHostMetricsHistory({
        host_ids: [hostId],
        window_minutes: windowMinutes,
        max_points: maxPoints,
      })
    ).get(hostId);
    const result: AdminHostTopResponse = {
      audit_id,
      host_id: hostId,
      server_time: new Date().toISOString(),
      window_minutes: history?.window_minutes ?? windowMinutes,
      point_count: history?.point_count ?? 0,
      current: history?.points?.[history.points.length - 1] as
        | Record<string, unknown>
        | undefined,
      derived: history?.derived as Record<string, unknown> | undefined,
      growth: history?.growth as Record<string, unknown> | undefined,
      points: history?.points as Record<string, unknown>[] | undefined,
    };
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "top",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      truncated: (history?.points?.length ?? 0) >= maxPoints,
    });
    return result;
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "top",
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

async function runLiveHostDiagnostic<T>({
  account_id,
  host,
  host_id,
  mode,
  reason,
  timeout = 30_000,
  run,
}: {
  account_id?: string;
  host?: string;
  host_id?: string;
  mode:
    | "abuse-filesystems"
    | "abuse-processes"
    | "filesystem"
    | "intrusion-snapshot"
    | "net"
    | "podman"
    | "ps";
  reason?: string;
  timeout?: number;
  run: (
    client: Awaited<ReturnType<typeof getRoutedHostControlClient>>,
  ) => Promise<T>;
}): Promise<{
  audit_id: string;
  host_id: string;
  server_time: string;
  snapshot: T;
}> {
  const accountId = await requireAdminAccount({ account_id });
  const audit_id = uuid();
  const row = await resolveHost({ host, host_id });
  const hostId = `${row.id}`;
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode,
    host_id: hostId,
    reason,
  });
  const started = Date.now();
  try {
    const client = await getRoutedHostControlClient({
      host_id: hostId,
      timeout,
      fresh: true,
    });
    const snapshot = await run(client);
    const result = {
      audit_id,
      host_id: hostId,
      server_time: new Date().toISOString(),
      snapshot,
    };
    const diagnostic = snapshot as {
      coverage?: string;
      skipped_large_project_count?: number;
      truncated?: Record<string, boolean>;
    };
    const snapshotTruncated =
      (diagnostic.coverage != null && diagnostic.coverage !== "complete") ||
      Number(diagnostic.skipped_large_project_count ?? 0) > 0 ||
      Object.values(diagnostic.truncated ?? {}).some(Boolean);
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode,
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      result_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      truncated: snapshotTruncated,
    });
    return result;
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode,
      host_id: hostId,
      reason,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}

export async function scanAbuseFilesystems({
  account_id,
  host,
  host_id,
  max_projects,
  max_entries_per_project,
  max_total_entries,
  max_depth,
  timeout_ms,
  reason,
}: AdminAuthOpts &
  AdminHostAbuseFilesystemsRequest): Promise<AdminHostAbuseFilesystemsResponse> {
  const maxProjects = normalizePositiveInt({
    value: max_projects,
    fallback: 2_000,
    max: 5_000,
  });
  const maxEntriesPerProject = normalizePositiveInt({
    value: max_entries_per_project,
    fallback: 2_000,
    max: 10_000,
  });
  const maxTotalEntries = normalizePositiveInt({
    value: max_total_entries,
    fallback: 50_000,
    max: 250_000,
  });
  const maxDepth = normalizePositiveInt({
    value: max_depth,
    fallback: 4,
    max: 8,
  });
  const timeoutMs = normalizePositiveInt({
    value: timeout_ms,
    fallback: 10_000,
    max: 30_000,
  });
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "abuse-filesystems",
    reason,
    timeout: timeoutMs + 15_000,
    run: async (client) =>
      await client.getAbuseFilesystemSnapshot({
        max_projects: maxProjects,
        max_entries_per_project: maxEntriesPerProject,
        max_total_entries: maxTotalEntries,
        max_depth: maxDepth,
        timeout_ms: timeoutMs,
      }),
  });
}

export async function scanAbuseProcesses({
  account_id,
  host,
  host_id,
  max_projects,
  max_processes,
  timeout_ms,
  reason,
}: AdminAuthOpts &
  AdminHostAbuseProcessesRequest): Promise<AdminHostAbuseProcessesResponse> {
  const maxProjects = normalizePositiveInt({
    value: max_projects,
    fallback: 2_000,
    max: 5_000,
  });
  const maxProcesses = normalizePositiveInt({
    value: max_processes,
    fallback: 10_000,
    max: 50_000,
  });
  const timeoutMs = normalizePositiveInt({
    value: timeout_ms,
    fallback: 5_000,
    max: 15_000,
  });
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "abuse-processes",
    reason,
    run: async (client) =>
      await client.getAbuseProcessSnapshot({
        max_projects: maxProjects,
        max_processes: maxProcesses,
        timeout_ms: timeoutMs,
      }),
  });
}

export async function ps({
  account_id,
  host,
  host_id,
  limit,
  sort,
  reason,
}: AdminAuthOpts & AdminHostProcessRequest): Promise<AdminHostProcessResponse> {
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "ps",
    reason,
    run: async (client) =>
      await client.getProcessSnapshot({
        limit,
        sort,
      }),
  });
}

export async function net({
  account_id,
  host,
  host_id,
  limit,
  reason,
}: AdminAuthOpts & AdminHostNetworkRequest): Promise<AdminHostNetworkResponse> {
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "net",
    reason,
    run: async (client) =>
      await client.getNetworkSnapshot({
        limit,
      }),
  });
}

export async function filesystem({
  account_id,
  host,
  host_id,
  reason,
}: AdminAuthOpts &
  AdminHostFilesystemRequest): Promise<AdminHostFilesystemResponse> {
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "filesystem",
    reason,
    run: async (client) => await client.getFilesystemSnapshot(),
  });
}

export async function intrusionSnapshot({
  account_id,
  host,
  host_id,
  reason,
}: AdminAuthOpts &
  AdminHostIntrusionSnapshotRequest): Promise<AdminHostIntrusionSnapshotResponse> {
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "intrusion-snapshot",
    reason,
    timeout: 120_000,
    run: async (client) => await client.getIntrusionSnapshot(),
  });
}

export async function podman({
  account_id,
  host,
  host_id,
  limit,
  reason,
}: AdminAuthOpts & AdminHostPodmanRequest): Promise<AdminHostPodmanResponse> {
  return await runLiveHostDiagnostic({
    account_id,
    host,
    host_id,
    mode: "podman",
    reason,
    run: async (client) =>
      await client.getPodmanSnapshot({
        limit,
      }),
  });
}

export async function logs({
  account_id,
  host_id,
  source,
  lines,
  grep,
  max_bytes,
  reason,
}: AdminAuthOpts & AdminHostLogsRequest): Promise<AdminHostLogsResponse> {
  const accountId = await requireAdminAccount({ account_id });
  const hostId = `${host_id ?? ""}`.trim();
  if (!isValidUUID(hostId)) {
    throw new Error("--host-id must be a valid project-host id");
  }
  const normalizedLines = normalizePositiveInt({
    value: lines,
    fallback: DEFAULT_LOG_LINES,
    max: MAX_LOG_LINES,
  });
  const maxBytes = normalizePositiveInt({
    value: max_bytes,
    fallback: DEFAULT_MAX_BYTES,
    max: MAX_MAX_BYTES,
  });
  const audit_id = uuid();
  await recordAudit({
    audit_id,
    account_id: accountId,
    mode: "logs",
    host_id: hostId,
    source,
    lines: normalizedLines,
    grep,
    reason,
  });
  const started = Date.now();
  try {
    const client = await getRoutedHostControlClient({
      host_id: hostId,
      timeout: 30_000,
      fresh: true,
    });
    const response = await client.getRuntimeLog({
      lines: normalizedLines,
      source,
    });
    const filtered = filterLogText(response.text, grep);
    const truncated = truncateText({ text: filtered, maxBytes });
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "logs",
      host_id: hostId,
      source: response.source,
      lines: response.lines,
      grep,
      reason,
      duration_ms: Date.now() - started,
      result_bytes: truncated.bytes,
      truncated: truncated.truncated,
    });
    return {
      audit_id,
      host_id: hostId,
      source: response.source,
      requested_source: source,
      server_time: new Date().toISOString(),
      lines: response.lines,
      text: truncated.text,
      result_bytes: truncated.bytes,
      truncated: truncated.truncated,
    };
  } catch (err) {
    await recordAudit({
      audit_id,
      account_id: accountId,
      mode: "logs",
      host_id: hostId,
      source,
      lines: normalizedLines,
      grep,
      reason,
      duration_ms: Date.now() - started,
      error: err,
    });
    throw err;
  }
}
