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
  const lastTime =
    row.last_time instanceof Date
      ? row.last_time.toISOString()
      : `${row.last_time}`;
  return [
    `- ${row.key}`,
    `source=${row.source}`,
    `count=${row.count}`,
    `active/max=${row.max_current}/${row.max_maximum}`,
    `last=${lastTime}`,
  ].join(" ");
}

export async function runServiceAdmissionAlertCheck(): Promise<number> {
  const rows = await getRecentServiceAdmissionDenials();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total < ALERT_MIN_DENIALS) return 0;
  await adminAlert({
    subject: "Service admission denials are high",
    body: [
      `Service admission denied ${total} requests in the last ${ALERT_WINDOW_MINUTES} minutes.`,
      "",
      "This usually means a hub/API admission limit is actively rejecting user-visible work. Top denied methods:",
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
