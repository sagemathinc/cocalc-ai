/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  MembershipAnalyticsBackfillResult,
  MembershipAnalyticsDailyCountRow,
  MembershipAnalyticsEventRow,
  MembershipAnalyticsEventsQuery,
  MembershipAnalyticsEventSummaryRow,
  MembershipAnalyticsEventType,
  MembershipAnalyticsOverview,
  MembershipAnalyticsOverviewQuery,
  MembershipAnalyticsRevenueRow,
} from "@cocalc/conat/hub/api/purchases";
import { moneyToDbString } from "@cocalc/util/money";
import type { MoneyValue } from "@cocalc/util/money";

type Queryable = Pick<PoolClient, "query">;

export interface RecordMembershipAnalyticsEventOptions {
  event_key: string;
  event_type: MembershipAnalyticsEventType;
  event_time?: Date;
  bay_id?: string;
  account_id?: string | null;
  membership_class?: string | null;
  previous_membership_class?: string | null;
  source?: string | null;
  interval?: "month" | "year" | null;
  subscription_id?: number | null;
  purchase_id?: number | null;
  amount?: MoneyValue | null;
  period_start?: Date | null;
  period_end?: Date | null;
  trial_days?: number | null;
  trial_status?: "none" | "started" | "converted" | "canceled" | null;
  client?: PoolClient;
}

export interface SnapshotMembershipAnalyticsDailyCountsOptions {
  snapshot_date?: Date | string;
  bay_id?: string;
  client?: PoolClient;
}

const DEFAULT_ANALYTICS_DAYS = 90;
const MAX_EVENT_LIMIT = 1000;
let tablesEnsured = false;
let metadataColumnDropAttempted = false;

function pool(client?: PoolClient): Queryable {
  return client ?? getPool("medium");
}

export async function ensureMembershipAnalyticsTables(
  client?: PoolClient,
): Promise<void> {
  const useMemo = client == null;
  if (useMemo && tablesEnsured) {
    return;
  }
  const db = pool(client);
  await db.query(`
    CREATE TABLE IF NOT EXISTS membership_analytics_events (
      event_key VARCHAR(192) PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      event_time TIMESTAMP NOT NULL DEFAULT NOW(),
      bay_id VARCHAR(64) NOT NULL,
      account_id UUID,
      membership_class VARCHAR(254),
      previous_membership_class VARCHAR(254),
      source VARCHAR(64),
      interval VARCHAR(16),
      subscription_id INTEGER,
      purchase_id INTEGER,
      amount NUMERIC(20,10),
      period_start TIMESTAMP,
      period_end TIMESTAMP,
      trial_days INTEGER,
      trial_status VARCHAR(32),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  if (!metadataColumnDropAttempted) {
    await db.query(`
      ALTER TABLE membership_analytics_events
        DROP COLUMN IF EXISTS metadata
    `);
    metadataColumnDropAttempted = true;
  }
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_time_idx
      ON membership_analytics_events (event_time)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_type_idx
      ON membership_analytics_events (event_type)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_bay_idx
      ON membership_analytics_events (bay_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_account_idx
      ON membership_analytics_events (account_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_membership_class_idx
      ON membership_analytics_events (membership_class)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_subscription_idx
      ON membership_analytics_events (subscription_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_events_purchase_idx
      ON membership_analytics_events (purchase_id)
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS membership_analytics_daily_counts (
      snapshot_date DATE NOT NULL,
      bay_id VARCHAR(64) NOT NULL,
      membership_class VARCHAR(254) NOT NULL,
      source VARCHAR(64) NOT NULL,
      interval VARCHAR(16) NOT NULL DEFAULT 'none',
      trial_status VARCHAR(32) NOT NULL DEFAULT 'none',
      active_account_count INTEGER NOT NULL DEFAULT 0,
      subscription_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (
        snapshot_date,
        bay_id,
        membership_class,
        source,
        interval,
        trial_status
      )
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_daily_counts_date_idx
      ON membership_analytics_daily_counts (snapshot_date)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_daily_counts_bay_idx
      ON membership_analytics_daily_counts (bay_id)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS membership_analytics_daily_counts_class_idx
      ON membership_analytics_daily_counts (membership_class)
  `);
  if (useMemo) {
    tablesEnsured = true;
  }
}

