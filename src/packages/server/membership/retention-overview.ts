/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import LRU from "lru-cache";
import { ensureUxLatencySchema } from "@cocalc/server/monitoring/ux-latency";
import type {
  AdminActiveUsersBucket,
  AdminActiveUsersOverview,
  AdminActiveUsersOverviewQuery,
  AdminActiveUsersPoint,
  AdminRetentionActivitySignal,
  AdminRetentionCohortRow,
  AdminRetentionCohortUnit,
  AdminRetentionOverview,
  AdminRetentionOverviewQuery,
  AdminRetentionPeriodCell,
} from "@cocalc/conat/hub/api/purchases";

const CACHE_TTL_MS = 60_000;
const DEFAULT_DAY_PERIOD_COUNT = 14;
const DEFAULT_WEEK_PERIOD_COUNT = 12;
const DEFAULT_ACTIVE_HOUR_BUCKET_COUNT = 48;
const DEFAULT_ACTIVE_DAY_BUCKET_COUNT = 30;
const DEFAULT_ACTIVE_WEEK_BUCKET_COUNT = 12;
const MAX_DAY_PERIOD_COUNT = 45;
const MAX_WEEK_PERIOD_COUNT = 26;

type NormalizedRetentionQuery = {
  unit: AdminRetentionCohortUnit;
  startDate: Date;
  endDate: Date;
  activity_signal: AdminRetentionActivitySignal;
  period_count: number;
  exclude_banned: boolean;
  opened_project_only: boolean;
};

type NormalizedActiveUsersQuery = {
  bucket: AdminActiveUsersBucket;
  startDate: Date;
  endDate: Date;
  activity_signal: AdminRetentionActivitySignal;
  exclude_banned: boolean;
  opened_project_only: boolean;
};

type RetentionSqlRow = {
  cohort_start: string;
  cohort_end: string;
  cohort_size: number | string;
  period_index: number | string;
  period_start: string;
  period_end: string;
  complete: boolean | string | null;
  active_accounts: number | string;
  rolling_active_accounts: number | string;
};

type ActiveUsersSqlRow = {
  start: string;
  end: string;
  active_accounts: number | string;
};

const overviewCache = new LRU<string, Promise<AdminRetentionOverview>>({
  max: 100,
  ttl: CACHE_TTL_MS,
});

const activeUsersCache = new LRU<string, Promise<AdminActiveUsersOverview>>({
  max: 100,
  ttl: CACHE_TTL_MS,
});

type PeriodConfig = {
  dateTruncUnit: AdminActiveUsersBucket;
  periodInterval: "1 hour" | "1 day" | "1 week";
  periodSeconds: number;
  dateFormat: string;
};

function getPeriodConfig(
  unit: AdminRetentionCohortUnit | AdminActiveUsersBucket,
): PeriodConfig {
  if (unit === "hour") {
    return {
      dateTruncUnit: "hour",
      periodInterval: "1 hour",
      periodSeconds: 60 * 60,
      dateFormat: 'YYYY-MM-DD"T"HH24:MI:SS"Z"',
    };
  }
  if (unit === "week") {
    return {
      dateTruncUnit: "week",
      periodInterval: "1 week",
      periodSeconds: 7 * 24 * 60 * 60,
      dateFormat: "YYYY-MM-DD",
    };
  }
  return {
    dateTruncUnit: "day",
    periodInterval: "1 day",
    periodSeconds: 24 * 60 * 60,
    dateFormat: "YYYY-MM-DD",
  };
}

function floorUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function floorUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
    ),
  );
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addUtcHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setUTCHours(next.getUTCHours() + hours);
  return next;
}

function startOfUtcWeek(date: Date): Date {
  const day = floorUtcDay(date);
  const dayOfWeek = day.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  return addUtcDays(day, mondayOffset);
}

function normalizeDate(value: string | Date | undefined): Date | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalizeUnit(value: unknown): AdminRetentionCohortUnit {
  return value === "week" ? "week" : "day";
}

function normalizeActiveUsersBucket(value: unknown): AdminActiveUsersBucket {
  if (value === "hour" || value === "week") return value;
  return "day";
}

