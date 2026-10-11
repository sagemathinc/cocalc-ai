/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getCachedReadPool } from "@cocalc/database/pool";

export const DEFAULT_ADMIN_ALERT_WINDOW_HOURS = 24;
export const MAX_ADMIN_ALERT_WINDOW_HOURS = 30 * 24;
export const MAX_RECENT_ADMIN_ALERT_DETAILS = 20;

export interface RecentAdminAlert {
  sent_at: string;
  subject: string;
}

export interface RecentAdminAlertSummary {
  count: number;
  alerts: RecentAdminAlert[];
}

export async function getRecentAdminAlertSummary({
  windowHours = DEFAULT_ADMIN_ALERT_WINDOW_HOURS,
  limit = MAX_RECENT_ADMIN_ALERT_DETAILS,
}: {
  windowHours?: number;
  limit?: number;
} = {}): Promise<RecentAdminAlertSummary> {
  const boundedWindowHours = Math.min(
    Math.max(1, Math.round(Number(windowHours) || 0)),
    MAX_ADMIN_ALERT_WINDOW_HOURS,
  );
  const boundedLimit = Math.min(
    Math.max(1, Math.round(Number(limit) || 0)),
    MAX_RECENT_ADMIN_ALERT_DETAILS,
  );
  const { rows } = await getCachedReadPool("medium").query(
    `
    SELECT subject, sent, COUNT(*) OVER()::int AS total_count
      FROM messages
     WHERE COALESCE(system_notice, FALSE) IS TRUE
       AND subject LIKE 'Admin Alert - %'
       AND sent >= NOW() - ($1::double precision * interval '1 hour')
     ORDER BY sent DESC, id DESC
     LIMIT $2
    `,
    [boundedWindowHours, boundedLimit],
  );
  return {
    count: Number(rows[0]?.total_count ?? 0),
    alerts: rows.map((row) => ({
      sent_at: new Date(row.sent).toISOString(),
      subject: `${row.subject}`,
    })),
  };
}
