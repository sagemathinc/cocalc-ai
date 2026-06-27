/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import getAdmins from "@cocalc/server/accounts/admins";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { ADMIN_UX_LATENCY_ALERTS_ENABLED_KEY } from "@cocalc/util/admin-alerts";
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
const DEFAULT_LATENCY_ALERT_MIN_SAMPLES = 25;
const FILE_OPEN_LATENCY_ALERT_MIN_SAMPLES = 50;
const PROJECT_START_LATENCY_ALERT_MIN_SAMPLES = 10;
const LATENCY_ALERT_MIN_SLOW_SAMPLES = 3;
const EXPLICIT_FAILURE_ALERT_MIN_SAMPLES = 2;

export type UxLatencySlaThresholds = {
  project_start_warm_p95_ms: number;
  project_start_overall_p95_ms: number;
  project_terminal_ready_p95_ms: number;
  project_jupyter_ready_p95_ms: number;
  project_exec_ready_p95_ms: number;
  file_open_visible_p95_ms: number;
  file_open_sync_ready_p95_ms: number;
};

export const DEFAULT_UX_LATENCY_SLA_THRESHOLDS: UxLatencySlaThresholds = {
  project_start_warm_p95_ms: 10_000,
  project_start_overall_p95_ms: 5000,
  project_terminal_ready_p95_ms: 5000,
  project_jupyter_ready_p95_ms: 10_000,
  project_exec_ready_p95_ms: 500,
  file_open_visible_p95_ms: 10_000,
  file_open_sync_ready_p95_ms: 5000,
};

let schemaReady: Promise<void> | undefined;
let alertMaintenanceStarted = false;

function positiveIntegerSetting(
  settings: Record<string, any> | undefined,
  key: string,
  fallback: number,
): number {
  const value = Number.parseInt(`${settings?.[key] ?? ""}`.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getUxLatencySlaThresholdsFromSettings(
  settings: Record<string, any> | undefined,
): UxLatencySlaThresholds {
  return {
    project_start_warm_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_project_start_warm_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.project_start_warm_p95_ms,
    ),
    project_start_overall_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_project_start_overall_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.project_start_overall_p95_ms,
    ),
    project_terminal_ready_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_project_terminal_ready_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.project_terminal_ready_p95_ms,
    ),
    project_jupyter_ready_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_project_jupyter_ready_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.project_jupyter_ready_p95_ms,
    ),
    project_exec_ready_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_project_exec_ready_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.project_exec_ready_p95_ms,
    ),
    file_open_visible_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_file_open_visible_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.file_open_visible_p95_ms,
    ),
    file_open_sync_ready_p95_ms: positiveIntegerSetting(
      settings,
      "launch_sla_file_open_sync_ready_p95_ms",
      DEFAULT_UX_LATENCY_SLA_THRESHOLDS.file_open_sync_ready_p95_ms,
    ),
  };
}

