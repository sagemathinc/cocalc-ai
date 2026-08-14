/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAccountLocalClient,
  type AccountLocalCloseDedicatedHostPurchaseSessionRequest,
  type AccountLocalDedicatedHostPolicySnapshot,
  type AccountLocalRecordDedicatedHostMeteredUsageRequest,
  type AccountLocalRecordDedicatedHostMeteredUsageResult,
  type AccountLocalReconcileDedicatedHostPurchaseSessionRequest,
} from "@cocalc/conat/inter-bay/api";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { loadNebiusInstanceTypes } from "@cocalc/server/cloud/providers";
import { nextCalendarMonthStartAfter } from "@cocalc/server/purchases/billing-period";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import {
  type DedicatedHostPurchase,
  type DedicatedHostPricingSnapshot,
} from "@cocalc/util/db-schema/purchases";
import {
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  ensureAccountUsageWindowsForEvent,
  getActiveAccountUsageWindows,
} from "@cocalc/server/membership/usage-windows";
import { isTrustedAdminPostpaid } from "./funding-policy";
import {
  applyDedicatedHostSurchargeToBreakdown,
  estimateGcpCatalogRateBreakdown,
  estimateNebiusCatalogRateBreakdown,
  getDedicatedHostSurchargeFraction,
  hostPriceBreakdownForBillingState,
  type DedicatedHostBillingState,
  type GcpCatalogPrices,
  type HostPriceBreakdown,
  type NebiusCatalogInstanceType,
  type NebiusCatalogPriceItem,
} from "@cocalc/util/project-host-pricing";

export type DedicatedHostFundingLane = "prepaid" | "credit";

export interface DedicatedHostWindowUsageSnapshot {
  prepaid_5h_usd: MoneyValue;
  prepaid_7d_usd: MoneyValue;
  credit_5h_usd: MoneyValue;
  credit_7d_usd: MoneyValue;
}

export interface DedicatedHostOwnerWindowUsageSnapshot {
  spend_5h_usd: MoneyValue;
  spend_7d_usd: MoneyValue;
}

export interface DedicatedHostRateEstimateInput {
  provider?: string | null;
  region?: string | null;
  zone?: string | null;
  machine_type?: string | null;
  disk_gb?: number | null;
  disk_type?: string | null;
  shared_disk_gb?: number | null;
  shared_disk_type?: string | null;
  storage_mode?: string | null;
  gpu_type?: string | null;
  gpu_count?: number | null;
  pricing_model?: "on_demand" | "spot" | null;
  billing_state?: DedicatedHostBillingState;
  operating_system?: "linux" | "windows" | null;
}

export interface DedicatedHostRateEstimate {
  hourly_cost_usd: MoneyValue;
  pricing_snapshot: DedicatedHostPricingSnapshot;
}

const HOST_PURCHASE_TAG_PREFIX = "dedicated-host:";
const METERED_PURCHASE_TAG_PREFIX = "dedicated-host-metered:";
const localPurchaseMutationTails = new Map<string, Promise<void>>();

function purchaseTag(host_id: string): string {
  return `${HOST_PURCHASE_TAG_PREFIX}${host_id}`;
}

function meteredPurchaseTag(resource_id: string, periodStart: Date): string {
  return `${METERED_PURCHASE_TAG_PREFIX}${resource_id}:${periodStart.toISOString().slice(0, 7)}`;
}

export function dedicatedHostRateFromPricingSnapshot({
  pricing_snapshot,
  billing_state,
}: {
  pricing_snapshot?: DedicatedHostPricingSnapshot | null;
  billing_state: DedicatedHostBillingState;
}): DedicatedHostRateEstimate | undefined {
  if (
    pricing_snapshot?.version !== 1 ||
    !Array.isArray(pricing_snapshot.components)
  ) {
    return undefined;
  }
  const components = pricing_snapshot.components.filter((component) =>
    component.billing_states?.includes(billing_state),
  );
  let total = toDecimal(0);
  try {
    for (const component of components) {
      const amount = toDecimal(component.hourly_cost_usd);
      if (amount.lt(0)) return undefined;
      total = total.add(amount);
    }
  } catch {
    return undefined;
  }
  const hourly_cost_usd = moneyToDbString(total);
  const configuration = { ...(pricing_snapshot.configuration ?? {}) };
  if (billing_state === "stopped") {
    delete configuration.machine_type;
    delete configuration.pricing_model;
  }
  return {
    hourly_cost_usd,
    pricing_snapshot: {
      version: 1,
      billing_state,
      hourly_cost_usd,
      components,
      configuration,
    },
  };
}

async function withDedicatedHostPurchaseMutation<T>({
  account_id,
  host_id,
  client,
  fn,
}: {
  account_id: string;
  host_id: string;
  client?: PoolClient;
  fn: (client: PoolClient) => Promise<T>;
}): Promise<T> {
  const mutationKey = `${account_id}:${host_id}`;
  const previous = localPurchaseMutationTails.get(mutationKey);
  let releaseLocal!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => current);
  localPurchaseMutationTails.set(mutationKey, tail);
  await previous;
  try {
    if (client) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [account_id, purchaseTag(host_id)],
      );
      return await fn(client);
    }
    const transactionClient = await getPool().connect();
    try {
      await transactionClient.query("BEGIN");
      await transactionClient.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [account_id, purchaseTag(host_id)],
      );
      const result = await fn(transactionClient);
      await transactionClient.query("COMMIT");
      return result;
    } catch (err) {
      await transactionClient.query("ROLLBACK");
      throw err;
    } finally {
      transactionClient.release();
    }
  } finally {
    releaseLocal();
    if (localPurchaseMutationTails.get(mutationKey) === tail) {
      localPurchaseMutationTails.delete(mutationKey);
    }
  }
}

