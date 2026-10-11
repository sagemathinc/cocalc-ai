/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  SiteLicenseRevenueAnalytics,
  SiteLicenseRevenueAnalyticsRequest,
  SiteLicenseRevenueAnalyticsRow,
  SiteLicenseRevenueMeasure,
} from "@cocalc/conat/hub/api/commercial-orders";
import { getCachedReadPool, type CachedReadPool } from "@cocalc/database/pool";
import { moneyRoundToCents } from "@cocalc/util/money";
import { allocateIntegerByWeights } from "../purchases/compute-revenue-analytics";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 365;

// Reads only: a pool, a client or a cached read pool.
type Queryable = CachedReadPool;

interface ContractRow {
  item_id: string;
  subtotal: string;
  starts_at: Date;
  ends_at: Date | null;
}

interface PointInTimeRow {
  source_id: string;
  occurred_at: Date;
  amount: string;
  site_subtotal: string;
  order_subtotal: string;
}

interface Aggregate {
  amount_cents: number;
  source_ids: Set<string>;
}

export function siteLicenseRevenueAnalyticsRange(
  request: Pick<SiteLicenseRevenueAnalyticsRequest, "start" | "end"> = {},
  now = new Date(),
): { start: Date; end: Date } {
  const today = utcDay(now);
  const end = request.end == null ? nextDay(today) : utcDay(request.end);
  const start =
    request.start == null
      ? new Date(end.valueOf() - DEFAULT_DAYS * DAY_MS)
      : utcDay(request.start);
  if (start >= end) {
    throw Error("site license revenue analytics start must be before end");
  }
  return { start, end };
}

function utcDay(value: Date | string | number): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error("invalid site license revenue analytics date");
  }
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function nextDay(value: Date): Date {
  return new Date(value.valueOf() + DAY_MS);
}

function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function cents(value: string): number {
  return moneyRoundToCents(value).mul(100).toNumber();
}

function add(
  aggregates: Map<string, Aggregate>,
  measure: SiteLicenseRevenueMeasure,
  day: Date,
  amountCents: number,
  sourceId: string,
): void {
  if (amountCents === 0) return;
  const key = `${dayKey(day)}\0${measure}`;
  const aggregate = aggregates.get(key) ?? {
    amount_cents: 0,
    source_ids: new Set<string>(),
  };
  aggregate.amount_cents += amountCents;
  aggregate.source_ids.add(sourceId);
  aggregates.set(key, aggregate);
}

function contractDays(startsAt: Date, endsAt: Date | null): Date[] {
  const start = utcDay(startsAt);
  const normalizedEnd = endsAt == null ? nextDay(start) : utcDay(endsAt);
  const end = normalizedEnd > start ? normalizedEnd : nextDay(start);
  const days: Date[] = [];
  for (let day = start; day < end; day = nextDay(day)) {
    days.push(day);
  }
  return days;
}

function siteShareCents(row: PointInTimeRow): number {
  const amountCents = cents(row.amount);
  const site = Number(row.site_subtotal);
  const total = Number(row.order_subtotal);
  if (!(site > 0) || !(total > 0)) return 0;
  if (site >= total) return amountCents;
  return allocateIntegerByWeights(amountCents, [site, total - site])[0];
}

async function listContracts(
  client: Queryable,
  start: Date,
  end: Date,
): Promise<ContractRow[]> {
  const { rows } = await client.query<ContractRow>(
    `SELECT item.id AS item_id,
            item.subtotal::text AS subtotal,
            COALESCE(item.service_start,o.service_starts_at,o.approved_at) AS starts_at,
            COALESCE(item.service_end,o.service_ends_at) AS ends_at
       FROM commercial_order_items item
       JOIN commercial_orders o ON o.id=item.commercial_order_id
      WHERE item.product_kind='site_license'
        AND o.approved_at IS NOT NULL
        AND o.workflow_state <> 'cancelled'
        AND o.collection_mode <> 'complimentary'
        AND COALESCE(item.service_start,o.service_starts_at,o.approved_at) < $2
        AND COALESCE(item.service_end,o.service_ends_at,
                     date_trunc('day',COALESCE(item.service_start,
                       o.service_starts_at,o.approved_at)) + INTERVAL '1 day') > $1
      ORDER BY item.id`,
    [start, end],
  );
  return rows;
}

