import { GoogleAuth } from "google-auth-library";
import type {
  GcpCatalogPrices,
  GcpDiskCatalogKey,
  GcpFamilyPriceCatalogEntry,
  GcpGpuCatalogKey,
  GcpGpuPriceCatalogEntry,
  GcpPricingFamily,
} from "@cocalc/util/project-host-pricing";

const COMPUTE_ENGINE_SERVICE_ID = "6F81-5844-456A";
const BYTES_PER_GIB = 1024 ** 3;
const SECONDS_PER_HOUR = 60 * 60;

type BillingSku = {
  description?: string;
  serviceRegions?: string[];
  category?: {
    resourceFamily?: string;
    resourceGroup?: string;
    usageType?: string;
  };
  pricingInfo?: Array<{
    effectiveTime?: string;
    pricingExpression?: {
      usageUnit?: string;
      baseUnit?: string;
      baseUnitConversionFactor?: number | string;
      tieredRates?: Array<{
        startUsageAmount?: number;
        unitPrice?: {
          units?: string | number;
          nanos?: number;
        };
      }>;
    };
  }>;
};

type GcpPricingFetchOptions = {
  credentials: any;
};

const GCP_FAMILY_PATTERNS: Array<{
  family: GcpPricingFamily;
  cpu: RegExp;
  ram: RegExp;
}> = [
  {
    family: "t2d",
    cpu: /^(?:Spot Preemptible )?T2D AMD Instance Core running in /i,
    ram: /^(?:Spot Preemptible )?T2D AMD Instance Ram running in /i,
  },
  {
    family: "n2d",
    cpu: /^(?:Spot Preemptible )?N2D AMD Instance Core running in /i,
    ram: /^(?:Spot Preemptible )?N2D AMD Instance Ram running in /i,
  },
  {
    family: "c3",
    cpu: /^(?:Spot Preemptible )?C3 Instance Core running in /i,
    ram: /^(?:Spot Preemptible )?C3 Instance Ram running in /i,
  },
];

const GCP_GPU_PATTERNS: Array<{
  key: GcpGpuCatalogKey;
  pattern: RegExp;
}> = [
  { key: "nvidia-tesla-t4", pattern: /^Nvidia Tesla T4 GPU /i },
  { key: "nvidia-l4", pattern: /^Nvidia L4 GPU /i },
  { key: "nvidia-tesla-a100", pattern: /^Nvidia Tesla A100 GPU /i },
  { key: "nvidia-a100-80gb", pattern: /^Nvidia A100 80GB GPU /i },
  {
    key: "nvidia-h100-80gb",
    pattern: /^Nvidia H100 80GB(?: Mega)? GPU /i,
  },
];

const GCP_DISK_PATTERNS: Array<{
  key: GcpDiskCatalogKey;
  pattern: RegExp;
}> = [
  { key: "pd-standard", pattern: /^Storage PD Capacity(?: in |$)/i },
  { key: "pd-balanced", pattern: /^Balanced PD Capacity(?: in |$)/i },
  { key: "pd-ssd", pattern: /^SSD backed PD Capacity(?: in |$)/i },
];

function getUnitPriceUsd(sku: BillingSku): number | undefined {
  const tier = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.find(
    (entry) => Number(entry.startUsageAmount ?? 0) === 0,
  );
  const unitPrice = tier?.unitPrice;
  if (!unitPrice) return undefined;
  return Number(unitPrice.units ?? 0) + Number(unitPrice.nanos ?? 0) / 1e9;
}

export function getHourlyRateUsd(sku: BillingSku): number | undefined {
  const unitPrice = getUnitPriceUsd(sku);
  const expr = sku.pricingInfo?.[0]?.pricingExpression;
  if (unitPrice == null || !Number.isFinite(unitPrice) || !expr) {
    return undefined;
  }
  const usageUnit = `${expr.usageUnit ?? ""}`.trim();
  const baseUnit = `${expr.baseUnit ?? ""}`.trim();
  const factor = Number(expr.baseUnitConversionFactor ?? 0);
  if (usageUnit === "h" || usageUnit === "GiBy.h") {
    return unitPrice;
  }
  if (
    usageUnit === "GiBy.mo" &&
    baseUnit === "By.s" &&
    Number.isFinite(factor) &&
    factor > 0
  ) {
    return (unitPrice * BYTES_PER_GIB * SECONDS_PER_HOUR) / factor;
  }
  return undefined;
}