function normalizeActivitySignal(value: unknown): AdminRetentionActivitySignal {
  return value === "managed-cpu" ? "managed-cpu" : "browser-project-activity";
}

function normalizePeriodCount(
  value: unknown,
  unit: AdminRetentionCohortUnit,
): number {
  const max = unit === "week" ? MAX_WEEK_PERIOD_COUNT : MAX_DAY_PERIOD_COUNT;
  const fallback =
    unit === "week" ? DEFAULT_WEEK_PERIOD_COUNT : DEFAULT_DAY_PERIOD_COUNT;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function normalizeRetentionQuery(
  opts: AdminRetentionOverviewQuery = {},
): NormalizedRetentionQuery {
  const unit = normalizeUnit(opts.unit);
  const period_count = normalizePeriodCount(opts.period_count, unit);
  const end =
    normalizeDate(opts.end) ??
    (unit === "week"
      ? addUtcDays(startOfUtcWeek(new Date()), 7)
      : addUtcDays(floorUtcDay(new Date()), 1));
  const defaultSpan = unit === "week" ? 7 * period_count : period_count;
  const start = normalizeDate(opts.start) ?? addUtcDays(end, -defaultSpan);
  if (start >= end) {
    throw Error("start must be before end");
  }
  return {
    unit,
    startDate: start,
    endDate: end,
    activity_signal: normalizeActivitySignal(opts.activity_signal),
    period_count,
    exclude_banned: opts.exclude_banned !== false,
    opened_project_only: opts.opened_project_only === true,
  };
}

function getDefaultActiveUsersWindow(bucket: AdminActiveUsersBucket): {
  start: Date;
  end: Date;
} {
  if (bucket === "hour") {
    const end = addUtcHours(floorUtcHour(new Date()), 1);
    return {
      start: addUtcHours(end, -DEFAULT_ACTIVE_HOUR_BUCKET_COUNT),
      end,
    };
  }
  if (bucket === "week") {
    const end = addUtcDays(startOfUtcWeek(new Date()), 7);
    return {
      start: addUtcDays(end, -7 * DEFAULT_ACTIVE_WEEK_BUCKET_COUNT),
      end,
    };
  }
  const end = addUtcDays(floorUtcDay(new Date()), 1);
  return {
    start: addUtcDays(end, -DEFAULT_ACTIVE_DAY_BUCKET_COUNT),
    end,
  };
}

function normalizeActiveUsersQuery(
  opts: AdminActiveUsersOverviewQuery = {},
): NormalizedActiveUsersQuery {
  const bucket = normalizeActiveUsersBucket(opts.bucket);
  const window = getDefaultActiveUsersWindow(bucket);
  const start = normalizeDate(opts.start) ?? window.start;
  const end = normalizeDate(opts.end) ?? window.end;
  if (start >= end) {
    throw Error("start must be before end");
  }
  return {
    bucket,
    startDate: start,
    endDate: end,
    activity_signal: normalizeActivitySignal(opts.activity_signal),
    exclude_banned: opts.exclude_banned !== false,
    opened_project_only: opts.opened_project_only === true,
  };
}

function cacheKey(query: NormalizedRetentionQuery): string {
  return [
    "retention",
    Math.floor(query.startDate.getTime() / CACHE_TTL_MS),
    Math.floor(query.endDate.getTime() / CACHE_TTL_MS),
    query.unit,
    query.activity_signal,
    query.period_count,
    query.exclude_banned ? "exclude-banned" : "include-banned",
    query.opened_project_only ? "opened" : "all-signups",
  ].join(":");
}

function activeUsersCacheKey(query: NormalizedActiveUsersQuery): string {
  return [
    "active-users",
    Math.floor(query.startDate.getTime() / CACHE_TTL_MS),
    Math.floor(query.endDate.getTime() / CACHE_TTL_MS),
    query.bucket,
    query.activity_signal,
    query.exclude_banned ? "exclude-banned" : "include-banned",
    query.opened_project_only ? "opened" : "all-signups",
  ].join(":");
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "t";
}

function percent(count: number, size: number): number {
  if (size <= 0) return 0;
  return Math.round((1000 * count) / size) / 10;
}

function buildOverview(
  query: NormalizedRetentionQuery,
  rows: RetentionSqlRow[],
): AdminRetentionOverview {
  const byCohort = new Map<string, AdminRetentionCohortRow>();
  for (const row of rows) {
    const cohortStart = row.cohort_start;
    const cohortSize = asNumber(row.cohort_size);
    let cohort = byCohort.get(cohortStart);
    if (cohort == null) {
      cohort = {
        cohort_start: cohortStart,
        cohort_end: row.cohort_end,
        cohort_size: cohortSize,
        periods: [],
      };
      byCohort.set(cohortStart, cohort);
    }
    const activeAccounts = asNumber(row.active_accounts);
    const rollingActiveAccounts = asNumber(row.rolling_active_accounts);
    const cell: AdminRetentionPeriodCell = {
      period_index: asNumber(row.period_index),
      period_start: row.period_start,
      period_end: row.period_end,
      complete: asBoolean(row.complete),
      active_accounts: activeAccounts,
      retention_pct: percent(activeAccounts, cohortSize),
      rolling_active_accounts: rollingActiveAccounts,
      rolling_retention_pct: percent(rollingActiveAccounts, cohortSize),
    };
    cohort.periods.push(cell);
  }
  const cohorts = Array.from(byCohort.values()).map((cohort) => ({
    ...cohort,
    periods: cohort.periods.sort((a, b) => a.period_index - b.period_index),
  }));
  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    unit: query.unit,
    period_count: query.period_count,
    activity_signal: query.activity_signal,
    exclude_banned: query.exclude_banned,
    opened_project_only: query.opened_project_only,
    cohorts,
  };
}