function hasPositiveLimit(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isLaneWindowAvailable({
  used,
  limit,
}: {
  used: MoneyValue;
  limit: unknown;
}): boolean {
  if (!hasPositiveLimit(limit)) return true;
  return toDecimal(used).lt(toDecimal(limit as number));
}

function moneyMap(row: any): DedicatedHostWindowUsageSnapshot {
  return {
    prepaid_5h_usd: moneyToDbString(row?.prepaid_5h_usd ?? 0),
    prepaid_7d_usd: moneyToDbString(row?.prepaid_7d_usd ?? 0),
    credit_5h_usd: moneyToDbString(row?.credit_5h_usd ?? 0),
    credit_7d_usd: moneyToDbString(row?.credit_7d_usd ?? 0),
  };
}

function addWindowUsage(
  left: DedicatedHostWindowUsageSnapshot,
  right: DedicatedHostWindowUsageSnapshot,
): DedicatedHostWindowUsageSnapshot {
  return {
    prepaid_5h_usd: moneyToDbString(
      toDecimal(left.prepaid_5h_usd).add(right.prepaid_5h_usd),
    ),
    prepaid_7d_usd: moneyToDbString(
      toDecimal(left.prepaid_7d_usd).add(right.prepaid_7d_usd),
    ),
    credit_5h_usd: moneyToDbString(
      toDecimal(left.credit_5h_usd).add(right.credit_5h_usd),
    ),
    credit_7d_usd: moneyToDbString(
      toDecimal(left.credit_7d_usd).add(right.credit_7d_usd),
    ),
  };
}

function hostMoneyMap(row: any): DedicatedHostOwnerWindowUsageSnapshot {
  return {
    spend_5h_usd: moneyToDbString(row?.spend_5h_usd ?? 0),
    spend_7d_usd: moneyToDbString(row?.spend_7d_usd ?? 0),
  };
}

export function isDedicatedHostLaneCurrentlyAllowed({
  snapshot,
  funding_lane,
}: {
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
  funding_lane: DedicatedHostFundingLane;
}): boolean {
  const limits = snapshot.effective_limits ?? {};
  const usage = snapshot.dedicated_host_window_usage;
  if (funding_lane === "prepaid") {
    if (snapshot.funding_mode !== "account-prepaid") {
      return false;
    }
    if (toDecimal(snapshot.balance ?? 0).lte(0)) return false;
    return (
      isLaneWindowAvailable({
        used: usage.prepaid_5h_usd,
        limit: limits.prepaid_host_usage_limit_5h_usd,
      }) &&
      isLaneWindowAvailable({
        used: usage.prepaid_7d_usd,
        limit: limits.prepaid_host_usage_limit_7d_usd,
      })
    );
  }
  if (snapshot.funding_mode !== "account-postpaid") {
    return false;
  }
  if (
    !isTrustedAdminPostpaid(snapshot) &&
    (!snapshot.has_payment_method || !snapshot.has_usage_subscription)
  ) {
    return false;
  }
  if (
    !hasPositiveLimit(limits.credit_spend_limit_5h_usd) &&
    !hasPositiveLimit(limits.credit_spend_limit_7d_usd)
  ) {
    return false;
  }
  return (
    isLaneWindowAvailable({
      used: usage.credit_5h_usd,
      limit: limits.credit_spend_limit_5h_usd,
    }) &&
    isLaneWindowAvailable({
      used: usage.credit_7d_usd,
      limit: limits.credit_spend_limit_7d_usd,
    })
  );
}

export async function getDedicatedHostWindowUsageLocal(
  account_id: string,
): Promise<DedicatedHostWindowUsageSnapshot> {
  const windows = await getDedicatedHostUsageWindows({
    account_id,
  });
  const window5h = windows["5h"];
  const window7d = windows["7d"];
  const { rows } = await getPool("medium").query(
    `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN $2::timestamptz IS NOT NULL
               AND description->>'funding_lane' = 'prepaid'
               AND ((cost IS NOT NULL AND time >= $2::timestamptz AND time < $3::timestamptz)
                 OR (cost_per_hour IS NOT NULL AND period_start < $3::timestamptz
                   AND COALESCE(period_end, NOW()) > $2::timestamptz))
              THEN COALESCE(cost, cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $3::timestamptz)
                  - GREATEST(period_start, $2::timestamptz)
                )::numeric / 3600
              ))
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS prepaid_5h_usd,
        COALESCE(
          SUM(
            CASE
              WHEN $4::timestamptz IS NOT NULL
               AND description->>'funding_lane' = 'prepaid'
               AND ((cost IS NOT NULL AND time >= $4::timestamptz AND time < $5::timestamptz)
                 OR (cost_per_hour IS NOT NULL AND period_start < $5::timestamptz
                   AND COALESCE(period_end, NOW()) > $4::timestamptz))
              THEN COALESCE(cost, cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $5::timestamptz)
                  - GREATEST(period_start, $4::timestamptz)
                )::numeric / 3600
              ))
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS prepaid_7d_usd,
        COALESCE(
          SUM(
            CASE
              WHEN $2::timestamptz IS NOT NULL
               AND description->>'funding_lane' = 'credit'
               AND ((cost IS NOT NULL AND time >= $2::timestamptz AND time < $3::timestamptz)
                 OR (cost_per_hour IS NOT NULL AND period_start < $3::timestamptz
                   AND COALESCE(period_end, NOW()) > $2::timestamptz))
              THEN COALESCE(cost, cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $3::timestamptz)
                  - GREATEST(period_start, $2::timestamptz)
                )::numeric / 3600
              ))
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS credit_5h_usd,
        COALESCE(
          SUM(
            CASE
              WHEN $4::timestamptz IS NOT NULL
               AND description->>'funding_lane' = 'credit'
               AND ((cost IS NOT NULL AND time >= $4::timestamptz AND time < $5::timestamptz)
                 OR (cost_per_hour IS NOT NULL AND period_start < $5::timestamptz
                   AND COALESCE(period_end, NOW()) > $4::timestamptz))
              THEN COALESCE(cost, cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $5::timestamptz)
                  - GREATEST(period_start, $4::timestamptz)
                )::numeric / 3600
              ))
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS credit_7d_usd
      FROM purchases
      WHERE account_id = $1
        AND service = $6
        AND description->>'resource_kind' IS DISTINCT FROM 'compute-egress'
        AND (cost_per_hour IS NOT NULL OR cost IS NOT NULL)
        AND period_start IS NOT NULL
        AND (
          ($2::timestamptz IS NOT NULL AND ((cost IS NOT NULL AND time >= $2::timestamptz AND time < $3::timestamptz) OR (cost_per_hour IS NOT NULL AND period_start < $3::timestamptz AND COALESCE(period_end, NOW()) > $2::timestamptz)))
          OR ($4::timestamptz IS NOT NULL AND ((cost IS NOT NULL AND time >= $4::timestamptz AND time < $5::timestamptz) OR (cost_per_hour IS NOT NULL AND period_start < $5::timestamptz AND COALESCE(period_end, NOW()) > $4::timestamptz)))
        )
    `,
    [
      account_id,
      window5h?.starts_at ?? null,
      window5h?.resets_at ?? null,
      window7d?.starts_at ?? null,
      window7d?.resets_at ?? null,
      "dedicated-host",
    ],
  );
  const { rows: egressRows } = await getPool("medium").query(
    `
      SELECT
        COALESCE(SUM(CASE
          WHEN $2::timestamptz IS NOT NULL AND funding_lane='prepaid'
            AND ended_at >= $2 AND ended_at < $3
          THEN amount_usd
          ELSE 0 END), 0) AS prepaid_5h_usd,
        COALESCE(SUM(CASE
          WHEN $4::timestamptz IS NOT NULL AND funding_lane='prepaid'
            AND ended_at >= $4 AND ended_at < $5
          THEN amount_usd
          ELSE 0 END), 0) AS prepaid_7d_usd,
        COALESCE(SUM(CASE
          WHEN $2::timestamptz IS NOT NULL AND funding_lane='credit'
            AND ended_at >= $2 AND ended_at < $3
          THEN amount_usd
          ELSE 0 END), 0) AS credit_5h_usd,
        COALESCE(SUM(CASE
          WHEN $4::timestamptz IS NOT NULL AND funding_lane='credit'
            AND ended_at >= $4 AND ended_at < $5
          THEN amount_usd
          ELSE 0 END), 0) AS credit_7d_usd
      FROM compute_egress_meter_intervals
      WHERE owner_account_id=$1
        AND (($2::timestamptz IS NOT NULL AND ended_at >= $2 AND ended_at < $3)
          OR ($4::timestamptz IS NOT NULL AND ended_at >= $4 AND ended_at < $5))
    `,
    [
      account_id,
      window5h?.starts_at ?? null,
      window5h?.resets_at ?? null,
      window7d?.starts_at ?? null,
      window7d?.resets_at ?? null,
    ],
  );
  return addWindowUsage(moneyMap(rows[0]), moneyMap(egressRows[0]));
}

export async function getDedicatedHostWindowUsageForHostLocal({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id: string;
}): Promise<DedicatedHostOwnerWindowUsageSnapshot> {
  const windows = await getDedicatedHostUsageWindows({
    account_id,
    host_id,
  });
  const window5h = windows["5h"];
  const window7d = windows["7d"];
  const { rows } = await getPool("medium").query(
    `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN $3::timestamptz IS NOT NULL
               AND period_start < $4::timestamptz
               AND COALESCE(period_end, NOW()) > $3::timestamptz
              THEN cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $4::timestamptz)
                  - GREATEST(period_start, $3::timestamptz)
                )::numeric / 3600
              )
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS spend_5h_usd,
        COALESCE(
          SUM(
            CASE
              WHEN $5::timestamptz IS NOT NULL
               AND period_start < $6::timestamptz
               AND COALESCE(period_end, NOW()) > $5::timestamptz
              THEN cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(
                  EPOCH FROM LEAST(COALESCE(period_end, NOW()), $6::timestamptz)
                  - GREATEST(period_start, $5::timestamptz)
                )::numeric / 3600
              )
              ELSE 0::numeric
            END
          ),
          0::numeric
        ) AS spend_7d_usd
      FROM purchases
      WHERE account_id = $1
        AND service = $2
        AND tag = $7
        AND cost_per_hour IS NOT NULL
        AND period_start IS NOT NULL
        AND (
          ($3::timestamptz IS NOT NULL AND period_start < $4::timestamptz AND COALESCE(period_end, NOW()) > $3::timestamptz)
          OR ($5::timestamptz IS NOT NULL AND period_start < $6::timestamptz AND COALESCE(period_end, NOW()) > $5::timestamptz)
        )
    `,
    [
      account_id,
      "dedicated-host",
      window5h?.starts_at ?? null,
      window5h?.resets_at ?? null,
      window7d?.starts_at ?? null,
      window7d?.resets_at ?? null,
      purchaseTag(host_id),
    ],
  );
  return hostMoneyMap(rows[0]);
}

async function getDedicatedHostUsageWindows({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id?: string;
}) {
  const existing = await getActiveAccountUsageWindows({ account_id });
  if (existing["5h"] && existing["7d"]) return existing;
  const hasActiveSpend = await hasOpenDedicatedHostSpend({
    account_id,
    host_id,
  });
  if (!hasActiveSpend) return existing;
  return await ensureAccountUsageWindowsForEvent({
    account_id,
    occurred_at: new Date(),
  });
}

async function hasOpenDedicatedHostSpend({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id?: string;
}): Promise<boolean> {
  const { rows } = await getPool("short").query(
    `
      SELECT 1
      FROM purchases
      WHERE account_id = $1
        AND service = $2
        AND period_start IS NOT NULL
        AND period_end IS NULL
        AND ($3::text IS NULL OR tag = $3)
      LIMIT 1
    `,
    [
      account_id,
      "dedicated-host",
      host_id == null ? null : purchaseTag(host_id),
    ],
  );
  return rows.length > 0;
}

type OpenHostPurchaseRow = {
  id: number;
  time: Date | string;
  cost_per_hour: string | null;
  period_start: Date | string | null;
  description: DedicatedHostPurchase | null;
};

async function listOpenDedicatedHostPurchasesLocal({
  account_id,
  host_id,
  client,
}: {
  account_id: string;
  host_id: string;
  client?: PoolClient;
}): Promise<OpenHostPurchaseRow[]> {
  const pool = client ?? getPool();
  const { rows } = await pool.query<OpenHostPurchaseRow>(
    `
      SELECT id, time, cost_per_hour, period_start, description
      FROM purchases
      WHERE account_id=$1
        AND service=$2
        AND tag=$3
        AND period_end IS NULL
      ORDER BY id DESC
    `,
    [account_id, "dedicated-host", purchaseTag(host_id)],
  );
  return rows;
}

export async function getDedicatedHostPostpaidUnbilledExposureLocal(
  account_id: string,
): Promise<MoneyValue> {
  const { rows } = await getPool("medium").query<{ exposure: string | null }>(
    `
      SELECT COALESCE(
        SUM(
          COALESCE(
            cost,
            cost_so_far,
            cost_per_hour * (
              EXTRACT(EPOCH FROM (COALESCE(period_end, NOW()) - period_start))::numeric / 3600
            )
          )
        ),
        0::numeric
      ) AS exposure
      FROM purchases
      WHERE account_id=$1
        AND service=$2
        AND description->>'funding_lane' = 'credit'
        AND month_statement_id IS NULL
    `,
    [account_id, "dedicated-host"],
  );
  return moneyToDbString(rows[0]?.exposure ?? 0);
}

function computeSegmentCost({
  cost_per_hour,
  period_start,
  period_end,
}: {
  cost_per_hour: MoneyValue;
  period_start: Date;
  period_end: Date;
}): MoneyValue {
  const hours =
    Math.max(0, period_end.valueOf() - period_start.valueOf()) / 3600_000;
  return moneyToDbString(toDecimal(cost_per_hour).mul(hours));
}

async function finalizeDedicatedHostPurchaseRowByIdLocal({
  purchase_id,
  ended_at,
  client,
}: {
  purchase_id: number;
  ended_at: Date;
  client?: PoolClient;
}): Promise<void> {
  const pool = client ?? getPool();
  await pool.query(
    `
      UPDATE purchases
      SET period_end = $2::timestamp,
          cost = COALESCE(
            cost,
            ROUND(
              cost_per_hour * GREATEST(
                0::numeric,
                EXTRACT(EPOCH FROM ($2::timestamp - period_start))::numeric / 3600
              ),
              2
            )
          )
      WHERE id=$1
    `,
    [purchase_id, ended_at],
  );
}

async function insertDedicatedHostPurchaseSegmentLocal({
  account_id,
  host_id,
  description,
  cost_per_hour,
  period_start,
  period_end,
  client,
}: {
  account_id: string;
  host_id: string;
  description: DedicatedHostPurchase;
  cost_per_hour: MoneyValue;
  period_start: Date;
  period_end?: Date;
  client?: PoolClient;
}): Promise<number> {
  return await createPurchase({
    account_id,
    time: period_start,
    service: "dedicated-host",
    description,
    client: client ?? null,
    cost:
      period_end == null
        ? undefined
        : computeSegmentCost({ cost_per_hour, period_start, period_end }),
    cost_per_hour,
    period_start,
    period_end,
    tag: purchaseTag(host_id),
  });
}

async function rotateDedicatedHostPostpaidSegmentForCalendarMonthUnlocked({
  account_id,
  host_id,
  through,
  client,
}: {
  account_id: string;
  host_id: string;
  through?: Date;
  client: PoolClient;
}): Promise<void> {
  const open = await listOpenDedicatedHostPurchasesLocal({
    account_id,
    host_id,
    client,
  });
  const newest = open[0];
  if (
    open.length !== 1 ||
    !newest?.period_start ||
    newest.description?.funding_lane !== "credit" ||
    !newest.cost_per_hour
  ) {
    return;
  }
  const now = through ?? new Date();
  const periodStart = new Date(newest.period_start);
  const nextPeriodStart = nextCalendarMonthStartAfter(periodStart);
  if (nextPeriodStart > now) {
    return;
  }
  await finalizeDedicatedHostPurchaseRowByIdLocal({
    purchase_id: newest.id,
    ended_at: nextPeriodStart,
    client,
  });
  await insertDedicatedHostPurchaseSegmentLocal({
    account_id,
    host_id,
    description: newest.description,
    cost_per_hour: newest.cost_per_hour,
    period_start: nextPeriodStart,
    client,
  });
}

export async function rotateDedicatedHostPostpaidSegmentForCalendarMonthLocal(opts: {
  account_id: string;
  host_id: string;
  through?: Date;
  client?: PoolClient;
}): Promise<void> {
  await withDedicatedHostPurchaseMutation({
    ...opts,
    fn: async (client) => {
      await rotateDedicatedHostPostpaidSegmentForCalendarMonthUnlocked({
        ...opts,
        client,
      });
    },
  });
}

async function closeDedicatedHostPurchaseSessionUnlocked({
  account_id,
  host_id,
  ended_at,
  client,
}: AccountLocalCloseDedicatedHostPurchaseSessionRequest & {
  client: PoolClient;
}): Promise<void> {
  const now = ended_at == null ? new Date() : new Date(ended_at as any);
  while (true) {
    const open = await listOpenDedicatedHostPurchasesLocal({
      account_id,
      host_id,
      client,
    });
    const newest = open[0];
    if (!newest) {
      return;
    }
    if (
      newest.description?.funding_lane === "credit" &&
      newest.period_start &&
      newest.cost_per_hour
    ) {
      const nextPeriodStart = nextCalendarMonthStartAfter(
        new Date(newest.period_start),
      );
      if (nextPeriodStart <= now) {
        await finalizeDedicatedHostPurchaseRowByIdLocal({
          purchase_id: newest.id,
          ended_at: nextPeriodStart,
          client,
        });
        await insertDedicatedHostPurchaseSegmentLocal({
          account_id,
          host_id,
          description: newest.description,
          cost_per_hour: newest.cost_per_hour,
          period_start: nextPeriodStart,
          period_end: now,
          client,
        });
        continue;
      }
    }
    await finalizeDedicatedHostPurchaseRowByIdLocal({
      purchase_id: newest.id,
      ended_at: now,
      client,
    });
    for (const stale of open.slice(1)) {
      await finalizeDedicatedHostPurchaseRowByIdLocal({
        purchase_id: stale.id,
        ended_at: now,
        client,
      });
    }
    return;
  }
}

export async function closeDedicatedHostPurchaseSessionLocal(
  opts: AccountLocalCloseDedicatedHostPurchaseSessionRequest & {
    client?: PoolClient;
  },
): Promise<void> {
  await withDedicatedHostPurchaseMutation({
    ...opts,
    fn: async (client) => {
      await closeDedicatedHostPurchaseSessionUnlocked({
        ...opts,
        client,
      });
    },
  });
}

async function reconcileDedicatedHostPurchaseSessionUnlocked({
  account_id,
  host_id,
  host_name,
  host_bay_id,
  provider,
  region,
  billing_state,
  machine_type,
  pricing_model,
  funding_lane,
  hourly_cost_usd,
  pricing_snapshot,
  started_at,
  client,
}: AccountLocalReconcileDedicatedHostPurchaseSessionRequest & {
  client: PoolClient;
}): Promise<void> {
  const periodStart =
    started_at == null
      ? new Date()
      : new Date(started_at as string | number | Date);
  const open = await listOpenDedicatedHostPurchasesLocal({
    account_id,
    host_id,
    client,
  });
  const normalizedRate = moneyToDbString(hourly_cost_usd);
  const newest = open[0];
  if (
    open.length === 1 &&
    newest &&
    moneyToDbString(newest.cost_per_hour ?? 0) === normalizedRate &&
    newest.description?.funding_lane === funding_lane &&
    newest.description?.billing_state === billing_state &&
    isDeepStrictEqual(
      newest.description?.pricing_snapshot ?? null,
      pricing_snapshot,
    )
  ) {
    if (funding_lane === "credit") {
      await rotateDedicatedHostPostpaidSegmentForCalendarMonthUnlocked({
        account_id,
        host_id,
        through:
          started_at == null
            ? new Date()
            : new Date(started_at as string | number | Date),
        client,
      });
    }
    return;
  }
  await closeDedicatedHostPurchaseSessionUnlocked({
    account_id,
    host_id,
    ended_at: started_at ?? null,
    client,
  });
  const description: DedicatedHostPurchase = {
    type: "dedicated-host",
    host_id,
    host_name: host_name ?? null,
    host_bay_id: host_bay_id ?? null,
    provider,
    region: region ?? null,
    billing_state,
    machine_type: billing_state === "running" ? (machine_type ?? null) : null,
    pricing_model: billing_state === "running" ? (pricing_model ?? null) : null,
    funding_lane,
    hourly_cost_usd: normalizedRate,
    pricing_snapshot,
  };
  await createPurchase({
    account_id,
    service: "dedicated-host",
    description,
    client: client ?? null,
    cost_per_hour: normalizedRate,
    period_start: periodStart,
    tag: purchaseTag(host_id),
  });
  if (funding_lane === "credit") {
    await rotateDedicatedHostPostpaidSegmentForCalendarMonthUnlocked({
      account_id,
      host_id,
      through:
        started_at == null
          ? new Date()
          : new Date(started_at as string | number | Date),
      client,
    });
  }
}

export async function reconcileDedicatedHostPurchaseSessionLocal(
  opts: AccountLocalReconcileDedicatedHostPurchaseSessionRequest & {
    client?: PoolClient;
  },
): Promise<void> {
  const periodStart =
    opts.started_at == null
      ? new Date()
      : new Date(opts.started_at as string | number | Date);
  await ensureAccountUsageWindowsForEvent({
    account_id: opts.account_id,
    occurred_at: periodStart,
  });
  if (periodStart.getTime() < Date.now()) {
    await ensureAccountUsageWindowsForEvent({
      account_id: opts.account_id,
      occurred_at: new Date(),
    });
  }
  await withDedicatedHostPurchaseMutation({
    ...opts,
    fn: async (client) => {
      await reconcileDedicatedHostPurchaseSessionUnlocked({
        ...opts,
        client,
      });
    },
  });
}

export async function reconcileDedicatedHostPurchaseSessionForAccount(
  opts: AccountLocalReconcileDedicatedHostPurchaseSessionRequest,
): Promise<void> {
  const location = await resolveAccountHomeBay({
    account_id: opts.account_id,
    user_account_id: opts.account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    await reconcileDedicatedHostPurchaseSessionLocal(opts);
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).reconcileDedicatedHostPurchaseSession(opts);
}

export async function closeDedicatedHostPurchaseSessionForAccount(
  opts: AccountLocalCloseDedicatedHostPurchaseSessionRequest,
): Promise<void> {
  const location = await resolveAccountHomeBay({
    account_id: opts.account_id,
    user_account_id: opts.account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    await closeDedicatedHostPurchaseSessionLocal(opts);
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).closeDedicatedHostPurchaseSession(opts);
}

export async function recordDedicatedHostMeteredUsageLocal(
  opts: AccountLocalRecordDedicatedHostMeteredUsageRequest,
): Promise<AccountLocalRecordDedicatedHostMeteredUsageResult> {
  const intervalStart = new Date(opts.interval_start);
  const intervalEnd = new Date(opts.interval_end);
  if (
    !Number.isFinite(intervalStart.getTime()) ||
    !Number.isFinite(intervalEnd.getTime()) ||
    intervalEnd < intervalStart ||
    (intervalEnd.valueOf() === intervalStart.valueOf() && !opts.finalize)
  ) {
    throw new Error("invalid dedicated-host metered usage interval");
  }
  const bytes = Math.floor(Number(opts.bytes));
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("invalid dedicated-host metered usage byte count");
  }
  if (bytes > 0) {
    await ensureAccountUsageWindowsForEvent({
      account_id: opts.account_id,
      occurred_at: intervalEnd,
    });
  }
  return await withDedicatedHostPurchaseMutation({
    account_id: opts.account_id,
    host_id: opts.resource_id,
    fn: async (client) => {
      const purchasePeriodStart = new Date(
        Date.UTC(
          intervalStart.getUTCFullYear(),
          intervalStart.getUTCMonth(),
          1,
        ),
      );
      const purchasePeriodEnd = nextCalendarMonthStartAfter(intervalStart);
      if (intervalEnd > purchasePeriodEnd) {
        throw new Error(
          "managed compute egress interval crosses a billing-month boundary",
        );
      }
      const tag = meteredPurchaseTag(opts.resource_id, purchasePeriodStart);
      const summary = await client.query<{
        first_started_at: Date | null;
        metered_through_at: Date | null;
        total_bytes: string;
        total_cost_usd: string;
      }>(
        `SELECT MIN(started_at) AS first_started_at,
                MAX(ended_at) AS metered_through_at,
                COALESCE(SUM(bytes), 0)::text AS total_bytes,
                COALESCE(SUM(amount_usd), 0)::text AS total_cost_usd
           FROM compute_egress_meter_intervals
          WHERE owner_account_id=$1 AND resource_id=$2`,
        [opts.account_id, opts.resource_id],
      );
      const before = summary.rows[0];
      const previousEnd = before?.metered_through_at
        ? new Date(before.metered_through_at)
        : undefined;
      const latestPurchase = await client.query<{
        id: number;
        cost: string | null;
        cost_so_far: string | null;
        period_start: Date;
        period_end: Date | null;
      }>(
        `SELECT id, cost, cost_so_far, period_start, period_end
           FROM purchases
          WHERE account_id=$1 AND service='dedicated-host' AND tag=$2
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [opts.account_id, tag],
      );
      const purchase = latestPurchase.rows[0];

      const result = ({ accepted }: { accepted: boolean }) => ({
        accepted,
        finalized: !!opts.finalize,
        metered_through_at: (previousEnd ?? intervalEnd).toISOString(),
        total_bytes: Number(before?.total_bytes ?? 0),
        total_cost_usd: moneyToDbString(before?.total_cost_usd ?? 0),
      });

      if (previousEnd) {
        if (intervalStart < previousEnd || intervalEnd <= previousEnd) {
          if (
            opts.finalize &&
            intervalEnd.valueOf() === previousEnd.valueOf() &&
            purchase &&
            purchase.cost == null
          ) {
            await client.query(
              `UPDATE purchases
                  SET cost=ROUND(cost_so_far, 2), cost_so_far=NULL,
                      period_end=$2
                WHERE id=$1`,
              [purchase.id, intervalEnd],
            );
          }
          return result({ accepted: false });
        }
        if (intervalStart.valueOf() !== previousEnd.valueOf()) {
          throw new Error(
            `managed compute egress interval gap: expected ${previousEnd.toISOString()}, got ${intervalStart.toISOString()}`,
          );
        }
      }
      if (purchase?.cost != null) {
        throw new Error("managed compute egress purchase is already finalized");
      }

      let inserted = false;
      if (intervalEnd > intervalStart) {
        const interval = await client.query<{ id: string }>(
          `INSERT INTO compute_egress_meter_intervals (
             id, owner_account_id, owning_bay_id, project_id, resource_id,
             funding_lane, bytes, amount_usd, started_at, ended_at, details,
             created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (resource_id,started_at,ended_at) DO NOTHING
           RETURNING id`,
          [
            randomUUID(),
            opts.account_id,
            getConfiguredBayId(),
            opts.project_id ?? null,
            opts.resource_id,
            opts.funding_lane,
            bytes,
            moneyToDbString(opts.cost_usd),
            intervalStart,
            intervalEnd,
            {
              provider: opts.provider,
              region: opts.region ?? null,
              unit_cost_usd_per_gb: moneyToDbString(opts.unit_cost_usd_per_gb),
            },
          ],
        );
        inserted = !!interval.rowCount;
      }

      const totals = await client.query<{
        first_started_at: Date;
        metered_through_at: Date;
        total_bytes: string;
        total_cost_usd: string;
      }>(
        `SELECT MIN(started_at) AS first_started_at,
                MAX(ended_at) AS metered_through_at,
                COALESCE(SUM(bytes), 0)::text AS total_bytes,
                COALESCE(SUM(amount_usd), 0)::text AS total_cost_usd
           FROM compute_egress_meter_intervals
          WHERE owner_account_id=$1 AND resource_id=$2`,
        [opts.account_id, opts.resource_id],
      );
      const total = totals.rows[0];
      const totalBytes = Number(total?.total_bytes ?? 0);
      const totalCost = moneyToDbString(total?.total_cost_usd ?? 0);
      const meteredThroughAt = total?.metered_through_at ?? intervalEnd;
      const periodTotals = await client.query<{
        first_started_at: Date;
        metered_through_at: Date;
        total_bytes: string;
        total_cost_usd: string;
      }>(
        `SELECT MIN(started_at) AS first_started_at,
                MAX(ended_at) AS metered_through_at,
                COALESCE(SUM(bytes), 0)::text AS total_bytes,
                COALESCE(SUM(amount_usd), 0)::text AS total_cost_usd
           FROM compute_egress_meter_intervals
          WHERE owner_account_id=$1 AND resource_id=$2
            AND started_at >= $3 AND ended_at <= $4`,
        [
          opts.account_id,
          opts.resource_id,
          purchasePeriodStart,
          purchasePeriodEnd,
        ],
      );
      const period = periodTotals.rows[0];
      const periodBytes = Number(period?.total_bytes ?? 0);
      const periodCost = moneyToDbString(period?.total_cost_usd ?? 0);
      const firstStartedAt = period?.first_started_at ?? intervalStart;
      const periodMeteredThroughAt = period?.metered_through_at ?? intervalEnd;
      const description: DedicatedHostPurchase = {
        type: "dedicated-host",
        host_id: opts.resource_id,
        host_name: opts.resource_name ?? null,
        host_bay_id: opts.resource_bay_id ?? null,
        provider: opts.provider,
        region: opts.region ?? null,
        funding_lane: opts.funding_lane,
        hourly_cost_usd: "0",
        resource_kind: "compute-egress",
        project_id: opts.project_id ?? null,
        usage_bytes: periodBytes,
        unit_cost_usd_per_gb: moneyToDbString(opts.unit_cost_usd_per_gb),
        usage_interval_start: firstStartedAt.toISOString(),
        usage_interval_end: periodMeteredThroughAt.toISOString(),
      };
      let purchaseId = purchase?.id;
      if (periodBytes > 0) {
        if (purchaseId == null) {
          purchaseId = await createPurchase({
            account_id: opts.account_id,
            project_id: opts.project_id ?? undefined,
            service: "dedicated-host",
            description,
            client,
            cost_so_far: periodCost,
            time: firstStartedAt,
            period_start: firstStartedAt,
            tag,
          });
        } else {
          await client.query(
            `UPDATE purchases
                SET cost_so_far=$2, description=$3
              WHERE id=$1 AND cost IS NULL`,
            [purchaseId, periodCost, description],
          );
        }
        await client.query(
          `UPDATE compute_egress_meter_intervals
              SET purchase_id=$3
            WHERE owner_account_id=$1 AND resource_id=$2
              AND purchase_id IS NULL
              AND started_at >= $4 AND ended_at <= $5`,
          [
            opts.account_id,
            opts.resource_id,
            purchaseId,
            purchasePeriodStart,
            purchasePeriodEnd,
          ],
        );
      }
      const finalizePurchase =
        !!opts.finalize ||
        intervalEnd.valueOf() === purchasePeriodEnd.valueOf();
      if (finalizePurchase && purchaseId != null) {
        await client.query(
          `UPDATE purchases
              SET cost=ROUND(cost_so_far, 2), cost_so_far=NULL, period_end=$2,
                  description=$3
            WHERE id=$1 AND cost IS NULL`,
          [purchaseId, periodMeteredThroughAt, description],
        );
      }
      return {
        accepted: inserted,
        finalized: !!opts.finalize,
        metered_through_at: meteredThroughAt.toISOString(),
        total_bytes: totalBytes,
        total_cost_usd: totalCost,
      };
    },
  });
}

export async function recordDedicatedHostMeteredUsageForAccount(
  opts: AccountLocalRecordDedicatedHostMeteredUsageRequest,
): Promise<AccountLocalRecordDedicatedHostMeteredUsageResult> {
  const location = await resolveAccountHomeBay({
    account_id: opts.account_id,
    user_account_id: opts.account_id,
  });
  const home_bay_id =
    `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (home_bay_id === getConfiguredBayId()) {
    return await recordDedicatedHostMeteredUsageLocal(opts);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home_bay_id,
  }).recordDedicatedHostMeteredUsage(opts);
}

async function loadGcpPriceCatalog(): Promise<GcpCatalogPrices | undefined> {
  const { rows } = await getPool("medium").query(
    `
      SELECT payload
      FROM cloud_catalog_cache
      WHERE provider=$1
        AND kind=$2
      ORDER BY fetched_at DESC NULLS LAST
      LIMIT 1
    `,
    ["gcp", "prices"],
  );
  const payload = rows[0]?.payload;
  return payload && typeof payload === "object"
    ? (payload as GcpCatalogPrices)
    : undefined;
}

async function estimateGcpRateBreakdown(
  input: DedicatedHostRateEstimateInput,
): Promise<HostPriceBreakdown | undefined> {
  const data = await loadGcpPriceCatalog();
  const settings = await getServerSettings();
  return hostPriceBreakdownForBillingState(
    applyDedicatedHostSurchargeToBreakdown(
      estimateGcpCatalogRateBreakdown(data, input),
      getDedicatedHostSurchargeFraction("gcp", settings),
    ),
    input.billing_state ?? "running",
  );
}

async function estimateNebiusRateBreakdown(
  input: DedicatedHostRateEstimateInput,
): Promise<HostPriceBreakdown | undefined> {
  const region = `${input.region ?? ""}`.trim();
  const machineType = `${input.machine_type ?? ""}`.trim();
  if (!region) return undefined;
  const [instances, prices] = await Promise.all([
    loadNebiusInstanceTypes(),
    loadNebiusPriceItems(),
  ]);
  const instance = machineType
    ? (instances as NebiusCatalogInstanceType[]).find(
        (entry) => entry.name === machineType,
      )
    : undefined;
  if (machineType && !instance) return undefined;
  const settings = await getServerSettings();
  const estimated = estimateNebiusCatalogRateBreakdown({
    prices,
    region,
    pricing_model: input.pricing_model,
    instance,
    disk_type: input.disk_type,
    disk_gb: input.disk_gb,
    shared_disk_type: input.shared_disk_type,
    shared_disk_gb: input.shared_disk_gb,
    storage_mode: input.storage_mode,
  });
  return hostPriceBreakdownForBillingState(
    applyDedicatedHostSurchargeToBreakdown(
      estimated,
      getDedicatedHostSurchargeFraction("nebius", settings),
    ),
    input.billing_state ?? "running",
  );
}

function pricingConfiguration(
  input: DedicatedHostRateEstimateInput,
): DedicatedHostPricingSnapshot["configuration"] {
  const billingState = input.billing_state ?? "running";
  return {
    ...(billingState === "running"
      ? {
          machine_type: input.machine_type ?? null,
          pricing_model: input.pricing_model ?? null,
          operating_system: input.operating_system ?? "linux",
        }
      : {}),
    disk_gb: input.disk_gb ?? null,
    disk_type: input.disk_type ?? null,
    shared_disk_gb: input.shared_disk_gb ?? null,
    shared_disk_type: input.shared_disk_type ?? null,
    storage_mode: input.storage_mode ?? null,
  };
}

export async function estimateDedicatedHostRate(
  input: DedicatedHostRateEstimateInput,
): Promise<DedicatedHostRateEstimate | undefined> {
  const billingState = input.billing_state ?? "running";
  const breakdown = await (async () => {
    switch (`${input.provider ?? ""}`.trim()) {
      case "gcp":
        return await estimateGcpRateBreakdown(input);
      case "nebius":
        return await estimateNebiusRateBreakdown(input);
      default:
        return undefined;
    }
  })();
  if (!breakdown) {
    return undefined;
  }
  const hourly_cost_usd = moneyToDbString(breakdown.total_usd_per_hour);
  return {
    hourly_cost_usd,
    pricing_snapshot: {
      version: 1,
      billing_state: billingState,
      hourly_cost_usd,
      components: breakdown.items.map((item) => ({
        key: item.key,
        label: item.label,
        hourly_cost_usd: moneyToDbString(item.usd_per_hour),
        billing_states: item.billing_states,
      })),
      configuration: pricingConfiguration(input),
    },
  };
}

export async function estimateDedicatedHostRateUsdPerHour(
  input: DedicatedHostRateEstimateInput,
): Promise<MoneyValue | undefined> {
  return (await estimateDedicatedHostRate(input))?.hourly_cost_usd;
}
async function loadNebiusPriceItems(): Promise<NebiusCatalogPriceItem[]> {
  const { rows } = await getPool("medium").query(
    `
      SELECT payload
      FROM cloud_catalog_cache
      WHERE provider=$1
        AND kind=$2
      ORDER BY fetched_at DESC NULLS LAST
      LIMIT 1
    `,
    ["nebius", "prices"],
  );
  const payload = rows[0]?.payload;
  return Array.isArray(payload) ? payload : [];
}