function getSkuRegion(sku: BillingSku): string | undefined {
  return sku.serviceRegions?.find(Boolean);
}

function familyRateEntry(
  catalog: GcpCatalogPrices,
  family: GcpPricingFamily,
): GcpFamilyPriceCatalogEntry {
  const existing = catalog.families[family];
  if (existing) return existing;
  const created: GcpFamilyPriceCatalogEntry = {
    cpu: {},
    ram: {},
    spot_cpu: {},
    spot_ram: {},
  };
  catalog.families[family] = created;
  return created;
}

function gpuRateEntry(
  catalog: GcpCatalogPrices,
  key: GcpGpuCatalogKey,
): GcpGpuPriceCatalogEntry {
  const existing = catalog.gpus[key];
  if (existing) return existing;
  const created: GcpGpuPriceCatalogEntry = { on_demand: {}, spot: {} };
  catalog.gpus[key] = created;
  return created;
}

async function getCloudBillingAccessToken(credentials: any): Promise<string> {
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-billing.readonly"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return `${token.token ?? token}`;
}

async function fetchBillingSkus(credentials: any): Promise<BillingSku[]> {
  const token = await getCloudBillingAccessToken(credentials);
  const headers = { Authorization: `Bearer ${token}` };
  const skus: BillingSku[] = [];
  let pageToken = "";
  while (true) {
    const url = new URL(
      `https://cloudbilling.googleapis.com/v1/services/${COMPUTE_ENGINE_SERVICE_ID}/skus`,
    );
    url.searchParams.set("pageSize", "5000");
    url.searchParams.set("currencyCode", "USD");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(
        `failed to fetch GCP billing catalog: HTTP ${resp.status} ${await resp.text()}`,
      );
    }
    const data = await resp.json();
    if (Array.isArray(data?.skus)) {
      skus.push(...data.skus);
    }
    pageToken = `${data?.nextPageToken ?? ""}`;
    if (!pageToken) break;
  }
  return skus;
}

export async function fetchGcpCatalogPrices(
  opts: GcpPricingFetchOptions,
): Promise<GcpCatalogPrices> {
  const skus = await fetchBillingSkus(opts.credentials);
  const catalog: GcpCatalogPrices = {
    fetched_at: new Date().toISOString(),
    service_id: COMPUTE_ENGINE_SERVICE_ID,
    families: {},
    gpus: {},
    disks: {},
  };
  for (const sku of skus) {
    const description = `${sku.description ?? ""}`.trim();
    if (!description) continue;
    const usageType = `${sku.category?.usageType ?? ""}`;
    if (usageType !== "OnDemand" && usageType !== "Preemptible") continue;
    const region = getSkuRegion(sku);
    const price = getHourlyRateUsd(sku);
    if (!region || price == null || !Number.isFinite(price)) continue;
    if (!catalog.effective_time && sku.pricingInfo?.[0]?.effectiveTime) {
      catalog.effective_time = sku.pricingInfo[0].effectiveTime;
    }
    let matched = false;
    for (const family of GCP_FAMILY_PATTERNS) {
      if (family.cpu.test(description)) {
        const entry = familyRateEntry(catalog, family.family);
        (usageType === "Preemptible" ? entry.spot_cpu : entry.cpu)[region] =
          price;
        matched = true;
        break;
      }
      if (family.ram.test(description)) {
        const entry = familyRateEntry(catalog, family.family);
        (usageType === "Preemptible" ? entry.spot_ram : entry.ram)[region] =
          price;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const gpu of GCP_GPU_PATTERNS) {
      if (!gpu.pattern.test(description)) continue;
      const entry = gpuRateEntry(catalog, gpu.key);
      (usageType === "Preemptible" ? entry.spot : entry.on_demand)[region] =
        price;
      matched = true;
      break;
    }
    if (matched) continue;
    if (usageType !== "OnDemand") continue;
    for (const disk of GCP_DISK_PATTERNS) {
      if (!disk.pattern.test(description)) continue;
      const entry = catalog.disks[disk.key] ?? {};
      entry[region] = price;
      catalog.disks[disk.key] = entry;
      break;
    }
  }
  return catalog;
}
