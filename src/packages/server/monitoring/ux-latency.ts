/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
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

let schemaReady: Promise<void> | undefined;

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