function buildActiveUsersOverview(
  query: NormalizedActiveUsersQuery,
  rows: ActiveUsersSqlRow[],
): AdminActiveUsersOverview {
  const points: AdminActiveUsersPoint[] = rows.map((row) => ({
    start: row.start,
    end: row.end,
    active_accounts: asNumber(row.active_accounts),
  }));
  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    bucket: query.bucket,
    activity_signal: query.activity_signal,
    exclude_banned: query.exclude_banned,
    opened_project_only: query.opened_project_only,
    points,
  };
}

async function getAdminRetentionOverviewUncached(
  query: NormalizedRetentionQuery,
): Promise<AdminRetentionOverview> {
  if (query.activity_signal === "browser-project-activity") {
    await ensureUxLatencySchema();
  }
  const { periodSeconds, periodInterval, dateTruncUnit } = getPeriodConfig(
    query.unit,
  );
  const activityOffsetsSql =
    query.activity_signal === "managed-cpu"
      ? `
        SELECT DISTINCT
          cohort_accounts.account_id,
          cohort_accounts.cohort_start,
          FLOOR(
            EXTRACT(
              EPOCH FROM (
                date_trunc(
                  '${dateTruncUnit}',
                  timezone('UTC', events.sample_ended_at)
                ) - cohort_accounts.cohort_start
              )
            ) / ${periodSeconds}
          )::int AS period_index
        FROM cohort_accounts
        JOIN account_cpu_usage_events AS events
          ON events.account_id = cohort_accounts.account_id
        WHERE events.sample_ended_at >= (cohort_accounts.cohort_start AT TIME ZONE 'UTC')
          AND events.sample_ended_at < (
            cohort_accounts.cohort_start + $5::int * INTERVAL '${periodInterval}'
          ) AT TIME ZONE 'UTC'
          AND events.sample_ended_at >= $1::timestamptz
          AND events.sample_ended_at < $2::timestamptz + $5::int * INTERVAL '${periodInterval}'
      `
      : `
        SELECT DISTINCT
          cohort_accounts.account_id,
          cohort_accounts.cohort_start,
          FLOOR(
            EXTRACT(
              EPOCH FROM (
                date_trunc(
                  '${dateTruncUnit}',
                  timezone('UTC', events.received_at)
                ) - cohort_accounts.cohort_start
              )
            ) / ${periodSeconds}
          )::int AS period_index
        FROM cohort_accounts
        JOIN ux_latency_events AS events
          ON events.account_id = cohort_accounts.account_id
        WHERE events.received_at >= (cohort_accounts.cohort_start AT TIME ZONE 'UTC')
          AND events.received_at < (
            cohort_accounts.cohort_start + $5::int * INTERVAL '${periodInterval}'
          ) AT TIME ZONE 'UTC'
          AND events.received_at >= $1::timestamptz
          AND events.received_at < $2::timestamptz + $5::int * INTERVAL '${periodInterval}'
          AND (
            events.event_type = 'project_ready'
            OR events.event_type = 'file_open'
            OR (
              events.event_type = 'project_start'
              AND events.metric IN (
                'project_start_running',
                'project_start_running_blocked',
                'project_start_running_timeout',
                'project_start_request_failed'
              )
            )
          )
      `;
  const { rows } = await getPool("medium").query<RetentionSqlRow>(
    `
      WITH cohort_accounts AS (
        SELECT
          accounts.account_id,
          date_trunc('${dateTruncUnit}', accounts.created) AS cohort_start
        FROM accounts
        WHERE accounts.created >= ($1::timestamptz AT TIME ZONE 'UTC')
          AND accounts.created < ($2::timestamptz AT TIME ZONE 'UTC')
          AND ($3::boolean = FALSE OR COALESCE(accounts.banned, FALSE) = FALSE)
          AND (
            $4::boolean = FALSE
            OR EXISTS (
              SELECT 1
              FROM account_project_index AS api
              WHERE api.account_id = accounts.account_id
                AND (
                  api.last_opened_at IS NOT NULL
                  OR api.last_activity_at IS NOT NULL
                )
            )
          )
      ),
      cohort_sizes AS (
        SELECT
          cohort_start,
          cohort_start + INTERVAL '${periodInterval}' AS cohort_end,
          COUNT(*)::int AS cohort_size
        FROM cohort_accounts
        GROUP BY cohort_start
      ),
      offsets AS (
        SELECT generate_series(0, $5::int - 1)::int AS period_index
      ),
      raw_active_offsets AS (
        ${activityOffsetsSql}
      ),
      active_offsets AS (
        SELECT *
        FROM raw_active_offsets
        WHERE period_index >= 0
          AND period_index < $5::int
      )
      SELECT
        to_char(cohort_sizes.cohort_start, 'YYYY-MM-DD') AS cohort_start,
        to_char(cohort_sizes.cohort_end, 'YYYY-MM-DD') AS cohort_end,
        cohort_sizes.cohort_size,
        offsets.period_index,
        to_char(
          cohort_sizes.cohort_start + offsets.period_index * INTERVAL '${periodInterval}',
          'YYYY-MM-DD'
        ) AS period_start,
        to_char(
          cohort_sizes.cohort_start + (offsets.period_index + 1) * INTERVAL '${periodInterval}',
          'YYYY-MM-DD'
        ) AS period_end,
        (
          cohort_sizes.cohort_start + offsets.period_index * INTERVAL '${periodInterval}'
        ) < date_trunc('${dateTruncUnit}', timezone('UTC', now())) AS complete,
        COUNT(DISTINCT exact_activity.account_id)::int AS active_accounts,
        COUNT(DISTINCT rolling_activity.account_id)::int AS rolling_active_accounts
      FROM cohort_sizes
      CROSS JOIN offsets
      LEFT JOIN active_offsets AS exact_activity
        ON exact_activity.cohort_start = cohort_sizes.cohort_start
       AND exact_activity.period_index = offsets.period_index
      LEFT JOIN active_offsets AS rolling_activity
        ON rolling_activity.cohort_start = cohort_sizes.cohort_start
       AND rolling_activity.period_index >= offsets.period_index
      GROUP BY
        cohort_sizes.cohort_start,
        cohort_sizes.cohort_end,
        cohort_sizes.cohort_size,
        offsets.period_index
      ORDER BY cohort_sizes.cohort_start ASC, offsets.period_index ASC
    `,
    [
      query.startDate,
      query.endDate,
      query.exclude_banned,
      query.opened_project_only,
      query.period_count,
    ],
  );
  return buildOverview(query, rows);
}

