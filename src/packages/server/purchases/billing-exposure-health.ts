/*
Billing exposure: money the site is owed or keeps spending without a payer.

admin health reports four read-only signals:

1. accounts whose live balance (-SUM(COST_OR_METERED_COST) over purchases,
   as in get-balance.ts; accounts.balance is only a cache) is below
   -NEGATIVE_BALANCE_THRESHOLD_USD. Accounts with monthly collection enabled
   are post-paid and expected to go negative between collections, so they are
   reported separately and never raise the level;
2. open metered purchases (cost and period_end NULL, cost_per_hour set) whose
   owner's live balance is negative (post-paid owners excluded);
3. dedicated hosts stopped by billing enforcement (stopped_billing_blocked)
   past deprovision_after whose final backup has not succeeded, so their disk
   can neither be deleted nor billed;
4. running owner-funded dedicated hosts (tier NULL) that ran no project for
   IDLE_HOST_DAYS, according to project_host_metrics_samples.

Levels: critical for any stuck host (3) or when the non-post-paid negative
balance total exceeds EXPOSURE_CRITICAL_USD; warning for any of 1, 2 or 4;
healthy otherwise.
*/

import getPool from "@cocalc/database/pool";
import { ensureProjectHostMetricsSamplesSchema } from "@cocalc/database/postgres/project-host-metrics";
import { billingAccountsTable } from "./billing-account";
import { COST_OR_METERED_COST } from "./get-balance";

export const NEGATIVE_BALANCE_THRESHOLD_USD = 20;
export const EXPOSURE_CRITICAL_USD = 200;
export const IDLE_HOST_DAYS = 3;
// A host counts as idle only if it reported metrics near the start of the idle
// window, so a host restarted after a long stop is not reported.
export const IDLE_HOST_WINDOW_START_TOLERANCE_HOURS = 6;
export const WORST_ACCOUNTS_LIMIT = 5;
export const HOSTS_LIMIT = 20;
export const BILLING_EXPOSURE_STATEMENT_TIMEOUT_MS = 15_000;

export interface BillingExposureAccount {
  account_id: string;
  balance: number;
}

export interface BillingExposureNegativeBalances {
  count: number;
  total_usd: number;
  worst: BillingExposureAccount[];
}

export interface BillingExposureOpenMetered {
  count: number;
  cost_per_hour_usd: number;
  oldest_period_start: string | null;
  account_ids: string[];
}

export interface BillingExposureStuckHost {
  host_id: string;
  name: string | null;
  owner: string | null;
  deprovision_after: string;
  final_backup_status: string | null;
}

export interface BillingExposureIdleHost {
  host_id: string;
  name: string | null;
  owner: string | null;
  last_busy_at: string | null;
}

export interface BillingExposureHealth {
  negative: BillingExposureNegativeBalances;
  postpaid_negative: BillingExposureNegativeBalances;
  open_metered: BillingExposureOpenMetered;
  stuck_hosts: BillingExposureStuckHost[];
  idle_hosts: BillingExposureIdleHost[];
}

export type BillingExposureHealthLevel = "healthy" | "warning" | "critical";

export function billingExposureHealthLevel(
  health: BillingExposureHealth,
): BillingExposureHealthLevel {
  if (
    health.stuck_hosts.length > 0 ||
    health.negative.total_usd > EXPOSURE_CRITICAL_USD
  ) {
    return "critical";
  }
  if (
    health.negative.count > 0 ||
    health.open_metered.count > 0 ||
    health.idle_hosts.length > 0
  ) {
    return "warning";
  }
  return "healthy";
}