export async function getUxLatencySlaThresholds(): Promise<UxLatencySlaThresholds> {
  return getUxLatencySlaThresholdsFromSettings(await getServerSettings());
}

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
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_account_received_idx
         ON ${TABLE} (account_id, received_at DESC)`,
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
      SELECT e.received_at, e.started_at, e.event_type, e.metric, e.segment,
             e.duration_ms, e.account_id, e.project_id, p.title AS project_title,
             e.host_id, e.bay_id, e.client_event_id, e.path_ext, e.editor,
             e.details
        FROM ${TABLE} e
        LEFT JOIN projects p ON p.project_id = e.project_id
       WHERE e.received_at >= $1
       ORDER BY e.duration_ms DESC, e.received_at DESC
       LIMIT 100
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
        started_at:
          row.started_at == null
            ? undefined
            : (row.started_at?.toISOString?.() ?? `${row.started_at}`),
        event_type: row.event_type,
        metric: row.metric,
        segment: row.segment ?? undefined,
        duration_ms: Number(row.duration_ms) || 0,
        account_id: row.account_id ?? undefined,
        project_id: row.project_id ?? undefined,
        project_title: row.project_title ?? undefined,
        host_id: row.host_id ?? undefined,
        bay_id: row.bay_id ?? undefined,
        client_event_id: row.client_event_id ?? undefined,
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

function latencyBody(
  row: UxLatencyMetricSummary,
  expectation: string,
  thresholdMs: number,
  slowSamples?: number,
): string {
  return [
    expectation,
    "",
    `Metric: ${row.metric}`,
    row.segment ? `Segment: ${row.segment}` : undefined,
    `Configured SLA P95: ${formatMs(thresholdMs)}`,
    `Samples: ${row.count}`,
    slowSamples == null
      ? undefined
      : `Samples over SLA among recent slow events: ${slowSamples}`,
    `P50: ${formatMs(row.p50_ms)}`,
    `P95: ${formatMs(row.p95_ms)}`,
    `P99: ${formatMs(row.p99_ms)}`,
    `Max: ${formatMs(row.max_ms)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function compactText(value: unknown, max = 96): string | undefined {
  const text = `${value ?? ""}`.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function eventDetailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return compactText(details?.[key]);
}

function formatAlertSample(event: UxLatencyRecentEvent): string {
  const host =
    compactText(event.host_id) ?? eventDetailString(event.details, "host_id");
  const opId = eventDetailString(event.details, "op_id");
  const observed = eventDetailString(event.details, "observed_state");
  const initial = eventDetailString(event.details, "initial_state");
  const fields = [
    `duration=${formatMs(event.duration_ms)}`,
    `received=${event.received_at}`,
    event.segment ? `segment=${event.segment}` : undefined,
    event.account_id ? `account=${event.account_id}` : undefined,
    event.project_id ? `project=${event.project_id}` : undefined,
    event.project_title
      ? `title=${compactText(event.project_title)}`
      : undefined,
    host ? `host=${host}` : undefined,
    opId ? `op=${opId}` : undefined,
    initial || observed
      ? `state=${initial ?? "?"}->${observed ?? "?"}`
      : undefined,
  ];
  return `- ${fields.filter(Boolean).join(" ")}`;
}

function recentSamplesBody({
  summary,
  metric,
  segment,
  limit = 8,
}: {
  summary: UxLatencySummary;
  metric: string;
  segment?: string;
  limit?: number;
}): string {
  const events = summary.recent_slow_events
    .filter((event) => {
      if (event.metric !== metric) return false;
      if (segment != null && event.segment !== segment) return false;
      return true;
    })
    .slice(0, limit);
  if (events.length === 0) {
    return "\n\nRecent samples: none retained in the slow-event sample window.";
  }
  return `\n\nRecent samples:\n${events.map(formatAlertSample).join("\n")}`;
}

function actionableLatencyBody({
  summary,
  row,
  expectation,
  thresholdMs,
  slowSamples,
}: {
  summary: UxLatencySummary;
  row: UxLatencyMetricSummary;
  expectation: string;
  thresholdMs: number;
  slowSamples?: number;
}): string {
  return (
    latencyBody(row, expectation, thresholdMs, slowSamples) +
    recentSamplesBody({
      summary,
      metric: row.metric,
      segment: row.segment,
    })
  );
}

function recentSlowSampleCount({
  summary,
  row,
  thresholdMs,
}: {
  summary: UxLatencySummary;
  row: UxLatencyMetricSummary;
  thresholdMs: number;
}): number {
  return summary.recent_slow_events.filter((event) => {
    if (event.metric !== row.metric) return false;
    if (row.segment != null && event.segment !== row.segment) return false;
    return event.duration_ms > thresholdMs;
  }).length;
}

function shouldAlertOnLatencySla({
  summary,
  row,
  thresholdMs,
  minSamples = DEFAULT_LATENCY_ALERT_MIN_SAMPLES,
  minSlowSamples = LATENCY_ALERT_MIN_SLOW_SAMPLES,
}: {
  summary: UxLatencySummary;
  row: UxLatencyMetricSummary | undefined;
  thresholdMs: number;
  minSamples?: number;
  minSlowSamples?: number;
}): { alert: boolean; slowSamples: number } {
  if (!row || row.count < minSamples || row.p95_ms <= thresholdMs) {
    return { alert: false, slowSamples: 0 };
  }
  const slowSamples = recentSlowSampleCount({ summary, row, thresholdMs });
  return {
    alert: slowSamples >= minSlowSamples,
    slowSamples,
  };
}

function alertCandidates(
  summary: UxLatencySummary,
  sla: UxLatencySlaThresholds,
): UxLatencyAlertCandidate[] {
  const alerts: UxLatencyAlertCandidate[] = [];
  const warmStart = rowByMetricAndSegment(
    summary.segments,
    "project_start_running",
    "warm_provisioned",
  );
  const warmStartAlert = shouldAlertOnLatencySla({
    summary,
    row: warmStart,
    thresholdMs: sla.project_start_warm_p95_ms,
    minSamples: PROJECT_START_LATENCY_ALERT_MIN_SAMPLES,
  });
  if (warmStartAlert.alert && warmStart) {
    alerts.push({
      subject: "warm project starts are slow",
      body: actionableLatencyBody({
        summary,
        row: warmStart,
        expectation:
          "Warm provisioned project starts violated the configured P95 SLA.",
        thresholdMs: sla.project_start_warm_p95_ms,
        slowSamples: warmStartAlert.slowSamples,
      }),
    });
  }

  const allStarts = rowByMetric(summary.metrics, "project_start_running");
  const allStartsAlert = shouldAlertOnLatencySla({
    summary,
    row: allStarts,
    thresholdMs: sla.project_start_overall_p95_ms,
    minSamples: PROJECT_START_LATENCY_ALERT_MIN_SAMPLES,
  });
  if (allStartsAlert.alert && allStarts) {
    alerts.push({
      subject: "project starts are slow",
      body: actionableLatencyBody({
        summary,
        row: allStarts,
        expectation:
          "Overall project start latency violated the configured P95 SLA. Restore/dearchive paths may be expected outliers; check segment rows before treating this as a warm-start regression.",
        thresholdMs: sla.project_start_overall_p95_ms,
        slowSamples: allStartsAlert.slowSamples,
      }),
    });
  }

  const stuckStarts = rowByMetric(
    summary.metrics,
    "project_start_running_stuck",
  );
  if (stuckStarts && stuckStarts.count >= EXPLICIT_FAILURE_ALERT_MIN_SAMPLES) {
    alerts.push({
      subject: "project start appears stuck",
      body: actionableLatencyBody({
        summary,
        row: stuckStarts,
        expectation:
          "At least one browser-observed project start was still not running after the user-visible stuck threshold.",
        thresholdMs: sla.project_start_overall_p95_ms,
      }),
    });
  }

  const startTimeouts = rowByMetric(
    summary.metrics,
    "project_start_running_timeout",
  );
  if (
    startTimeouts &&
    startTimeouts.count >= EXPLICIT_FAILURE_ALERT_MIN_SAMPLES
  ) {
    alerts.push({
      subject: "project starts timed out",
      body: actionableLatencyBody({
        summary,
        row: startTimeouts,
        expectation:
          "At least one project start did not reach browser-observed running state within the monitoring deadline.",
        thresholdMs: sla.project_start_overall_p95_ms,
      }),
    });
  }

  const visible = rowByMetric(summary.metrics, "file_open_visible");
  const visibleAlert = shouldAlertOnLatencySla({
    summary,
    row: visible,
    thresholdMs: sla.file_open_visible_p95_ms,
    minSamples: FILE_OPEN_LATENCY_ALERT_MIN_SAMPLES,
  });
  if (visibleAlert.alert && visible) {
    alerts.push({
      subject: "file open visible latency is high",
      body: actionableLatencyBody({
        summary,
        row: visible,
        expectation:
          "File-open visible latency violated the configured P95 SLA.",
        thresholdMs: sla.file_open_visible_p95_ms,
        slowSamples: visibleAlert.slowSamples,
      }),
    });
  }

  const syncReady = rowByMetric(summary.metrics, "file_open_sync_ready");
  const syncReadyAlert = shouldAlertOnLatencySla({
    summary,
    row: syncReady,
    thresholdMs: sla.file_open_sync_ready_p95_ms,
    minSamples: FILE_OPEN_LATENCY_ALERT_MIN_SAMPLES,
  });
  if (syncReadyAlert.alert && syncReady) {
    alerts.push({
      subject: "file open sync-ready latency is high",
      body: actionableLatencyBody({
        summary,
        row: syncReady,
        expectation:
          "File-open sync-ready latency violated the configured P95 SLA.",
        thresholdMs: sla.file_open_sync_ready_p95_ms,
        slowSamples: syncReadyAlert.slowSamples,
      }),
    });
  }

  const terminalReady = rowByMetric(summary.metrics, "project_terminal_ready");
  const terminalReadyAlert = shouldAlertOnLatencySla({
    summary,
    row: terminalReady,
    thresholdMs: sla.project_terminal_ready_p95_ms,
  });
  if (terminalReadyAlert.alert && terminalReady) {
    alerts.push({
      subject: "terminal ready latency is high",
      body: actionableLatencyBody({
        summary,
        row: terminalReady,
        expectation: "Terminal readiness violated the configured P95 SLA.",
        thresholdMs: sla.project_terminal_ready_p95_ms,
        slowSamples: terminalReadyAlert.slowSamples,
      }),
    });
  }

  const jupyterReady = rowByMetric(summary.metrics, "project_jupyter_ready");
  const jupyterReadyAlert = shouldAlertOnLatencySla({
    summary,
    row: jupyterReady,
    thresholdMs: sla.project_jupyter_ready_p95_ms,
  });
  if (jupyterReadyAlert.alert && jupyterReady) {
    alerts.push({
      subject: "Jupyter ready latency is high",
      body: actionableLatencyBody({
        summary,
        row: jupyterReady,
        expectation: "Jupyter readiness violated the configured P95 SLA.",
        thresholdMs: sla.project_jupyter_ready_p95_ms,
        slowSamples: jupyterReadyAlert.slowSamples,
      }),
    });
  }

  const execReady = rowByMetric(summary.metrics, "project_exec_ready");
  const execReadyAlert = shouldAlertOnLatencySla({
    summary,
    row: execReady,
    thresholdMs: sla.project_exec_ready_p95_ms,
  });
  if (execReadyAlert.alert && execReady) {
    alerts.push({
      subject: "project exec ready latency is high",
      body: actionableLatencyBody({
        summary,
        row: execReady,
        expectation: "Project exec readiness violated the configured P95 SLA.",
        thresholdMs: sla.project_exec_ready_p95_ms,
        slowSamples: execReadyAlert.slowSamples,
      }),
    });
  }

  return alerts;
}

async function getUxLatencyAlertRecipients(): Promise<string[]> {
  const admins = await getAdmins();
  if (admins.length === 0) return [];
  const { rows } = await getPool().query<{ account_id: string }>(
    `
    SELECT account_id
      FROM accounts
     WHERE account_id = ANY($1)
       AND COALESCE(other_settings->>$2, 'true') <> 'false'
    `,
    [admins, ADMIN_UX_LATENCY_ALERTS_ENABLED_KEY],
  );
  return rows.map(({ account_id }) => account_id);
}

export async function runUxLatencyAlertCheck(): Promise<number> {
  const [summary, sla] = await Promise.all([
    getUxLatencySummary({
      window_minutes: ALERT_WINDOW_MINUTES,
    }),
    getUxLatencySlaThresholds(),
  ]);
  const alerts = alertCandidates(summary, sla);
  if (alerts.length === 0) return 0;
  const to_ids = await getUxLatencyAlertRecipients();
  if (to_ids.length === 0) {
    logger.debug("no admins opted into ux latency alerts");
    return 0;
  }
  for (const alert of alerts) {
    await adminAlert({
      subject: `UX latency: ${alert.subject}`,
      body: `${alert.body}\n\nWindow: ${summary.window_minutes} minutes\nChecked: ${summary.checked_at}`,
      dedupMinutes: 60,
      to_ids,
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
