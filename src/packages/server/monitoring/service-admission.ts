/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import adminAlert from "@cocalc/server/messages/admin-alert";

const logger = getLogger("server:monitoring:service-admission");

const ALERT_WINDOW_MINUTES = 10;
const ALERT_INTERVAL_MS = 5 * 60_000;
const ALERT_INITIAL_DELAY_MS = 60_000;
const ALERT_MIN_DENIALS = 100;
const TOP_KEYS = 8;

let alertMaintenanceStarted = false;

type ServiceAdmissionDenialRow = {
  source: string;
  key: string;
  count: number;
  first_time: Date | string;
  last_time: Date | string;
  max_current: number;
  max_maximum: number;
};

async function getRecentServiceAdmissionDenials(): Promise<
  ServiceAdmissionDenialRow[]
> {
  const { rows } = await getPool().query<ServiceAdmissionDenialRow>(
    `
      SELECT
        COALESCE(NULLIF(value->>'source', ''), 'unknown') AS source,
        COALESCE(NULLIF(value->>'key', ''), 'unknown') AS key,
        COUNT(*)::int AS count,
        MIN("time") AS first_time,
        MAX("time") AS last_time,
        MAX(
          CASE
            WHEN (value->>'current') ~ '^[0-9]+$'
            THEN (value->>'current')::int
            ELSE 0
          END
        )::int AS max_current,
        MAX(
          CASE
            WHEN (value->>'maximum') ~ '^[0-9]+$'
            THEN (value->>'maximum')::int
            ELSE 0
          END
        )::int AS max_maximum
      FROM central_log
      WHERE event = 'service_admission_denied'
        AND "time" >= NOW() - ($1::int * INTERVAL '1 minute')
      GROUP BY source, key
      ORDER BY count DESC, last_time DESC
      LIMIT $2
    `,
    [ALERT_WINDOW_MINUTES, TOP_KEYS],
  );
  return rows;
}

function formatRow(row: ServiceAdmissionDenialRow): string {
  const firstMs = timeMs(row.first_time);
  const lastMs = timeMs(row.last_time);
  const lastTime =
    row.last_time instanceof Date
      ? row.last_time.toISOString()
      : `${row.last_time}`;
  return [
    `- ${row.key}`,
    `source=${row.source}`,
    `count=${row.count}`,
    `active/max=${row.max_current}/${row.max_maximum}`,
    firstMs != null && lastMs != null
      ? `span=${formatDuration(Math.max(0, lastMs - firstMs))}`
      : undefined,
    `last=${lastTime}`,
  ]
    .filter((part) => part != null)
    .join(" ");
}

function timeMs(value: Date | string): number | undefined {
  const ms = value instanceof Date ? value.getTime() : Date.parse(`${value}`);
  return Number.isFinite(ms) ? ms : undefined;
}

function formatIso(value: number | undefined): string | undefined {
  return value == null ? undefined : new Date(value).toISOString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function observedSpan(rows: ServiceAdmissionDenialRow[]): {
  first?: number;
  last?: number;
  spanMs?: number;
} {
  const times = rows.flatMap((row) =>
    [timeMs(row.first_time), timeMs(row.last_time)].filter(
      (value): value is number => value != null,
    ),
  );
  if (!times.length) {
    return {};
  }
  const first = Math.min(...times);
  const last = Math.max(...times);
  return { first, last, spanMs: Math.max(0, last - first) };
}

export async function runServiceAdmissionAlertCheck(): Promise<number> {
  const rows = await getRecentServiceAdmissionDenials();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total < ALERT_MIN_DENIALS) return 0;
  const span = observedSpan(rows);
  const spanSummary =
    span.spanMs != null
      ? `Observed denial span across top groups: ${formatDuration(span.spanMs)} (${formatIso(span.first)} to ${formatIso(span.last)}).`
      : "Observed denial span across top groups: unavailable.";
  await adminAlert({
    subject: "Service admission denials are high",
    body: [
      `Service admission denied ${total} requests in the last ${ALERT_WINDOW_MINUTES} minutes.`,
      "",
      spanSummary,
      "",
      "A short span usually indicates a burst or retry fan-out; sustained or repeated bursts still need investigation.",
      "",
      "Top denied methods/services:",
      "",
      ...rows.map(formatRow),
    ].join("\n"),
    dedupMinutes: 60,
  });
  return total;
}

export function startServiceAdmissionAlertMaintenance({
  interval_ms = ALERT_INTERVAL_MS,
  initial_delay_ms = ALERT_INITIAL_DELAY_MS,
}: {
  interval_ms?: number;
  initial_delay_ms?: number;
} = {}): void {
  if (alertMaintenanceStarted) return;
  if (`${process.env.COCALC_SERVICE_ADMISSION_ALERTS ?? "true"}` === "false") {
    logger.info("service admission alert maintenance disabled");
    return;
  }
  alertMaintenanceStarted = true;
  const run = async () => {
    try {
      const count = await runServiceAdmissionAlertCheck();
      if (count) {
        logger.warn("service admission alert sent", { count });
      }
    } catch (err) {
      logger.warn("service admission alert check failed", { err: `${err}` });
    }
  };
  const initial = setTimeout(() => void run(), initial_delay_ms);
  initial.unref?.();
  const timer = setInterval(() => void run(), interval_ms);
  timer.unref?.();
  logger.info("service admission alert maintenance started", {
    interval_ms,
    initial_delay_ms,
  });
}
