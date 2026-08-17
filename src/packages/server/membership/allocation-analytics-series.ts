/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  MembershipAllocationDailyRow,
  MembershipAllocationSeriesQuery,
} from "@cocalc/conat/hub/api/purchases";

type Queryable = Pick<PoolClient, "query">;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 365;

function utcDay(value: Date | string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error("invalid membership allocation date range");
  }
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function membershipAllocationSeriesRange(
  query: MembershipAllocationSeriesQuery = {},
): { start: Date; end: Date } {
  const now = new Date();
  const end =
    query.end == null
      ? new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
          ),
        )
      : utcDay(query.end);
  const start =
    query.start == null
      ? new Date(end.valueOf() - DEFAULT_DAYS * DAY_MS)
      : utcDay(query.start);
  if (start >= end) {
    throw Error("membership allocation start must be before end");
  }
  return { start, end };
}

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

interface DailyRowResult extends Omit<
  MembershipAllocationDailyRow,
  "active_memberships" | "purchased_capacity" | "revenue_cents" | "fact_count"
> {
  active_memberships: number | string;
  purchased_capacity: number | string;
  revenue_cents: number | string;
  fact_count: number | string;
}

export async function getMembershipAllocationSeriesLocal({
  query = {},
  client,
}: {
  query?: MembershipAllocationSeriesQuery;
  client?: Queryable;
} = {}): Promise<{
  start: string;
  end: string;
  rows: MembershipAllocationDailyRow[];
}> {
  const { start, end } = membershipAllocationSeriesRange(query);
  const params: unknown[] = [
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  ];
  const filters = ["day >= $1::date", "day < $2::date"];
  addArrayFilter(filters, params, "channel", query.channels);
  addArrayFilter(filters, params, "membership_class", query.membership_classes);
  addArrayFilter(filters, params, "billing_interval", query.billing_intervals);
  addArrayFilter(filters, params, "lifecycle", query.lifecycles);

  const { rows } = await (client ?? getPool("medium")).query<DailyRowResult>(
    `SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day,
            channel, membership_class, billing_interval, lifecycle,
            NULLIF(previous_membership_class, '') AS previous_membership_class,
            NULLIF(previous_billing_interval, '') AS previous_billing_interval,
            tier_change,
            SUM(active_memberships)::bigint AS active_memberships,
            SUM(purchased_capacity)::bigint AS purchased_capacity,
            SUM(revenue_cents)::bigint AS revenue_cents,
            SUM(fact_count)::bigint AS fact_count
       FROM membership_daily_allocations
      WHERE ${filters.join(" AND ")}
      GROUP BY day, channel, membership_class, billing_interval, lifecycle,
               previous_membership_class, previous_billing_interval, tier_change
     HAVING SUM(active_memberships) <> 0
         OR SUM(purchased_capacity) <> 0
         OR SUM(revenue_cents) <> 0
      ORDER BY day, channel, membership_class, billing_interval, lifecycle,
               previous_membership_class, previous_billing_interval, tier_change`,
    params,
  );
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    rows: rows.map((row) => ({
      ...row,
      active_memberships: Number(row.active_memberships),
      purchased_capacity: Number(row.purchased_capacity),
      revenue_cents: Number(row.revenue_cents),
      fact_count: Number(row.fact_count),
    })),
  };
}