async function getAdminActiveUsersOverviewUncached(
  query: NormalizedActiveUsersQuery,
): Promise<AdminActiveUsersOverview> {
  if (query.activity_signal === "browser-project-activity") {
    await ensureUxLatencySchema();
  }
  const { periodInterval, dateTruncUnit, dateFormat } = getPeriodConfig(
    query.bucket,
  );
  const activityEventsSql =
    query.activity_signal === "managed-cpu"
      ? `
        SELECT
          events.account_id,
          events.sample_ended_at AS occurred_at
        FROM account_cpu_usage_events AS events
        WHERE events.sample_ended_at >= $1::timestamptz
          AND events.sample_ended_at < $2::timestamptz
      `
      : `
        SELECT
          events.account_id,
          events.received_at AS occurred_at
        FROM ux_latency_events AS events
        WHERE events.received_at >= $1::timestamptz
          AND events.received_at < $2::timestamptz
          AND (
            events.event_type = 'project_ready'
            OR events.event_type = 'file_open'
            OR (
              events.event_type = 'project_start'
              AND events.metric IN (
                'project_start_running',
                'project_start_running_blocked',
                'project_start_running_timeout',
                'project_start_request_failed'
              )
            )
          )
      `;
  const { rows } = await getPool("medium").query<ActiveUsersSqlRow>(
    `
      WITH buckets AS (
        SELECT generate_series(
          date_trunc('${dateTruncUnit}', $1::timestamptz AT TIME ZONE 'UTC'),
          date_trunc(
            '${dateTruncUnit}',
            ($2::timestamptz - INTERVAL '1 millisecond') AT TIME ZONE 'UTC'
          ),
          INTERVAL '${periodInterval}'
        ) AS bucket_start
      ),
      activity_events AS (
        ${activityEventsSql}
      ),
      active_accounts AS (
        SELECT DISTINCT
          activity_events.account_id,
          date_trunc(
            '${dateTruncUnit}',
            timezone('UTC', activity_events.occurred_at)
          ) AS bucket_start
        FROM activity_events
        JOIN accounts
          ON accounts.account_id = activity_events.account_id
        WHERE ($3::boolean = FALSE OR COALESCE(accounts.banned, FALSE) = FALSE)
          AND (
            $4::boolean = FALSE
            OR EXISTS (
              SELECT 1
              FROM account_project_index AS api
              WHERE api.account_id = activity_events.account_id
                AND (
                  api.last_opened_at IS NOT NULL
                  OR api.last_activity_at IS NOT NULL
                )
            )
          )
      )
      SELECT
        to_char(buckets.bucket_start, '${dateFormat}') AS start,
        to_char(
          buckets.bucket_start + INTERVAL '${periodInterval}',
          '${dateFormat}'
        ) AS end,
        COUNT(DISTINCT active_accounts.account_id)::int AS active_accounts
      FROM buckets
      LEFT JOIN active_accounts
        ON active_accounts.bucket_start = buckets.bucket_start
      GROUP BY buckets.bucket_start
      ORDER BY buckets.bucket_start ASC
    `,
    [
      query.startDate,
      query.endDate,
      query.exclude_banned,
      query.opened_project_only,
    ],
  );
  return buildActiveUsersOverview(query, rows);
}

export async function getAdminRetentionOverview(
  opts: AdminRetentionOverviewQuery = {},
): Promise<AdminRetentionOverview> {
  const query = normalizeRetentionQuery(opts);
  const key = cacheKey(query);
  const cached = overviewCache.get(key);
  if (cached != null) {
    return await cached;
  }
  const promise = getAdminRetentionOverviewUncached(query).catch((err) => {
    overviewCache.delete(key);
    throw err;
  });
  overviewCache.set(key, promise);
  return await promise;
}

export async function getAdminActiveUsersOverview(
  opts: AdminActiveUsersOverviewQuery = {},
): Promise<AdminActiveUsersOverview> {
  const query = normalizeActiveUsersQuery(opts);
  const key = activeUsersCacheKey(query);
  const cached = activeUsersCache.get(key);
  if (cached != null) {
    return await cached;
  }
  const promise = getAdminActiveUsersOverviewUncached(query).catch((err) => {
    activeUsersCache.delete(key);
    throw err;
  });
  activeUsersCache.set(key, promise);
  return await promise;
}

export function clearAdminRetentionOverviewCacheForTests(): void {
  overviewCache.clear();
  activeUsersCache.clear();
}
