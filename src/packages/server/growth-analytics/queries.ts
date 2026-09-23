/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  GROWTH_METRIC_VERSION,
  type GrowthActivitySignal,
  type GrowthDataHealth,
  type GrowthFunnel,
  type GrowthFunnelStep,
  type GrowthMetricSeries,
  type GrowthRangeQuery,
  type GrowthRetentionMatrix,
  type GrowthSummary,
  type GrowthWeeklyAccounting,
} from "@cocalc/conat/hub/api/growth-analytics";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const MAX_RANGE_DAYS = 730;
const DEFAULT_RANGE_DAYS = 90;
const SIGNALS = new Set<GrowthActivitySignal>([
  "project_engaged_v1",
  "project_work_v1",
  "app_foreground_v1",
  "ai_engaged_v1",
  "self_directed_work_v1",
]);

type Range = {
  start: Date;
  end: Date;
  activity_signal: GrowthActivitySignal;
};

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function normalizeRange(opts: GrowthRangeQuery = {}): Range {
  const now = new Date();
  const end = opts.end
    ? new Date(opts.end)
    : new Date(utcDay(now).getTime() + 86400000);
  const start = opts.start
    ? new Date(opts.start)
    : new Date(end.getTime() - DEFAULT_RANGE_DAYS * 86400000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw Error("invalid growth analytics date range");
  }
  if (start >= end) throw Error("start must be before end");
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86400000) {
    throw Error(`growth analytics range is limited to ${MAX_RANGE_DAYS} days`);
  }
  const activitySignal = SIGNALS.has(
    opts.activity_signal as GrowthActivitySignal,
  )
    ? (opts.activity_signal as GrowthActivitySignal)
    : "project_engaged_v1";
  return { start, end, activity_signal: activitySignal };
}

function number(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function percent(numerator: number, denominator: number): number | null {
  return denominator > 0
    ? Math.round((1000 * numerator) / denominator) / 10
    : null;
}

const METRIC_LABELS: Record<string, string> = {
  eligible_signups: "Eligible signups",
  verified_accounts: "Verified accounts",
  activated_24h: "First recorded work within 24h",
  project_created: "Created a project",
  project_surface_visible: "Saw a usable project surface",
  first_meaningful_work: "Recorded first work",
  project_engaged_v1: "Project-engaged active users",
  project_work_v1: "Recorded work active users",
  app_foreground_v1: "Foreground app users",
  ai_engaged_v1: "AI-engaged users",
  self_directed_work_v1: "Self-directed work users",
};

function metricLabel(metricName: string): string {
  return METRIC_LABELS[metricName] ?? metricName;
}

async function readSeries({
  metricNames,
  range,
}: {
  metricNames: string[];
  range: Range;
}): Promise<GrowthMetricSeries[]> {
  const { rows } = await getPool("medium").query<{
    metric_name: string;
    period_start: string;
    value: string | number | null;
    numerator: string | number | null;
    denominator: string | number | null;
    partial: boolean;
  }>(
    `SELECT metric_name, period_start::text, value, numerator, denominator, partial
       FROM growth_metric_series
      WHERE scope_id=$1 AND metric_version=$2 AND period_grain='day'
        AND segment_set='overall' AND segment_value='all'
        AND metric_name=ANY($3::text[])
        AND period_start >= $4::date AND period_start < $5::date
      ORDER BY metric_name, period_start`,
    [
      getConfiguredBayId(),
      GROWTH_METRIC_VERSION,
      metricNames,
      range.start,
      range.end,
    ],
  );
  const byMetric = new Map<string, GrowthMetricSeries>();
  for (const metricName of metricNames) {
    byMetric.set(metricName, {
      metric_name: metricName,
      metric_version: GROWTH_METRIC_VERSION,
      label: metricLabel(metricName),
      points: [],
    });
  }
  for (const row of rows) {
    byMetric.get(row.metric_name)?.points.push({
      period_start: row.period_start,
      value: row.value == null ? null : number(row.value),
      numerator: row.numerator == null ? undefined : number(row.numerator),
      denominator:
        row.denominator == null ? undefined : number(row.denominator),
      partial: row.partial,
    });
  }
  return [...byMetric.values()];
}

function buildFunnelFromSeries({
  range,
  series,
  materializedAt,
}: {
  range: Range;
  series: GrowthMetricSeries[];
  materializedAt?: string;
}): GrowthFunnel {
  const metricNames = [
    "eligible_signups",
    "verified_accounts",
    "project_created",
    "project_surface_visible",
    "first_meaningful_work",
  ];
  const counts = new Map(
    series.map((item) => [
      item.metric_name,
      item.points.reduce((sum, point) => sum + (point.value ?? 0), 0),
    ]),
  );
  const created = counts.get("eligible_signups") ?? 0;
  let previous = 0;
  const steps: GrowthFunnelStep[] = metricNames.map((milestone, index) => {
    const accounts = counts.get(milestone) ?? 0;
    const step = {
      milestone,
      label: metricLabel(milestone),
      accounts,
      conversion_from_previous_pct:
        index === 0 ? null : percent(accounts, previous),
      conversion_from_created_pct:
        index === 0 ? 100 : percent(accounts, created),
    };
    previous = accounts;
    return step;
  });
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    metric_version: GROWTH_METRIC_VERSION,
    steps,
    materialized_at: materializedAt,
  };
}

