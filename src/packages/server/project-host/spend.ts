/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  createInterBayAccountLocalClient,
  type AccountLocalCloseDedicatedHostPurchaseSessionRequest,
  type AccountLocalDedicatedHostPolicySnapshot,
  type AccountLocalReconcileDedicatedHostPurchaseSessionRequest,
} from "@cocalc/conat/inter-bay/api";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { loadNebiusInstanceTypes } from "@cocalc/server/cloud/providers";
import { getNextClosingDateAfter } from "@cocalc/server/purchases/closing-date";
import createPurchase from "@cocalc/server/purchases/create-purchase";
import {
  DEDICATED_HOST_USAGE,
  type DedicatedHostPurchase,
} from "@cocalc/util/db-schema/purchases";
import {
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  applyDedicatedHostSurchargeToHourlyRate,
  estimateGcpCatalogRateUsdPerHour,
  estimateNebiusCatalogRateUsdPerHour,
  getDedicatedHostSurchargeFraction,
  type GcpCatalogPrices,
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
  storage_mode?: string | null;
  gpu_type?: string | null;
  gpu_count?: number | null;
  pricing_model?: "on_demand" | "spot" | null;
}

const WINDOW_5H_HOURS = 5;
const WINDOW_7D_HOURS = 24 * 7;
const HOST_PURCHASE_TAG_PREFIX = "dedicated-host:";

function purchaseTag(host_id: string): string {
  return `${HOST_PURCHASE_TAG_PREFIX}${host_id}`;
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
  if (!snapshot.has_payment_method || !snapshot.has_usage_subscription) {
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
  const { rows } = await getPool("medium").query(
    `
      WITH usage_5h AS (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN description->>'funding_lane' = 'prepaid'
                THEN cost_per_hour * GREATEST(
                  0::numeric,
                  EXTRACT(
                    EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                    - GREATEST(period_start, NOW() - ($2::int * INTERVAL '1 hour'))
                  )::numeric / 3600
                )
                ELSE 0::numeric
              END
            ),
            0::numeric
          ) AS prepaid_5h_usd,
          COALESCE(
            SUM(
              CASE
                WHEN description->>'funding_lane' = 'credit'
                THEN cost_per_hour * GREATEST(
                  0::numeric,
                  EXTRACT(
                    EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                    - GREATEST(period_start, NOW() - ($2::int * INTERVAL '1 hour'))
                  )::numeric / 3600
                )
                ELSE 0::numeric
              END
            ),
            0::numeric
          ) AS credit_5h_usd
        FROM purchases
        WHERE account_id = $1
          AND service = $3
          AND cost_per_hour IS NOT NULL
          AND period_start IS NOT NULL
          AND COALESCE(period_end, NOW()) > NOW() - ($2::int * INTERVAL '1 hour')
      ),
      usage_7d AS (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN description->>'funding_lane' = 'prepaid'
                THEN cost_per_hour * GREATEST(
                  0::numeric,
                  EXTRACT(
                    EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                    - GREATEST(period_start, NOW() - ($4::int * INTERVAL '1 hour'))
                  )::numeric / 3600
                )
                ELSE 0::numeric
              END
            ),
            0::numeric
          ) AS prepaid_7d_usd,
          COALESCE(
            SUM(
              CASE
                WHEN description->>'funding_lane' = 'credit'
                THEN cost_per_hour * GREATEST(
                  0::numeric,
                  EXTRACT(
                    EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                    - GREATEST(period_start, NOW() - ($4::int * INTERVAL '1 hour'))
                  )::numeric / 3600
                )
                ELSE 0::numeric
              END
            ),
            0::numeric
          ) AS credit_7d_usd
        FROM purchases
        WHERE account_id = $1
          AND service = $3
          AND cost_per_hour IS NOT NULL
          AND period_start IS NOT NULL
          AND COALESCE(period_end, NOW()) > NOW() - ($4::int * INTERVAL '1 hour')
      )
      SELECT *
      FROM usage_5h
      CROSS JOIN usage_7d
    `,
    [account_id, WINDOW_5H_HOURS, "dedicated-host", WINDOW_7D_HOURS],
  );
  return moneyMap(rows[0]);
}

export async function getDedicatedHostWindowUsageForHostLocal({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id: string;
}): Promise<DedicatedHostOwnerWindowUsageSnapshot> {
  const { rows } = await getPool("medium").query(
    `
      WITH usage_5h AS (
        SELECT COALESCE(
          SUM(
            cost_per_hour * GREATEST(
              0::numeric,
              EXTRACT(
                EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                - GREATEST(period_start, NOW() - ($3::int * INTERVAL '1 hour'))
              )::numeric / 3600
            )
          ),
          0::numeric
        ) AS spend_5h_usd
        FROM purchases
        WHERE account_id = $1
          AND service = $2
          AND tag = $5
          AND cost_per_hour IS NOT NULL
          AND period_start IS NOT NULL
          AND COALESCE(period_end, NOW()) > NOW() - ($3::int * INTERVAL '1 hour')
      ),
      usage_7d AS (
        SELECT COALESCE(
          SUM(
            cost_per_hour * GREATEST(
              0::numeric,
              EXTRACT(
                EPOCH FROM LEAST(COALESCE(period_end, NOW()), NOW())
                - GREATEST(period_start, NOW() - ($4::int * INTERVAL '1 hour'))
              )::numeric / 3600
            )
          ),
          0::numeric
        ) AS spend_7d_usd
        FROM purchases
        WHERE account_id = $1
          AND service = $2
          AND tag = $5
          AND cost_per_hour IS NOT NULL
          AND period_start IS NOT NULL
          AND COALESCE(period_end, NOW()) > NOW() - ($4::int * INTERVAL '1 hour')
      )
      SELECT *
      FROM usage_5h
      CROSS JOIN usage_7d
    `,
    [
      account_id,
      "dedicated-host",
      WINDOW_5H_HOURS,
      WINDOW_7D_HOURS,
      purchaseTag(host_id),
    ],
  );
  return hostMoneyMap(rows[0]);
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
            cost_per_hour * GREATEST(
              0::numeric,
              EXTRACT(EPOCH FROM ($2::timestamp - period_start))::numeric / 3600
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
    notes: DEDICATED_HOST_USAGE,
  });
}

