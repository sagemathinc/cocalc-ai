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
import { getData as getGcpPricingData } from "@cocalc/gcloud-pricing-calculator";

export type DedicatedHostFundingLane = "prepaid" | "credit";

export interface DedicatedHostWindowUsageSnapshot {
  prepaid_5h_usd: MoneyValue;
  prepaid_7d_usd: MoneyValue;
  credit_5h_usd: MoneyValue;
  credit_7d_usd: MoneyValue;
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
  if (!toDecimal(snapshot.min_balance ?? 0).lt(0)) return false;
  if (
    toDecimal(snapshot.balance ?? 0).lte(toDecimal(snapshot.min_balance ?? 0))
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

type OpenHostPurchaseRow = {
  id: number;
  cost_per_hour: string | null;
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
      SELECT id, cost_per_hour, description
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

export async function closeDedicatedHostPurchaseSessionLocal({
  account_id,
  host_id,
  ended_at,
  client,
}: AccountLocalCloseDedicatedHostPurchaseSessionRequest & {
  client?: PoolClient;
}): Promise<void> {
  const pool = client ?? getPool();
  await pool.query(
    `
      UPDATE purchases
      SET period_end = COALESCE($4::timestamp, NOW())
      WHERE account_id=$1
        AND service=$2
        AND tag=$3
        AND period_end IS NULL
    `,
    [account_id, "dedicated-host", purchaseTag(host_id), ended_at ?? null],
  );
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

function regionFromZone(zone?: string | null): string | undefined {
  const text = `${zone ?? ""}`.trim();
  if (!text) return undefined;
  const idx = text.lastIndexOf("-");
  if (idx <= 0) return undefined;
  return text.slice(0, idx);
}

function mapGcpDiskType({
  disk_type,
  storage_mode,
}: {
  disk_type?: string | null;
  storage_mode?: string | null;
}): string | undefined {
  if (storage_mode === "ephemeral") return "local-ssd";
  switch (`${disk_type ?? ""}`.trim()) {
    case "standard":
      return "pd-standard";
    case "balanced":
      return "pd-balanced";
    case "ssd":
      return "pd-ssd";
    default:
      return undefined;
  }
}

async function estimateGcpRateUsdPerHour(
  input: DedicatedHostRateEstimateInput,
): Promise<MoneyValue | undefined> {
  const region =
    `${input.region ?? ""}`.trim() || regionFromZone(input.zone) || "";
  const machineType = `${input.machine_type ?? ""}`.trim();
  if (!region || !machineType) return undefined;
  const pricingModel = input.pricing_model === "spot" ? "spot" : "prices";
  const data = await getGcpPricingData();
  const machineRate =
    data?.machineTypes?.[machineType]?.[pricingModel]?.[region];
  if (!Number.isFinite(machineRate)) return undefined;
  let total = toDecimal(machineRate);
  const gpuType = `${input.gpu_type ?? ""}`.trim();
  const gpuCount = Number(input.gpu_count ?? 0);
  const zone = `${input.zone ?? ""}`.trim();
  if (gpuType && gpuCount > 0 && zone) {
    const gpuRate =
      data?.accelerators?.[gpuType]?.[pricingModel]?.[zone] ??
      data?.accelerators?.[gpuType]?.prices?.[zone];
    if (!Number.isFinite(gpuRate)) return undefined;
    total = total.add(toDecimal(gpuRate).mul(gpuCount));
  }
  const diskType = mapGcpDiskType(input);
  const diskGb = Number(input.disk_gb ?? 0);
  if (diskType && diskGb > 0) {
    const diskRate = data?.disks?.[diskType]?.prices?.[region];
    if (!Number.isFinite(diskRate)) return undefined;
    total = total.add(toDecimal(diskRate).mul(diskGb));
  }
  return moneyToDbString(total);
}

type NebiusInstanceType = {
  name: string;
  platform?: string | null;
  platform_label?: string | null;
  vcpus?: number | null;
  memory_gib?: number | null;
  gpus?: number | null;
};

type NebiusPriceItem = {
  product: string;
  region: string;
  price_usd: string;
  unit: string;
};

function normalizeNebiusPricingToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeNebiusPricingProduct(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^preemptible\s+/i, "");
  normalized = normalized.replace(/\.\s*(cpu|ram|gpu)$/i, "");
  return normalizeNebiusPricingToken(normalized);
}

function getNebiusPlatformAliases(platform?: string | null): string[] {
  if (!platform) return [];
  const aliases: string[] = [];
  const value = platform.toLowerCase();
  if (value.includes("h100")) aliases.push("h100 nvlink");
  if (value.includes("h200")) aliases.push("h200 nvlink");
  if (value.includes("b200")) aliases.push("b200 nvlink");
  if (value.includes("b300")) aliases.push("b300 nvlink");
  if (value.includes("l40s")) aliases.push("l40s pcie");
  return aliases;
}

function matchesNebiusPriceFamily(
  instance: NebiusInstanceType,
  family: string,
): boolean {
  const normalizedFamily = normalizeNebiusPricingToken(family);
  const candidates = [
    instance.platform_label,
    instance.platform,
    ...getNebiusPlatformAliases(instance.platform),
  ]
    .filter(Boolean)
    .map((value) => normalizeNebiusPricingToken(String(value)))
    .filter(Boolean);
  return candidates.some(
    (candidate) =>
      normalizedFamily.includes(candidate) ||
      candidate.includes(normalizedFamily),
  );
}

async function loadNebiusPriceItems(): Promise<NebiusPriceItem[]> {
  const { rows } = await getPool("medium").query(
    `
      SELECT payload
      FROM cloud_catalog_cache
      WHERE provider=$1
        AND kind=$2
      ORDER BY updated DESC
      LIMIT 1
    `,
    ["nebius", "prices"],
  );
  const payload = rows[0]?.payload;
  return Array.isArray(payload) ? payload : [];
}

function selectNebiusFamilyRate({
  prices,
  region,
  pricing_model,
  instance,
}: {
  prices: NebiusPriceItem[];
  region: string;
  pricing_model?: "on_demand" | "spot" | null;
  instance: NebiusInstanceType;
}): {
  family: string;
  cpuRate?: MoneyValue;
  ramRate?: MoneyValue;
  gpuRate?: MoneyValue;
} | null {
  const wantPreemptible = pricing_model === "spot";
  const matching = prices.filter((item) => {
    if (item.region !== region || !item.product || !item.unit) return false;
    const isPreemptible = /^preemptible\s+/i.test(item.product);
    if (isPreemptible !== wantPreemptible) return false;
    return true;
  });
  const families = new Map<string, NebiusPriceItem[]>();
  for (const item of matching) {
    const family = normalizeNebiusPricingProduct(item.product);
    if (!family) continue;
    const list = families.get(family) ?? [];
    list.push(item);
    families.set(family, list);
  }
  for (const [family, items] of families) {
    if ((instance.gpus ?? 0) > 0) {
      if (!/^nvidia\b/i.test(items[0]?.product ?? "")) continue;
      if (!matchesNebiusPriceFamily(instance, family)) continue;
    } else {
      if (!/^non-gpu\b/i.test(items[0]?.product ?? "")) continue;
      if (!matchesNebiusPriceFamily(instance, family)) continue;
    }
    return {
      family,
      cpuRate: items.find((item) => item.unit === "vCPU hour")?.price_usd,
      ramRate: items.find((item) => item.unit === "GiB hour")?.price_usd,
      gpuRate: items.find((item) => item.unit === "GPU hour")?.price_usd,
    };
  }
  if ((instance.gpus ?? 0) <= 0) {
    const fallback = Array.from(families.entries()).find(([family]) =>
      family.startsWith("non gpu"),
    );
    if (fallback) {
      return {
        family: fallback[0],
        cpuRate: fallback[1].find((item) => item.unit === "vCPU hour")
          ?.price_usd,
        ramRate: fallback[1].find((item) => item.unit === "GiB hour")
          ?.price_usd,
      };
    }
  }
  return null;
}

function nebiusDiskProductForType(
  disk_type?: string | null,
): string | undefined {
  switch (`${disk_type ?? ""}`.trim()) {
    case "standard":
      return "Network HDD disk";
    case "balanced":
      return "Network SSD Non-replicated disk";
    case "ssd":
      return "Network SSD disk";
    case "ssd_io_m3":
      return "Network SSD IO M3 disk";
    default:
      return undefined;
  }
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
  const instance = (instances as NebiusInstanceType[]).find(
    (entry) => entry.name === machineType,
  );
  if (!instance) return undefined;
  const family = selectNebiusFamilyRate({
    prices,
    region,
    pricing_model: input.pricing_model,
    instance,
  });
  if (!family?.cpuRate || !family?.ramRate) return undefined;
  let total = toDecimal(family.cpuRate)
    .mul(instance.vcpus ?? 0)
    .add(toDecimal(family.ramRate).mul(instance.memory_gib ?? 0));
  if ((instance.gpus ?? 0) > 0) {
    if (!family.gpuRate) return undefined;
    total = total.add(toDecimal(family.gpuRate).mul(instance.gpus ?? 0));
  }
  const diskGb = Number(input.disk_gb ?? 0);
  const diskProduct = nebiusDiskProductForType(input.disk_type);
  if (diskGb > 0 && diskProduct) {
    const diskRate = prices.find(
      (item) =>
        item.region === region &&
        item.unit === "GiB hour" &&
        item.product === diskProduct,
    )?.price_usd;
    if (!diskRate) return undefined;
    total = total.add(toDecimal(diskRate).mul(diskGb));
  }
  return moneyToDbString(total);
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
