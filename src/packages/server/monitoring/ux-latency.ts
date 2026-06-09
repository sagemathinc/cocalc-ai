/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  UxLatencyEventInput,
  UxLatencyMetricSummary,
  UxLatencyRecentEvent,
  UxLatencySummary,
} from "@cocalc/conat/hub/api/system";
import { v4 as uuid } from "uuid";

const logger = getLogger("server:monitoring:ux-latency");

const TABLE = "ux_latency_events";
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_DETAILS_BYTES = 8192;
const DEFAULT_WINDOW_MINUTES = 24 * 60;
const MAX_WINDOW_MINUTES = 30 * 24 * 60;
const ALERT_WINDOW_MINUTES = 15;
const ALERT_INTERVAL_MS = 5 * 60 * 1000;
const ALERT_INITIAL_DELAY_MS = 60 * 1000;

let schemaReady: Promise<void> | undefined;
let alertMaintenanceStarted = false;

export async function ensureUxLatencySchema(): Promise<void> {
  schemaReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id UUID PRIMARY KEY,
        event_type TEXT NOT NULL,
        metric TEXT NOT NULL,
        account_id UUID,
        project_id UUID,
        host_id UUID,
        bay_id TEXT NOT NULL,
        client_event_id TEXT,
        duration_ms INTEGER NOT NULL,
        started_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1,
        path_ext TEXT,
        editor TEXT,
        segment TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_received_idx
         ON ${TABLE} (received_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_metric_received_idx
         ON ${TABLE} (metric, received_at DESC)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_project_received_idx
         ON ${TABLE} (project_id, received_at DESC)`,
    );
  })();
  return schemaReady;
}

function cleanText(value: unknown, max = 160): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function cleanUuid(value: unknown): string | undefined {
  const text = cleanText(value, 80);
  return text && /^[0-9a-f-]{36}$/i.test(text) ? text : undefined;
}

function cleanDuration(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0) {
    throw Error("duration_ms must be a nonnegative number");
  }
  return Math.min(n, MAX_DURATION_MS);
}

function cleanSampleRate(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(1, n);
}

function cleanDetails(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_DETAILS_BYTES) {
      return { truncated: true };
    }
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function recordUxLatencyEvent({
  account_id,
  event,
}: {
  account_id?: string;
  event: UxLatencyEventInput;
}): Promise<void> {
  const metric = cleanText(event?.metric, 80);
  const eventType = cleanText(event?.event_type, 80);
  if (!metric || !eventType) {
    throw Error("event_type and metric must be specified");
  }
  await ensureUxLatencySchema();
  const details = cleanDetails(event.details);
  await getPool().query(
    `
    INSERT INTO ${TABLE}
      (id, event_type, metric, account_id, project_id, host_id, bay_id,
       client_event_id, duration_ms, started_at, sample_rate, path_ext,
       editor, segment, details)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10::TIMESTAMPTZ, $11, $12, $13, $14, $15::jsonb)
    `,
    [
      uuid(),
      eventType,
      metric,
      cleanUuid(account_id),
      cleanUuid(event.project_id),
      cleanUuid(event.host_id),
      cleanText(event.bay_id, 80) ?? getConfiguredBayId(),
      cleanText(event.client_event_id, 120),
      cleanDuration(event.duration_ms),
      cleanText(event.started_at, 80) ?? null,
      cleanSampleRate(event.sample_rate),
      cleanText(event.path_ext, 40),
      cleanText(event.editor, 80),
      cleanText(event.segment, 120),
      JSON.stringify(details),
    ],
  );
}

function boundedWindowMinutes(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, n);
}

function metricSummaryFromRow(row: any): UxLatencyMetricSummary {
  return {
    metric: `${row.metric}`,
    event_type: `${row.event_type}`,
    segment: row.segment ?? undefined,
    count: Number(row.count) || 0,
    avg_ms: Math.round(Number(row.avg_ms) || 0),
    p50_ms: Math.round(Number(row.p50_ms) || 0),
    p95_ms: Math.round(Number(row.p95_ms) || 0),
    p99_ms: Math.round(Number(row.p99_ms) || 0),
    max_ms: Math.round(Number(row.max_ms) || 0),
  };
}

export async function getUxLatencySummary({
  window_minutes,
}: {
  window_minutes?: number;
} = {}): Promise<UxLatencySummary> {
  await ensureUxLatencySchema();
  const windowMinutes = boundedWindowMinutes(window_minutes);
  const since = new Date(Date.now() - windowMinutes * 60_000);
  const [metricRows, segmentRows, recentRows] = await Promise.all([
    getPool().query(
      `
      SELECT metric, event_type, NULL::TEXT AS segment,
             COUNT(*)::INT AS count,
             AVG(duration_ms)::DOUBLE PRECISION AS avg_ms,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p95_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p99_ms,
             MAX(duration_ms)::INT AS max_ms
        FROM ${TABLE}
       WHERE received_at >= $1
       GROUP BY metric, event_type
       ORDER BY metric
      `,
      [since],
    ),
    getPool().query(
      `
      SELECT metric, event_type, segment,
             COUNT(*)::INT AS count,
             AVG(duration_ms)::DOUBLE PRECISION AS avg_ms,
             percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p50_ms,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p95_ms,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)::DOUBLE PRECISION AS p99_ms,
             MAX(duration_ms)::INT AS max_ms
        FROM ${TABLE}
       WHERE received_at >= $1
         AND segment IS NOT NULL
       GROUP BY metric, event_type, segment
       ORDER BY metric, segment
      `,
      [since],
    ),
    getPool().query(
      `
      SELECT received_at, event_type, metric, segment, duration_ms, project_id,
             host_id, path_ext, editor, details
        FROM ${TABLE}
       WHERE received_at >= $1
       ORDER BY duration_ms DESC, received_at DESC
       LIMIT 25
      `,
      [since],
    ),
  ]);
  return {
    checked_at: new Date().toISOString(),
    window_minutes: windowMinutes,
    since: since.toISOString(),
    metrics: metricRows.rows.map(metricSummaryFromRow),
    segments: segmentRows.rows.map(metricSummaryFromRow),
    recent_slow_events: recentRows.rows.map(
      (row): UxLatencyRecentEvent => ({
        received_at: row.received_at?.toISOString?.() ?? `${row.received_at}`,
        event_type: row.event_type,
        metric: row.metric,
        segment: row.segment ?? undefined,
        duration_ms: Number(row.duration_ms) || 0,
        project_id: row.project_id ?? undefined,
        host_id: row.host_id ?? undefined,
        path_ext: row.path_ext ?? undefined,
        editor: row.editor ?? undefined,
        details: row.details ?? {},
      }),
    ),
  };
}

export function recordUxLatencyEventBestEffort(opts: {
  account_id?: string;
  event: UxLatencyEventInput;
}): void {
  recordUxLatencyEvent(opts).catch((err) => {
    logger.debug("failed to record ux latency event", { err: `${err}` });
  });
}

type UxLatencyAlertCandidate = {
  subject: string;
  body: string;
};

function rowByMetric(
  rows: UxLatencyMetricSummary[],
  metric: string,
): UxLatencyMetricSummary | undefined {
  return rows.find((row) => row.metric === metric);
}

function rowByMetricAndSegment(
  rows: UxLatencyMetricSummary[],
  metric: string,
  segment: string,
): UxLatencyMetricSummary | undefined {
  return rows.find((row) => row.metric === metric && row.segment === segment);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function latencyBody(row: UxLatencyMetricSummary, expectation: string): string {
  return [
    expectation,
    "",
    `Metric: ${row.metric}`,
    row.segment ? `Segment: ${row.segment}` : undefined,
    `Samples: ${row.count}`,
    `P50: ${formatMs(row.p50_ms)}`,
    `P95: ${formatMs(row.p95_ms)}`,
    `P99: ${formatMs(row.p99_ms)}`,
    `Max: ${formatMs(row.max_ms)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function alertCandidates(summary: UxLatencySummary): UxLatencyAlertCandidate[] {
  const alerts: UxLatencyAlertCandidate[] = [];
  const warmStart = rowByMetricAndSegment(
    summary.segments,
    "project_start_running",
    "warm_provisioned",
  );
  if (warmStart && warmStart.count >= 5 && warmStart.p95_ms > 2000) {
    alerts.push({
      subject: "warm project starts are slow",
      body: latencyBody(
        warmStart,
        "Warm provisioned project starts should usually be under 1 second.",
      ),
    });
  }

  const allStarts = rowByMetric(summary.metrics, "project_start_running");
  if (allStarts && allStarts.count >= 5 && allStarts.p95_ms > 10_000) {
    alerts.push({
      subject: "project starts are slow",
      body: latencyBody(
        allStarts,
        "Overall project start latency is high. Restore/dearchive paths may be expected outliers; check segment rows before treating this as a warm-start regression.",
      ),
    });
  }

  const startTimeouts = rowByMetric(
    summary.metrics,
    "project_start_running_timeout",
  );
  if (startTimeouts && startTimeouts.count >= 1) {
    alerts.push({
      subject: "project starts timed out",
      body: latencyBody(
        startTimeouts,
        "At least one project start did not reach browser-observed running state within the monitoring deadline.",
      ),
    });
  }

  const visible = rowByMetric(summary.metrics, "file_open_visible");
  if (visible && visible.count >= 10 && visible.p95_ms > 3000) {
    alerts.push({
      subject: "file open visible latency is high",
      body: latencyBody(
        visible,
        "Users are waiting too long before file contents are visible.",
      ),
    });
  }

  const syncReady = rowByMetric(summary.metrics, "file_open_sync_ready");
  if (syncReady && syncReady.count >= 10 && syncReady.p95_ms > 8000) {
    alerts.push({
      subject: "file open sync-ready latency is high",
      body: latencyBody(
        syncReady,
        "Users can see files, but realtime sync is taking too long to become ready.",
      ),
    });
  }

  return alerts;
}

export async function runUxLatencyAlertCheck(): Promise<number> {
  const summary = await getUxLatencySummary({
    window_minutes: ALERT_WINDOW_MINUTES,
  });
  const alerts = alertCandidates(summary);
  for (const alert of alerts) {
    await adminAlert({
      subject: `UX latency: ${alert.subject}`,
      body: `${alert.body}\n\nWindow: ${summary.window_minutes} minutes\nChecked: ${summary.checked_at}`,
      dedupMinutes: 60,
    });
  }
  return alerts.length;
}

export function startUxLatencyAlertMaintenance({
  interval_ms = ALERT_INTERVAL_MS,
  initial_delay_ms = ALERT_INITIAL_DELAY_MS,
}: {
  interval_ms?: number;
  initial_delay_ms?: number;
} = {}): void {
  if (alertMaintenanceStarted) return;
  if (`${process.env.COCALC_UX_LATENCY_ALERTS ?? "true"}` === "false") {
    logger.info("ux latency alert maintenance disabled");
    return;
  }
  alertMaintenanceStarted = true;
  const run = async () => {
    try {
      const count = await runUxLatencyAlertCheck();
      if (count) {
        logger.warn("ux latency alerts sent", { count });
      }
    } catch (err) {
      logger.warn("ux latency alert check failed", { err: `${err}` });
    }
  };
  const initial = setTimeout(() => void run(), initial_delay_ms);
  initial.unref?.();
  const timer = setInterval(() => void run(), interval_ms);
  timer.unref?.();
  logger.info("ux latency alert maintenance started", {
    interval_ms,
    initial_delay_ms,
  });
}