function usd(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function billingExposureHealthSummary(
  health: BillingExposureHealth,
): string {
  const parts: string[] = [];
  if (health.negative.count > 0) {
    parts.push(
      `${plural(health.negative.count, "account")} below -${usd(NEGATIVE_BALANCE_THRESHOLD_USD)} (${usd(health.negative.total_usd)} owed)`,
    );
  }
  if (health.open_metered.count > 0) {
    parts.push(
      `${plural(health.open_metered.count, "open metered purchase")} with a negative owner balance (${usd(health.open_metered.cost_per_hour_usd)}/hour)`,
    );
  }
  if (health.stuck_hosts.length > 0) {
    parts.push(
      `${plural(health.stuck_hosts.length, "billing-blocked host")} past deprovision without a successful final backup`,
    );
  }
  if (health.idle_hosts.length > 0) {
    parts.push(
      `${plural(health.idle_hosts.length, "running dedicated host")} with no running project for ${IDLE_HOST_DAYS} days`,
    );
  }
  if (parts.length === 0) {
    return "No unpaid balance, unfunded metered usage, stuck billing-blocked host or idle dedicated host.";
  }
  return `${parts.join("; ")}.`;
}

export function billingExposureHealthDetails(
  health: BillingExposureHealth,
): string[] {
  const details: string[] = [];
  const accounts = (worst: BillingExposureAccount[]) =>
    worst.map(({ account_id, balance }) => `${account_id} ${usd(balance)}`);
  if (health.negative.count > 0) {
    details.push(
      `Most negative accounts: ${accounts(health.negative.worst).join(", ")}`,
    );
  }
  if (health.open_metered.count > 0) {
    details.push(
      `Open metered purchases since ${health.open_metered.oldest_period_start ?? "unknown"} for accounts: ${health.open_metered.account_ids.join(", ")}`,
    );
  }
  for (const host of health.stuck_hosts) {
    details.push(
      `Stuck host ${host.host_id}${host.name ? ` (${host.name})` : ""} owner ${host.owner ?? "unknown"}: deprovision_after ${host.deprovision_after}, final backup ${host.final_backup_status ?? "unknown"}`,
    );
  }
  for (const host of health.idle_hosts) {
    details.push(
      `Idle host ${host.host_id}${host.name ? ` (${host.name})` : ""} owner ${host.owner ?? "unknown"}: last running project ${host.last_busy_at ?? "not in retained metrics"}`,
    );
  }
  if (health.postpaid_negative.count > 0) {
    details.push(
      `Post-paid accounts (collected later) below -${usd(NEGATIVE_BALANCE_THRESHOLD_USD)}, expected between collections: ${plural(health.postpaid_negative.count, "account")}, ${usd(health.postpaid_negative.total_usd)}; ${accounts(health.postpaid_negative.worst).join(", ")}`,
    );
  }
  return details;
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = new Date(value as any);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function toAccounts(value: unknown): BillingExposureAccount[] {
  return (Array.isArray(value) ? value : []).map((row: any) => ({
    account_id: `${row?.account_id ?? ""}`,
    balance: toNumber(row?.balance),
  }));
}

type Queryable = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

async function getBalanceExposure(
  db: Queryable,
): Promise<
  Pick<BillingExposureHealth, "negative" | "postpaid_negative" | "open_metered">
> {
  const table = billingAccountsTable();
  const { rows } = await db.query(
    `WITH live AS (
       SELECT account_id,
              ROUND(-COALESCE(SUM(${COST_OR_METERED_COST}), 0), 2) AS balance
         FROM purchases
        GROUP BY account_id
     ), negative AS (
       -- Post-paid means collectible later: an active account (not banned,
       -- deleted or fenced, as the monthly collection worker requires) that
       -- hasUsageSubscription in stripe-usage-based-subscription.ts accepts:
       -- explicit monthly collection consent without a blocked collection,
       -- else legacy enrollment in a stripe usage subscription.
       SELECT l.account_id, l.balance,
              COALESCE(
                CASE
                  -- The collection worker skips these, so they are never
                  -- collected.
                  WHEN a.banned IS TRUE OR a.deleted IS TRUE
                       OR EXISTS (
                         SELECT 1 FROM billing_authority_account_fences f
                          WHERE f.account_id = l.account_id AND f.frozen)
                  THEN FALSE
                  WHEN a.monthly_collection IS NOT NULL
                       AND a.monthly_collection <> 'null'::jsonb
                  THEN a.monthly_collection->'enabled' = 'true'::jsonb
                       AND a.monthly_collection->'terms_version' = '1'::jsonb
                       AND NOT EXISTS (
                         SELECT 1 FROM statements st
                          WHERE st.account_id = l.account_id
                            AND st.paid_purchase_id IS NULL
                            AND (st.monthly_collection->>'state' = 'requires_review'
                                 OR (st.monthly_collection->>'state' IN ('claimed','issued')
                                     AND st.automatic_payment < clock_timestamp() - interval '10 minutes')))
                  ELSE COALESCE(a.stripe_usage_subscription, '') <> ''
                END,
                FALSE) AS postpaid
         FROM live l
         LEFT JOIN ${table} a ON a.account_id = l.account_id
        WHERE l.balance < 0
     ), open_metered AS (
       SELECT p.account_id, p.cost_per_hour, p.period_start
         FROM purchases p
         JOIN negative n ON n.account_id = p.account_id AND NOT n.postpaid
        WHERE p.cost IS NULL
          AND p.period_end IS NULL
          AND p.cost_per_hour IS NOT NULL
     )
     SELECT
       (SELECT COUNT(*) FROM negative
         WHERE NOT postpaid AND balance < -$1::numeric)::TEXT AS negative_count,
       (SELECT COALESCE(-SUM(balance), 0) FROM negative
         WHERE NOT postpaid AND balance < -$1::numeric)::TEXT AS negative_total,
       (SELECT COALESCE(json_agg(
            json_build_object('account_id', w.account_id, 'balance', w.balance::TEXT)
            ORDER BY w.balance, w.account_id), '[]'::json)
          FROM (SELECT account_id, balance FROM negative
                 WHERE NOT postpaid AND balance < -$1::numeric
                 ORDER BY balance, account_id LIMIT $2) w) AS negative_worst,
       (SELECT COUNT(*) FROM negative
         WHERE postpaid AND balance < -$1::numeric)::TEXT AS postpaid_count,
       (SELECT COALESCE(-SUM(balance), 0) FROM negative
         WHERE postpaid AND balance < -$1::numeric)::TEXT AS postpaid_total,
       (SELECT COALESCE(json_agg(
            json_build_object('account_id', w.account_id, 'balance', w.balance::TEXT)
            ORDER BY w.balance, w.account_id), '[]'::json)
          FROM (SELECT account_id, balance FROM negative
                 WHERE postpaid AND balance < -$1::numeric
                 ORDER BY balance, account_id LIMIT $2) w) AS postpaid_worst,
       (SELECT COUNT(*) FROM open_metered)::TEXT AS open_metered_count,
       (SELECT COALESCE(SUM(cost_per_hour), 0) FROM open_metered)::TEXT
         AS open_metered_cost_per_hour,
       (SELECT MIN(period_start) FROM open_metered) AS open_metered_oldest,
       (SELECT COALESCE(
                 json_agg(o.account_id ORDER BY o.cost_per_hour DESC, o.account_id),
                 '[]'::json)
          FROM (SELECT account_id, SUM(cost_per_hour) AS cost_per_hour
                  FROM open_metered
                 GROUP BY account_id
                 ORDER BY SUM(cost_per_hour) DESC, account_id LIMIT $2) o)
         AS open_metered_accounts`,
    [NEGATIVE_BALANCE_THRESHOLD_USD, WORST_ACCOUNTS_LIMIT],
  );
  const row = rows[0] ?? {};
  return {
    negative: {
      count: toNumber(row.negative_count),
      total_usd: toNumber(row.negative_total),
      worst: toAccounts(row.negative_worst),
    },
    postpaid_negative: {
      count: toNumber(row.postpaid_count),
      total_usd: toNumber(row.postpaid_total),
      worst: toAccounts(row.postpaid_worst),
    },
    open_metered: {
      count: toNumber(row.open_metered_count),
      cost_per_hour_usd: toNumber(row.open_metered_cost_per_hour),
      oldest_period_start: toIso(row.open_metered_oldest),
      account_ids: (Array.isArray(row.open_metered_accounts)
        ? row.open_metered_accounts
        : []
      ).map((id: unknown) => `${id}`),
    },
  };
}

async function getStuckHosts(
  db: Queryable,
  bay_id: string,
  now: number,
): Promise<BillingExposureStuckHost[]> {
  // deprovision_after is free-form JSON text, so compare it here instead of
  // casting in SQL, where one malformed value would fail the whole check.
  const { rows } = await db.query(
    `SELECT id, name, metadata->>'owner' AS owner,
            metadata#>>'{billing,enforcement,deprovision_after}' AS deprovision_after,
            metadata#>>'{billing,enforcement,final_backup_status}' AS final_backup_status
       FROM project_hosts
      WHERE deleted IS NULL
        AND bay_id = $1
        AND metadata#>>'{billing,enforcement,state}' = 'stopped_billing_blocked'
        AND COALESCE(metadata#>>'{billing,enforcement,final_backup_status}', '') <> 'succeeded'`,
    [bay_id],
  );
  return rows
    .filter((row) => {
      const after = toIso(row.deprovision_after);
      return after != null && new Date(after).valueOf() < now;
    })
    .map((row) => ({
      host_id: `${row.id}`,
      name: row.name ?? null,
      owner: row.owner ?? null,
      deprovision_after: toIso(row.deprovision_after)!,
      final_backup_status: row.final_backup_status ?? null,
    }))
    .sort((a, b) => a.deprovision_after.localeCompare(b.deprovision_after))
    .slice(0, HOSTS_LIMIT);
}

async function getIdleHosts(
  db: Queryable,
  bay_id: string,
): Promise<BillingExposureIdleHost[]> {
  const { rows } = await db.query(
    `SELECT h.id, h.name, h.metadata->>'owner' AS owner, s.last_busy_at
       FROM project_hosts h
       JOIN LATERAL (
         SELECT MAX(collected_at) FILTER (WHERE running_project_count > 0)
                  AS last_busy_at,
                BOOL_OR(collected_at <= NOW() - make_interval(days => $1::int)
                          + make_interval(hours => $2::int)
                        AND collected_at >= NOW() - make_interval(days => $1::int))
                  AS reported_at_window_start
           FROM project_host_metrics_samples
          WHERE host_id = h.id
       ) s ON TRUE
      WHERE h.deleted IS NULL
        AND h.bay_id = $4
        AND h.status = 'running'
        AND h.tier IS NULL
        AND h.metadata->>'owner' IS NOT NULL
        AND COALESCE(h.metadata#>>'{billing,funding_mode}', '') <> 'site-funded'
        AND s.reported_at_window_start
        AND (s.last_busy_at IS NULL
             OR s.last_busy_at < NOW() - make_interval(days => $1::int))
      ORDER BY s.last_busy_at NULLS FIRST, h.id
      LIMIT $3`,
    [
      IDLE_HOST_DAYS,
      IDLE_HOST_WINDOW_START_TOLERANCE_HOURS,
      HOSTS_LIMIT,
      bay_id,
    ],
  );
  return rows.map((row) => ({
    host_id: `${row.id}`,
    name: row.name ?? null,
    owner: row.owner ?? null,
    last_busy_at: toIso(row.last_busy_at),
  }));
}

// Host checks cover only hosts this bay is responsible for: a rehomed host's
// row stays behind in the source bay's database.
export async function getBillingExposureHealth({
  bay_id,
}: {
  bay_id: string;
}): Promise<BillingExposureHealth> {
  // The metrics table is created on first use; make sure it exists before the
  // read-only transaction queries it.
  await ensureProjectHostMetricsSamplesSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = '${BILLING_EXPOSURE_STATEMENT_TIMEOUT_MS}ms'`,
    );
    const balances = await getBalanceExposure(client);
    const stuck_hosts = await getStuckHosts(client, bay_id, Date.now());
    const idle_hosts = await getIdleHosts(client, bay_id);
    await client.query("COMMIT");
    return { ...balances, stuck_hosts, idle_hosts };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