async function latestMaterialization(): Promise<string | undefined> {
  const { rows } = await getPool().query<{ materialized_at: Date | null }>(
    `SELECT MAX(materialized_at) AS materialized_at
       FROM growth_metric_series
      WHERE scope_id=$1 AND metric_version=$2`,
    [getConfiguredBayId(), GROWTH_METRIC_VERSION],
  );
  return rows[0]?.materialized_at?.toISOString();
}

export async function getGrowthSummary(
  opts: GrowthRangeQuery = {},
): Promise<GrowthSummary> {
  const range = normalizeRange(opts);
  const series = await readSeries({
    range,
    metricNames: [
      "eligible_signups",
      "verified_accounts",
      "activated_24h",
      range.activity_signal,
    ],
  });
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    metric_version: GROWTH_METRIC_VERSION,
    activity_signal: range.activity_signal,
    series,
    materialized_at: await latestMaterialization(),
  };
}

export async function getActiveUserSeries(
  opts: GrowthRangeQuery = {},
): Promise<GrowthMetricSeries> {
  const range = normalizeRange(opts);
  const [series] = await readSeries({
    range,
    metricNames: [range.activity_signal],
  });
  return series;
}

export async function getGrowthFunnel(
  opts: GrowthRangeQuery = {},
): Promise<GrowthFunnel> {
  const range = normalizeRange(opts);
  const metricNames = [
    "eligible_signups",
    "verified_accounts",
    "project_created",
    "project_surface_visible",
    "first_meaningful_work",
  ];
  const series = await readSeries({ metricNames, range });
  return buildFunnelFromSeries({
    range,
    series,
    materializedAt: await latestMaterialization(),
  });
}