async function listInvoices(
  client: Queryable,
  start: Date,
  end: Date,
): Promise<PointInTimeRow[]> {
  const { rows } = await client.query<PointInTimeRow>(
    `SELECT invoice.id AS source_id,
            COALESCE(invoice.sent_at,invoice.created_at) AS occurred_at,
            invoice.subtotal::text AS amount,
            site.site_subtotal::text,
            o.agreed_subtotal::text AS order_subtotal
       FROM commercial_invoices invoice
       JOIN commercial_orders o ON o.id=invoice.commercial_order_id
       JOIN LATERAL (
         SELECT SUM(item.subtotal) AS site_subtotal
           FROM commercial_order_items item
          WHERE item.commercial_order_id=o.id
            AND item.product_kind='site_license'
       ) site ON site.site_subtotal > 0
      WHERE invoice.status IN ('open','paid','uncollectible')
        AND o.workflow_state <> 'cancelled'
        AND COALESCE(invoice.sent_at,invoice.created_at) >= $1
        AND COALESCE(invoice.sent_at,invoice.created_at) < $2
      ORDER BY invoice.id`,
    [start, end],
  );
  return rows;
}

async function listPayments(
  client: Queryable,
  start: Date,
  end: Date,
): Promise<PointInTimeRow[]> {
  const { rows } = await client.query<PointInTimeRow>(
    `SELECT payment.id AS source_id,
            payment.received_at AS occurred_at,
            payment.amount::text AS amount,
            site.site_subtotal::text,
            o.agreed_subtotal::text AS order_subtotal
       FROM commercial_payments payment
       JOIN commercial_orders o ON o.id=payment.commercial_order_id
       JOIN LATERAL (
         SELECT SUM(item.subtotal) AS site_subtotal
           FROM commercial_order_items item
          WHERE item.commercial_order_id=o.id
            AND item.product_kind='site_license'
       ) site ON site.site_subtotal > 0
      WHERE payment.status IN ('succeeded','partially_refunded','refunded')
        AND payment.received_at >= $1
        AND payment.received_at < $2
      ORDER BY payment.id`,
    [start, end],
  );
  return rows;
}

export async function getSiteLicenseRevenueAnalytics({
  request = { reason: "site license revenue analytics" },
  client = getCachedReadPool("medium"),
  now = new Date(),
}: {
  request?: SiteLicenseRevenueAnalyticsRequest;
  client?: Queryable;
  now?: Date;
} = {}): Promise<SiteLicenseRevenueAnalytics> {
  const { start, end } = siteLicenseRevenueAnalyticsRange(request, now);
  const [contracts, invoices, payments] = await Promise.all([
    listContracts(client, start, end),
    listInvoices(client, start, end),
    listPayments(client, start, end),
  ]);
  const aggregates = new Map<string, Aggregate>();
  for (const contract of contracts) {
    const days = contractDays(contract.starts_at, contract.ends_at);
    const allocations = allocateIntegerByWeights(
      cents(contract.subtotal),
      days.map(() => 1),
    );
    days.forEach((day, index) => {
      if (day >= start && day < end) {
        add(
          aggregates,
          "contracted",
          day,
          allocations[index],
          contract.item_id,
        );
      }
    });
  }
  for (const invoice of invoices) {
    add(
      aggregates,
      "invoiced",
      utcDay(invoice.occurred_at),
      siteShareCents(invoice),
      invoice.source_id,
    );
  }
  for (const payment of payments) {
    add(
      aggregates,
      "collected",
      utcDay(payment.occurred_at),
      siteShareCents(payment),
      payment.source_id,
    );
  }
  const rows: SiteLicenseRevenueAnalyticsRow[] = [...aggregates.entries()]
    .map(([key, value]) => {
      const [day, measure] = key.split("\0") as [
        string,
        SiteLicenseRevenueMeasure,
      ];
      return {
        day,
        measure,
        amount_cents: value.amount_cents,
        source_count: value.source_ids.size,
      };
    })
    .sort((a, b) =>
      `${a.day}\0${a.measure}`.localeCompare(`${b.day}\0${b.measure}`),
    );
  return {
    checked_at: now.toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
    rows,
  };
}
