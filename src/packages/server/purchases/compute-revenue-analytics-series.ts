/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getCachedReadPool, type CachedReadPool } from "@cocalc/database/pool";
import type {
  ComputeRevenueDailyRow,
  ComputeRevenueSeriesQuery,
  ComputeUsageDailyRow,
} from "@cocalc/conat/hub/api/purchases";
import { utcDay } from "./compute-revenue-analytics";

// Reads only: a pool, a client or a cached read pool.
type Queryable = CachedReadPool;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 365;

function addArrayFilter(
  filters: string[],
  params: unknown[],
  column: string,
  values: string[] | undefined,
): void {
  const normalized = [
    ...new Set(values?.map((value) => value.trim()).filter(Boolean) ?? []),
  ];
  if (normalized.length === 0) return;
  params.push(normalized);
  filters.push(`${column}=ANY($${params.length}::text[])`);
}

export function computeRevenueSeriesRange(
  query: ComputeRevenueSeriesQuery = {},
): { start: Date; end: Date } {
  const today = utcDay(new Date());
  const end = query.end == null ? today : utcDay(query.end);
  const start =
    query.start == null
      ? new Date(end.valueOf() - DEFAULT_DAYS * DAY_MS)
      : utcDay(query.start);
  if (start >= end) {
    throw Error("compute revenue analytics start must be before end");
  }
  return { start, end };
}

interface RevenueResult extends Omit<
  ComputeRevenueDailyRow,
  "revenue_cents" | "purchase_count"
> {
  revenue_cents: number | string;
  purchase_count: number | string;
}

interface UsageResult extends Omit<
  ComputeUsageDailyRow,
  "running_unit_seconds" | "distinct_running_units"
> {
  running_unit_seconds: number | string;
  distinct_running_units: number | string;
}

export async function getComputeRevenueSeriesLocal({
  query = {},
  // query-cache-ok: admin analytics: compute revenue series
  client = getCachedReadPool("medium", {
    label: "compute-revenue-analytics-series",
  }),
}: {
  query?: ComputeRevenueSeriesQuery;
  client?: Queryable;
} = {}): Promise<{
  start: string;
  end: string;
  complete_through: string | null;
  revenue: ComputeRevenueDailyRow[];
  usage: ComputeUsageDailyRow[];
}> {
  const range = computeRevenueSeriesRange(query);
  const { rows: stateRows } = await client.query<{
    complete_through: Date | null;
  }>(
    `SELECT MAX(complete_through) AS complete_through
       FROM compute_revenue_analytics_state`,
  );
  const completeThrough = stateRows[0]?.complete_through
    ? utcDay(stateRows[0].complete_through)
    : null;
  const completeEnd = completeThrough
    ? new Date(completeThrough.valueOf() + DAY_MS)
    : range.start;
  const end = range.end < completeEnd ? range.end : completeEnd;
  if (range.start >= end) {
    return {
      start: range.start.toISOString(),
      end: end.toISOString(),
      complete_through: completeThrough?.toISOString().slice(0, 10) ?? null,
      revenue: [],
      usage: [],
    };
  }
  const params: unknown[] = [
    range.start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  ];
  const revenueFilters = ["day >= $1::date", "day < $2::date"];
  addArrayFilter(revenueFilters, params, "product", query.products);
  addArrayFilter(revenueFilters, params, "provider", query.providers);
  addArrayFilter(
    revenueFilters,
    params,
    "cost_component",
    query.cost_components,
  );
  const { rows: revenueRows } = await client.query<RevenueResult>(
    `SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day,
            product, provider, cost_component,
            SUM(revenue_cents)::bigint AS revenue_cents,
            SUM(purchase_count)::bigint AS purchase_count
       FROM compute_revenue_daily
      WHERE ${revenueFilters.join(" AND ")}
      GROUP BY day, product, provider, cost_component
     HAVING SUM(revenue_cents) <> 0
      ORDER BY day, product, provider, cost_component`,
    params,
  );
  const usageParams: unknown[] = params.slice(0, 2);
  const usageFilters = ["day >= $1::date", "day < $2::date"];
  addArrayFilter(usageFilters, usageParams, "product", query.products);
  addArrayFilter(usageFilters, usageParams, "provider", query.providers);
  const { rows: usageRows } = await client.query<UsageResult>(
    `SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day,
            product, provider,
            SUM(running_unit_seconds)::bigint AS running_unit_seconds,
            SUM(distinct_running_units)::bigint AS distinct_running_units
       FROM compute_usage_daily
      WHERE ${usageFilters.join(" AND ")}
      GROUP BY day, product, provider
     HAVING SUM(running_unit_seconds) <> 0
         OR SUM(distinct_running_units) <> 0
      ORDER BY day, product, provider`,
    usageParams,
  );
  return {
    start: range.start.toISOString(),
    end: end.toISOString(),
    complete_through: completeThrough?.toISOString().slice(0, 10) ?? null,
    revenue: revenueRows.map((row) => ({
      ...row,
      revenue_cents: Number(row.revenue_cents),
      purchase_count: Number(row.purchase_count),
    })),
    usage: usageRows.map((row) => ({
      ...row,
      running_unit_seconds: Number(row.running_unit_seconds),
      distinct_running_units: Number(row.distinct_running_units),
    })),
  };
}