export async function getRetentionMatrix(
  opts: GrowthRangeQuery & { cohort_grain?: "day" | "week" } = {},
): Promise<GrowthRetentionMatrix> {
  const range = normalizeRange(opts);
  const cohortGrain = opts.cohort_grain === "week" ? "week" : "day";
  const { rows } = await getPool("medium").query<{
    cohort_start: string;
    period_index: number | string;
    cohort_size: number | string;
    exact_active_accounts: number | string;
    rolling_active_accounts: number | string;
    complete: boolean;
    materialized_at: Date;
  }>(
    `SELECT cohort_start::text, period_index, cohort_size,
            exact_active_accounts, rolling_active_accounts, complete,
            materialized_at
       FROM growth_retention_cells
      WHERE scope_id=$1 AND metric_version=$2 AND cohort_grain=$3
        AND activity_signal=$4 AND segment_set='overall' AND segment_value='all'
        AND cohort_start >= $5::date AND cohort_start < $6::date
      ORDER BY cohort_start, period_index`,
    [
      getConfiguredBayId(),
      GROWTH_METRIC_VERSION,
      cohortGrain,
      range.activity_signal,
      range.start,
      range.end,
    ],
  );
  const byCohort = new Map<string, GrowthRetentionMatrix["cohorts"][number]>();
  let materializedAt: Date | undefined;
  for (const row of rows) {
    let cohort = byCohort.get(row.cohort_start);
    if (!cohort) {
      cohort = { cohort_start: row.cohort_start, cells: [] };
      byCohort.set(row.cohort_start, cohort);
    }
    const size = number(row.cohort_size);
    const exact = number(row.exact_active_accounts);
    const rolling = number(row.rolling_active_accounts);
    cohort.cells.push({
      period_index: number(row.period_index),
      cohort_size: size,
      exact_active_accounts: exact,
      exact_retention_pct: row.complete ? percent(exact, size) : null,
      rolling_active_accounts: rolling,
      rolling_retention_pct: row.complete ? percent(rolling, size) : null,
      complete: row.complete,
    });
    if (!materializedAt || row.materialized_at > materializedAt) {
      materializedAt = row.materialized_at;
    }
  }
  return {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    metric_version: GROWTH_METRIC_VERSION,
    activity_signal: range.activity_signal,
    cohort_grain: cohortGrain,
    cohorts: [...byCohort.values()],
    materialized_at: materializedAt?.toISOString(),
  };
}

export async function getWeeklyGrowthAccounting(
  opts: GrowthRangeQuery = {},
): Promise<GrowthWeeklyAccounting> {
  const range = normalizeRange(opts);
  const { rows } = await getPool("medium").query<{
    week_start: string;
    new_accounts: number | string;
    retained_accounts: number | string;
    resurrected_accounts: number | string;
    churned_accounts: number | string;
    partial: boolean;
    materialized_at: Date;
  }>(
    `SELECT week_start::text, new_accounts, retained_accounts,
            resurrected_accounts, churned_accounts, partial, materialized_at
       FROM growth_weekly_accounting
      WHERE scope_id=$1 AND metric_version=$2 AND activity_signal=$3
        AND segment_set='overall' AND segment_value='all'
        AND week_start >= $4::date AND week_start < $5::date
      ORDER BY week_start`,
    [
      getConfiguredBayId(),
      GROWTH_METRIC_VERSION,
      range.activity_signal,
      range.start,
      range.end,
    ],
  );
  let materializedAt: Date | undefined;
  const points = rows.map((row) => {
    const newAccounts = number(row.new_accounts);
    const resurrected = number(row.resurrected_accounts);
    const churned = number(row.churned_accounts);
    if (!materializedAt || row.materialized_at > materializedAt) {
      materializedAt = row.materialized_at;
    }
    return {
      week_start: row.week_start,
      new_accounts: newAccounts,
      retained_accounts: number(row.retained_accounts),
      resurrected_accounts: resurrected,
      churned_accounts: churned,
      net_growth: newAccounts + resurrected - churned,
      partial: row.partial,
    };
  });
  return {
    metric_version: GROWTH_METRIC_VERSION,
    activity_signal: range.activity_signal,
    points,
    materialized_at: materializedAt?.toISOString(),
  };
}