export async function rotateDedicatedHostPostpaidSegmentForClosingDateLocal({
  account_id,
  host_id,
  through,
  client,
}: {
  account_id: string;
  host_id: string;
  through?: Date;
  client?: PoolClient;
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
  const nextClosingDate = await getNextClosingDateAfter(
    account_id,
    periodStart,
  );
  if (nextClosingDate > now) {
    return;
  }
  await finalizeDedicatedHostPurchaseRowByIdLocal({
    purchase_id: newest.id,
    ended_at: nextClosingDate,
    client,
  });
  await insertDedicatedHostPurchaseSegmentLocal({
    account_id,
    host_id,
    description: newest.description,
    cost_per_hour: newest.cost_per_hour,
    period_start: nextClosingDate,
    client,
  });
}

export async function closeDedicatedHostPurchaseSessionLocal({
  account_id,
  host_id,
  ended_at,
  client,
}: AccountLocalCloseDedicatedHostPurchaseSessionRequest & {
  client?: PoolClient;
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
      const nextClosingDate = await getNextClosingDateAfter(
        account_id,
        new Date(newest.period_start),
      );
      if (nextClosingDate <= now) {
        await finalizeDedicatedHostPurchaseRowByIdLocal({
          purchase_id: newest.id,
          ended_at: nextClosingDate,
          client,
        });
        await insertDedicatedHostPurchaseSegmentLocal({
          account_id,
          host_id,
          description: newest.description,
          cost_per_hour: newest.cost_per_hour,
          period_start: nextClosingDate,
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

export async function reconcileDedicatedHostPurchaseSessionLocal({
  account_id,
  host_id,
  host_name,
  host_bay_id,
  provider,
  region,
  machine_type,
  pricing_model,
  funding_lane,
  hourly_cost_usd,
  started_at,
  client,
}: AccountLocalReconcileDedicatedHostPurchaseSessionRequest & {
  client?: PoolClient;
}): Promise<void> {
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
    newest.description?.funding_lane === funding_lane
  ) {
    if (funding_lane === "credit") {
      await rotateDedicatedHostPostpaidSegmentForClosingDateLocal({
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
  await closeDedicatedHostPurchaseSessionLocal({
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
    machine_type: machine_type ?? null,
    pricing_model: pricing_model ?? null,
    funding_lane,
    hourly_cost_usd: normalizedRate,
  };
  await createPurchase({
    account_id,
    service: "dedicated-host",
    description,
    client: client ?? null,
    cost_per_hour: normalizedRate,
    period_start:
      started_at == null
        ? new Date()
        : new Date(started_at as string | number | Date),
    tag: purchaseTag(host_id),
    notes: DEDICATED_HOST_USAGE,
  });
  if (funding_lane === "credit") {
    await rotateDedicatedHostPostpaidSegmentForClosingDateLocal({
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

async function estimateGcpRateUsdPerHour(
  input: DedicatedHostRateEstimateInput,
): Promise<MoneyValue | undefined> {
  const data = await loadGcpPriceCatalog();
  const settings = await getServerSettings();
  const estimate = applyDedicatedHostSurchargeToHourlyRate(
    estimateGcpCatalogRateUsdPerHour(data, input),
    getDedicatedHostSurchargeFraction("gcp", settings),
  );
  return estimate == null ? undefined : moneyToDbString(estimate);
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

async function estimateNebiusRateUsdPerHour(
  input: DedicatedHostRateEstimateInput,
): Promise<MoneyValue | undefined> {
  const region = `${input.region ?? ""}`.trim();
  const machineType = `${input.machine_type ?? ""}`.trim();
  if (!region || !machineType) return undefined;
  const [instances, prices] = await Promise.all([
    loadNebiusInstanceTypes(),
    loadNebiusPriceItems(),
  ]);
  const instance = (instances as NebiusCatalogInstanceType[]).find(
    (entry) => entry.name === machineType,
  );
  if (!instance) return undefined;
  const settings = await getServerSettings();
  const estimate = applyDedicatedHostSurchargeToHourlyRate(
    estimateNebiusCatalogRateUsdPerHour({
      prices,
      region,
      pricing_model: input.pricing_model,
      instance,
      disk_type: input.disk_type,
      disk_gb: input.disk_gb,
      storage_mode: input.storage_mode,
    }),
    getDedicatedHostSurchargeFraction("nebius", settings),
  );
  return estimate == null ? undefined : moneyToDbString(estimate);
}

export async function estimateDedicatedHostRateUsdPerHour(
  input: DedicatedHostRateEstimateInput,
): Promise<MoneyValue | undefined> {
  switch (`${input.provider ?? ""}`.trim()) {
    case "gcp":
      return await estimateGcpRateUsdPerHour(input);
    case "nebius":
      return await estimateNebiusRateUsdPerHour(input);
    default:
      return undefined;
  }
}