export async function recordMembershipAnalyticsEvent({
  event_key,
  event_type,
  event_time = new Date(),
  bay_id = getConfiguredBayId(),
  account_id = null,
  membership_class = null,
  previous_membership_class = null,
  source = null,
  interval = null,
  subscription_id = null,
  purchase_id = null,
  amount = null,
  period_start = null,
  period_end = null,
  trial_days = null,
  trial_status = null,
  client,
}: RecordMembershipAnalyticsEventOptions): Promise<boolean> {
  await ensureMembershipAnalyticsTables(client);
  const result = await pool(client).query(
    `INSERT INTO membership_analytics_events
       (event_key, event_type, event_time, bay_id, account_id,
        membership_class, previous_membership_class, source, interval,
        subscription_id, purchase_id, amount, period_start, period_end,
        trial_days, trial_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      event_key,
      event_type,
      event_time,
      bay_id,
      account_id,
      membership_class,
      previous_membership_class,
      source,
      interval,
      subscription_id,
      purchase_id,
      amount == null ? null : moneyToDbString(amount),
      period_start,
      period_end,
      trial_days,
      trial_status,
    ],
  );
  return result.rowCount === 1;
}

export async function recordMembershipPurchaseCompleted({
  account_id,
  subscription_id,
  purchase_id,
  membership_class,
  interval,
  amount,
  period_start,
  period_end,
  event_type = "purchase_completed",
  trial_status = "none",
  client,
}: {
  account_id: string;
  subscription_id?: number | null;
  purchase_id: number;
  membership_class: string;
  interval: "month" | "year";
  amount: MoneyValue;
  period_start?: Date | null;
  period_end?: Date | null;
  event_type?: MembershipAnalyticsEventType;
  trial_status?: "none" | "converted";
  client?: PoolClient;
}): Promise<void> {
  await recordMembershipAnalyticsEvent({
    event_key: `purchase:${purchase_id}:membership`,
    event_type,
    account_id,
    membership_class,
    source: "purchase",
    interval,
    subscription_id,
    purchase_id,
    amount,
    period_start,
    period_end,
    trial_status,
    client,
  });
}

function snapshotDate(value: Date | string | undefined): string {
  const date = value == null ? new Date() : new Date(value);
  return date.toISOString().slice(0, 10);
}

export async function snapshotMembershipAnalyticsDailyCounts({
  snapshot_date,
  bay_id = getConfiguredBayId(),
  client,
}: SnapshotMembershipAnalyticsDailyCountsOptions = {}): Promise<number> {
  await ensureMembershipAnalyticsTables(client);
  const db = pool(client);
  const day = snapshotDate(snapshot_date);
  await db.query(
    `DELETE FROM membership_analytics_daily_counts
      WHERE snapshot_date=$1::date
        AND bay_id=$2`,
    [day, bay_id],
  );
  const result = await db.query(
    `
    WITH live_subscriptions AS (
      SELECT metadata->>'class' AS membership_class,
             interval::text AS interval,
             CASE
               WHEN metadata->>'trial'='true' AND latest_purchase_id IS NULL
                 THEN 'trial'
               ELSE 'none'
             END AS trial_status,
             account_id,
             id
        FROM subscriptions
       WHERE metadata->>'type'='membership'
         AND status IN ('active','canceled')
         AND current_period_end >= NOW()
    ),
    active_admin AS (
      SELECT membership_class,
             account_id
        FROM admin_assigned_memberships
       WHERE expires_at IS NULL OR expires_at > NOW()
      UNION
      SELECT 'admin' AS membership_class,
             account_id
        FROM accounts
       WHERE 'admin' = ANY(groups)
         AND coalesce(deleted,false)=false
    ),
    active_grants AS (
      SELECT membership_class,
             source,
             account_id
        FROM membership_grants
       WHERE (starts_at IS NULL OR starts_at <= NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
         AND revoked_at IS NULL
    ),
    active_accounts AS (
      SELECT account_id
        FROM accounts
       WHERE coalesce(deleted,false)=false
    ),
    paid_or_assigned_accounts AS (
      SELECT account_id FROM live_subscriptions
      UNION
      SELECT account_id FROM active_admin
      UNION
      SELECT account_id FROM active_grants
    ),
    rows AS (
      SELECT membership_class,
             'subscription' AS source,
             interval,
             trial_status,
             COUNT(DISTINCT account_id)::int AS active_account_count,
             COUNT(*)::int AS subscription_count
        FROM live_subscriptions
       GROUP BY membership_class, interval, trial_status
      UNION ALL
      SELECT membership_class,
             'admin' AS source,
             'none' AS interval,
             'none' AS trial_status,
             COUNT(DISTINCT account_id)::int AS active_account_count,
             0 AS subscription_count
        FROM active_admin
       GROUP BY membership_class
      UNION ALL
      SELECT membership_class,
             source,
             'none' AS interval,
             'none' AS trial_status,
             COUNT(DISTINCT account_id)::int AS active_account_count,
             0 AS subscription_count
        FROM active_grants
       GROUP BY membership_class, source
      UNION ALL
      SELECT 'free' AS membership_class,
             'free' AS source,
             'none' AS interval,
             'none' AS trial_status,
             COUNT(*)::int AS active_account_count,
             0 AS subscription_count
        FROM active_accounts a
       WHERE NOT EXISTS (
             SELECT 1
               FROM paid_or_assigned_accounts p
              WHERE p.account_id = a.account_id
             )
      UNION ALL
      SELECT 'all' AS membership_class,
             'active-accounts' AS source,
             'none' AS interval,
             'none' AS trial_status,
             COUNT(*)::int AS active_account_count,
             0 AS subscription_count
        FROM active_accounts
    )
    INSERT INTO membership_analytics_daily_counts
      (snapshot_date, bay_id, membership_class, source, interval, trial_status,
       active_account_count, subscription_count)
    SELECT $1::date, $2, membership_class, source, interval, trial_status,
           active_account_count, subscription_count
      FROM rows
     WHERE active_account_count > 0 OR subscription_count > 0
    ON CONFLICT (
      snapshot_date, bay_id, membership_class, source, interval, trial_status
    ) DO UPDATE SET
      active_account_count=EXCLUDED.active_account_count,
      subscription_count=EXCLUDED.subscription_count,
      updated_at=NOW()
    `,
    [day, bay_id],
  );
  return result.rowCount ?? 0;
}

export async function backfillMembershipAnalyticsPurchaseEvents({
  client,
  limit = 1000,
}: {
  client?: PoolClient;
  limit?: number;
} = {}): Promise<MembershipAnalyticsBackfillResult> {
  await ensureMembershipAnalyticsTables(client);
  const db = pool(client);
  const maxRows = Math.max(
    1,
    Math.min(10_000, Math.floor(Number(limit) || 1000)),
  );
  const { rows } = await db.query(
    `SELECT id, time, account_id, cost, description, period_start, period_end
       FROM purchases p
      WHERE service='membership'
        AND description->>'type'='membership'
        AND NOT EXISTS (
              SELECT 1
                FROM membership_analytics_events e
               WHERE e.event_key = 'purchase:' || p.id::text || ':membership'
            )
      ORDER BY id ASC
      LIMIT $1`,
    [maxRows],
  );
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const description = row.description ?? {};
    const ok = await recordMembershipAnalyticsEvent({
      event_key: `purchase:${row.id}:membership`,
      event_type: "backfilled_purchase",
      event_time: row.time,
      account_id: row.account_id,
      membership_class: description.class ?? null,
      source: "purchase-backfill",
      interval: description.interval ?? null,
      subscription_id: description.subscription_id ?? null,
      purchase_id: row.id,
      amount: row.cost,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
      trial_days: description.trial_days ?? null,
      trial_status: description.trial_days ? "started" : "none",
      client,
    });
    if (ok) {
      inserted += 1;
    } else {
      skipped += 1;
    }
  }
  return { inserted, skipped };
}

function defaultRange(query: MembershipAnalyticsOverviewQuery = {}): {
  start: Date;
  end: Date;
} {
  const end = query.end == null ? new Date() : new Date(query.end);
  const start =
    query.start == null
      ? new Date(end.getTime() - DEFAULT_ANALYTICS_DAYS * 24 * 60 * 60 * 1000)
      : new Date(query.start);
  return { start, end };
}

export async function getMembershipAnalyticsOverviewLocal({
  bay_id = getConfiguredBayId(),
  query = {},
  client,
}: {
  bay_id?: string;
  query?: MembershipAnalyticsOverviewQuery;
  client?: PoolClient;
} = {}): Promise<
  Omit<MembershipAnalyticsOverview, "current_bay_id" | "seed_bay_id" | "bays">
> {
  await ensureMembershipAnalyticsTables(client);
  const { start, end } = defaultRange(query);
  const db = pool(client);
  const [revenueResult, eventsResult, countsResult] = await Promise.all([
    db.query<MembershipAnalyticsRevenueRow>(
      `SELECT COALESCE(membership_class, 'unknown') AS membership_class,
              COALESCE(interval, 'none') AS interval,
              COALESCE(SUM(amount), 0)::float8 AS gross_revenue,
              COUNT(*)::int AS purchase_count
         FROM membership_analytics_events
        WHERE event_time >= $1
          AND event_time < $2
          AND event_type IN ('purchase_completed', 'backfilled_purchase')
          AND COALESCE(amount, 0) > 0
        GROUP BY COALESCE(membership_class, 'unknown'), COALESCE(interval, 'none')
        ORDER BY membership_class, interval`,
      [start, end],
    ),
    db.query<MembershipAnalyticsEventSummaryRow>(
      `SELECT date_trunc('day', event_time) AS day,
              event_type,
              COUNT(*)::int AS count,
              COALESCE(SUM(amount), 0)::float8 AS amount
         FROM membership_analytics_events
        WHERE event_time >= $1
          AND event_time < $2
        GROUP BY date_trunc('day', event_time), event_type
        ORDER BY day, event_type`,
      [start, end],
    ),
    db.query<MembershipAnalyticsDailyCountRow>(
      `SELECT snapshot_date,
              bay_id,
              membership_class,
              source,
              interval,
              trial_status,
              active_account_count,
              subscription_count
         FROM membership_analytics_daily_counts
        WHERE snapshot_date >= $1::date
          AND snapshot_date < $2::date
        ORDER BY snapshot_date, membership_class, source, interval, trial_status`,
      [start, end],
    ),
  ]);
  return {
    checked_at: new Date().toISOString(),
    start: start.toISOString(),
    end: end.toISOString(),
    revenue: revenueResult.rows,
    events: eventsResult.rows,
    daily_counts: countsResult.rows.map((row) => ({ ...row, bay_id })),
  };
}

export async function getMembershipAnalyticsEventsLocal({
  query = {},
  client,
}: {
  query?: MembershipAnalyticsEventsQuery;
  client?: PoolClient;
} = {}): Promise<MembershipAnalyticsEventRow[]> {
  await ensureMembershipAnalyticsTables(client);
  const { start, end } = defaultRange(query);
  const params: unknown[] = [start, end];
  const filters = ["event_time >= $1", "event_time < $2"];
  if (query.event_type) {
    params.push(query.event_type);
    filters.push(`event_type = $${params.length}`);
  }
  if (query.membership_class) {
    params.push(query.membership_class);
    filters.push(`membership_class = $${params.length}`);
  }
  const limit = Math.max(
    1,
    Math.min(MAX_EVENT_LIMIT, Math.floor(Number(query.limit ?? 100) || 100)),
  );
  params.push(limit);
  const { rows } = await pool(client).query<MembershipAnalyticsEventRow>(
    `SELECT event_key, event_type, event_time, bay_id, account_id,
            membership_class, previous_membership_class, source, interval,
            subscription_id, purchase_id, amount::float8 AS amount,
            period_start, period_end, trial_days, trial_status
       FROM membership_analytics_events
      WHERE ${filters.join(" AND ")}
      ORDER BY event_time DESC, event_key DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}