export async function getGrowthDataHealth(): Promise<GrowthDataHealth> {
  const scopeId = getConfiguredBayId();
  const { rows } = await getPool().query<{
    last_success_at: Date | null;
    last_duration_ms: number | null;
    rows_processed: number | null;
    last_error: string | null;
    coverage_start: Date | null;
    dirty_period_count: number | string;
    oldest_dirty_period: string | null;
    event_backlog_count: number | string;
  }>(
    `SELECT state.last_success_at, state.last_duration_ms, state.rows_processed,
            state.last_error,
            state.coverage_started_at AS coverage_start,
            (SELECT COUNT(*) FROM growth_dirty_periods
              WHERE metric_version=$3 AND scope_id=$2) AS dirty_period_count,
            (SELECT MIN(period_start)::text FROM growth_dirty_periods
              WHERE metric_version=$3 AND scope_id=$2) AS oldest_dirty_period,
            (SELECT COUNT(*) FROM growth_event_log AS event
              WHERE event.home_bay_id=$2
                AND (event.received_at, event.event_id) > (
                  COALESCE(
                    NULLIF(state.source_watermark->>'received_at', '')::timestamptz,
                    '-infinity'::timestamptz
                  ),
                  COALESCE(
                    NULLIF(state.source_watermark->>'event_id', '')::uuid,
                    '00000000-0000-0000-0000-000000000000'::uuid
                  )
                )) AS event_backlog_count
       FROM growth_materialization_state AS state
      WHERE state.worker_name='growth-materializer-v1' AND state.scope_id=$1`,
    [scopeId, scopeId, GROWTH_METRIC_VERSION],
  );
  const row = rows[0];
  if (!row) {
    return {
      metric_version: GROWTH_METRIC_VERSION,
      scope_id: scopeId,
      dirty_period_count: 0,
      event_backlog_count: 0,
      status: "initializing",
    };
  }
  const lagSeconds = row.last_success_at
    ? Math.max(
        0,
        Math.round((Date.now() - row.last_success_at.getTime()) / 1000),
      )
    : undefined;
  return {
    metric_version: GROWTH_METRIC_VERSION,
    scope_id: scopeId,
    coverage_start: row.coverage_start?.toISOString(),
    last_success_at: row.last_success_at?.toISOString(),
    lag_seconds: lagSeconds,
    oldest_dirty_period: row.oldest_dirty_period ?? undefined,
    dirty_period_count: number(row.dirty_period_count),
    event_backlog_count: number(row.event_backlog_count),
    rows_processed: row.rows_processed ?? undefined,
    last_duration_ms: row.last_duration_ms ?? undefined,
    last_error: row.last_error ?? undefined,
    status: row.last_error
      ? "error"
      : lagSeconds == null
        ? "initializing"
        : lagSeconds > 15 * 60
          ? "stale"
          : "healthy",
  };
}

export async function getGrowthDashboard(
  opts: GrowthRangeQuery & { cohort_grain?: "day" | "week" } = {},
) {
  const range = normalizeRange(opts);
  const metricNames = [
    "eligible_signups",
    "verified_accounts",
    "activated_24h",
    "project_created",
    "project_surface_visible",
    "first_meaningful_work",
    range.activity_signal,
  ];
  const [series, retention, weekly, health] = await Promise.all([
    readSeries({ metricNames: [...new Set(metricNames)], range }),
    getRetentionMatrix(opts),
    getWeeklyGrowthAccounting(opts),
    getGrowthDataHealth(),
  ]);
  const materializedAt = health.last_success_at;
  const summary: GrowthSummary = {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    metric_version: GROWTH_METRIC_VERSION,
    activity_signal: range.activity_signal,
    series: series.filter(({ metric_name }) =>
      [
        "eligible_signups",
        "verified_accounts",
        "activated_24h",
        range.activity_signal,
      ].includes(metric_name),
    ),
    materialized_at: materializedAt,
  };
  return {
    summary,
    funnel: buildFunnelFromSeries({ range, series, materializedAt }),
    retention,
    weekly,
    health,
  };
}

export const __test__ = {
  normalizeRange,
  percent,
  metricLabel,
  buildFunnelFromSeries,
};
