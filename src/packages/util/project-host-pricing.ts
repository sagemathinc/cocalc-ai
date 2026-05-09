/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const SUPPORTED_GCP_MACHINE_TYPE_PREFIXES = [
  "t2a-standard-",
  "t2d-standard-",
  "n2d-standard-",
  "n2d-highmem-",
  "c3-highcpu-",
  "c3-standard-",
  "c3-highmem-",
  "c3d-standard-",
  "c3d-highcpu-",
  "c3d-highmem-",
] as const;

export type SupportedGcpMachineTypePrefix =
  (typeof SUPPORTED_GCP_MACHINE_TYPE_PREFIXES)[number];

export type GcpPricingFamily = "t2a" | "t2d" | "n2d" | "c3" | "c3d";

export type GcpPriceRateMap = Record<string, number>;

export interface GcpFamilyPriceCatalogEntry {
  cpu: GcpPriceRateMap;
  ram: GcpPriceRateMap;
  spot_cpu: GcpPriceRateMap;
  spot_ram: GcpPriceRateMap;
}

export type GcpGpuCatalogKey =
  | "nvidia-tesla-t4"
  | "nvidia-l4"
  | "nvidia-tesla-a100"
  | "nvidia-a100-80gb"
  | "nvidia-h100-80gb";

export interface GcpGpuPriceCatalogEntry {
  on_demand: GcpPriceRateMap;
  spot: GcpPriceRateMap;
}

export type GcpDiskCatalogKey = "pd-standard" | "pd-balanced" | "pd-ssd";

export interface GcpCatalogPrices {
  fetched_at: string;
  service_id: string;
  effective_time?: string;
  families: Partial<Record<GcpPricingFamily, GcpFamilyPriceCatalogEntry>>;
  gpus: Partial<Record<GcpGpuCatalogKey, GcpGpuPriceCatalogEntry>>;
  disks: Partial<Record<GcpDiskCatalogKey, GcpPriceRateMap>>;
}

export type HostPricingModel = "on_demand" | "spot";

export type HostPriceBreakdownItemKey = "vm" | "gpu" | "disk" | "public_ipv4";

export type HostPriceBreakdownItem = {
  key: HostPriceBreakdownItemKey;
  label: string;
  usd_per_hour: number;
};

export type HostPriceBreakdown = {
  items: HostPriceBreakdownItem[];
  total_usd_per_hour: number;
};

export type DedicatedHostPricedProvider = "gcp" | "nebius";

export type DedicatedHostSurchargeSettings = {
  project_hosts_gcp_surcharge_percent?: number | null;
  project_hosts_nebius_surcharge_percent?: number | null;
};

export type GcpCatalogRateEstimateInput = {
  region?: string | null;
  zone?: string | null;
  machine_type?: string | null;
  cpu_count?: number | null;
  memory_gib?: number | null;
  disk_gb?: number | null;
  disk_type?: string | null;
  storage_mode?: string | null;
  gpu_type?: string | null;
  gpu_count?: number | null;
  pricing_model?: HostPricingModel | null;
};

export type NebiusCatalogPriceItem = {
  product: string;
  region: string;
  price_usd: string;
  unit: string;
};

export type NebiusCatalogInstanceType = {
  name: string;
  platform?: string | null;
  platform_label?: string | null;
  vcpus?: number | null;
  memory_gib?: number | null;
  gpus?: number | null;
  gpu_label?: string | null;
};

const GCP_PUBLIC_IPV4_HOURLY_USD = {
  on_demand: 0.005,
  spot: 0.0025,
} as const;

function normalizeSurchargeFraction(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric / 100;
}

export function getDedicatedHostSurchargeFraction(
  provider: DedicatedHostPricedProvider,
  settings?: DedicatedHostSurchargeSettings | null,
): number {
  if (provider === "gcp") {
    return normalizeSurchargeFraction(
      settings?.project_hosts_gcp_surcharge_percent,
    );
  }
  return normalizeSurchargeFraction(
    settings?.project_hosts_nebius_surcharge_percent,
  );
}

export function applyDedicatedHostSurchargeToBreakdown(
  breakdown: HostPriceBreakdown | undefined,
  surchargeFraction?: number | null,
): HostPriceBreakdown | undefined {
  if (!breakdown) return undefined;
  const fraction =
    typeof surchargeFraction === "number" && Number.isFinite(surchargeFraction)
      ? surchargeFraction
      : 0;
  if (fraction <= 0) return breakdown;
  const factor = 1 + fraction;
  const items = breakdown.items.map((item) => ({
    ...item,
    usd_per_hour: item.usd_per_hour * factor,
  }));
  return {
    items,
    total_usd_per_hour: breakdown.total_usd_per_hour * factor,
  };
}

export function applyDedicatedHostSurchargeToHourlyRate(
  rate: number | undefined,
  surchargeFraction?: number | null,
): number | undefined {
  if (rate == null || !Number.isFinite(rate)) return undefined;
  const fraction =
    typeof surchargeFraction === "number" && Number.isFinite(surchargeFraction)
      ? surchargeFraction
      : 0;
  if (fraction <= 0) return rate;
  return rate * (1 + fraction);
}

function isNebiusGpuProductLabel(value?: string | null): boolean {
  return /^(?:preemptible\s+)?nvidia\b/i.test(`${value ?? ""}`.trim());
}

function isNebiusCpuProductLabel(value?: string | null): boolean {
  return /^(?:preemptible\s+)?non-gpu\b/i.test(`${value ?? ""}`.trim());
}

const GCP_MACHINE_TYPE_FAMILY_RULES: Array<{
  family: GcpPricingFamily;
  prefixes: readonly SupportedGcpMachineTypePrefix[];
}> = [
  { family: "t2a", prefixes: ["t2a-standard-"] },
  { family: "t2d", prefixes: ["t2d-standard-"] },
  { family: "n2d", prefixes: ["n2d-standard-", "n2d-highmem-"] },
  { family: "c3", prefixes: ["c3-highcpu-", "c3-standard-", "c3-highmem-"] },
  {
    family: "c3d",
    prefixes: ["c3d-standard-", "c3d-highcpu-", "c3d-highmem-"],
  },
];

export function isSupportedCatalogGcpMachineType(
  name?: string | null,
): boolean {
  const value = `${name ?? ""}`.trim().toLowerCase();
  if (!value) return false;
  return SUPPORTED_GCP_MACHINE_TYPE_PREFIXES.some((prefix) =>
    value.startsWith(prefix),
  );
}

export function gcpPricingFamilyForMachineType(
  name?: string | null,
): GcpPricingFamily | undefined {
  const value = `${name ?? ""}`.trim().toLowerCase();
  if (!value) return undefined;
  for (const rule of GCP_MACHINE_TYPE_FAMILY_RULES) {
    if (rule.prefixes.some((prefix) => value.startsWith(prefix))) {
      return rule.family;
    }
  }
  return undefined;
}

export function gcpCatalogMachineTypeSortKey(name?: string | null): string {
  const value = `${name ?? ""}`.trim().toLowerCase();
  const cpuMatch = value.match(/-(\d+)$/);
  const cpu = cpuMatch ? Number(cpuMatch[1]) : Number.MAX_SAFE_INTEGER;
  const family = gcpPricingFamilyForMachineType(value) ?? "zzz";
  return `${family}:${String(cpu).padStart(4, "0")}:${value}`;
}

export function gcpCpuCountForMachineType(
  name?: string | null,
): number | undefined {
  const value = `${name ?? ""}`.trim().toLowerCase();
  const cpuMatch = value.match(/-(\d+)$/);
  if (!cpuMatch) return undefined;
  const cpu = Number(cpuMatch[1]);
  return Number.isFinite(cpu) && cpu > 0 ? cpu : undefined;
}

export function gcpMemoryGiBForMachineType(
  name?: string | null,
): number | undefined {
  const cpu = gcpCpuCountForMachineType(name);
  if (!cpu) return undefined;
  const value = `${name ?? ""}`.trim().toLowerCase();
  const gibPerCpu = value.includes("-highmem-")
    ? 8
    : value.includes("-highcpu-")
      ? 2
      : 4;
  return cpu * gibPerCpu;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readRate(
  map: Record<string, number> | undefined,
  key: string,
): number | undefined {
  const value = map?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function gcpRegionFromZone(zone?: string | null): string | undefined {
  const text = `${zone ?? ""}`.trim();
  if (!text) return undefined;
  const idx = text.lastIndexOf("-");
  if (idx <= 0) return undefined;
  return text.slice(0, idx);
}

export function gcpDiskCatalogKeyFromSelection(input: {
  disk_type?: string | null;
  storage_mode?: string | null;
}): GcpDiskCatalogKey | undefined {
  if (`${input.storage_mode ?? ""}`.trim() === "ephemeral") {
    return undefined;
  }
  switch (`${input.disk_type ?? ""}`.trim()) {
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

export function estimateGcpCatalogRateUsdPerHour(
  catalog: GcpCatalogPrices | undefined,
  input: GcpCatalogRateEstimateInput,
): number | undefined {
  return estimateGcpCatalogRateBreakdown(catalog, input)?.total_usd_per_hour;
}

export function estimateGcpCatalogRateBreakdown(
  catalog: GcpCatalogPrices | undefined,
  input: GcpCatalogRateEstimateInput,
): HostPriceBreakdown | undefined {
  const region =
    `${input.region ?? ""}`.trim() || gcpRegionFromZone(input.zone) || "";
  const machineType = `${input.machine_type ?? ""}`.trim();
  if (!catalog || !region || !machineType) return undefined;
  const family = gcpPricingFamilyForMachineType(machineType);
  if (!family) return undefined;
  const familyEntry = catalog.families?.[family];
  if (!familyEntry) return undefined;
  const pricingModel = input.pricing_model === "spot" ? "spot" : "on_demand";
  const cpuRate = readRate(
    pricingModel === "spot" ? familyEntry.spot_cpu : familyEntry.cpu,
    region,
  );
  const ramRate = readRate(
    pricingModel === "spot" ? familyEntry.spot_ram : familyEntry.ram,
    region,
  );
  const cpus =
    typeof input.cpu_count === "number" && Number.isFinite(input.cpu_count)
      ? input.cpu_count
      : gcpCpuCountForMachineType(machineType);
  const memoryGiB =
    typeof input.memory_gib === "number" && Number.isFinite(input.memory_gib)
      ? input.memory_gib
      : gcpMemoryGiBForMachineType(machineType);
  if (
    !isFinitePositiveNumber(cpuRate) ||
    !isFinitePositiveNumber(ramRate) ||
    !cpus ||
    !memoryGiB
  ) {
    return undefined;
  }
  const items: HostPriceBreakdownItem[] = [
    {
      key: "vm",
      label: "VM",
      usd_per_hour: cpuRate * cpus + ramRate * memoryGiB,
    },
  ];
  const gpuType = `${input.gpu_type ?? ""}`.trim() as GcpGpuCatalogKey;
  const gpuCount = Number(input.gpu_count ?? 0);
  if (gpuType && gpuCount > 0) {
    const gpuEntry = catalog.gpus?.[gpuType];
    const gpuRate = readRate(
      pricingModel === "spot" ? gpuEntry?.spot : gpuEntry?.on_demand,
      region,
    );
    if (!isFinitePositiveNumber(gpuRate)) return undefined;
    items.push({
      key: "gpu",
      label: "GPU",
      usd_per_hour: gpuRate * gpuCount,
    });
  }
  const diskType = gcpDiskCatalogKeyFromSelection(input);
  const diskGb = Number(input.disk_gb ?? 0);
  if (diskType && diskGb > 0) {
    const diskRate = readRate(catalog.disks?.[diskType], region);
    if (!isFinitePositiveNumber(diskRate)) return undefined;
    items.push({
      key: "disk",
      label: "Persistent disk",
      usd_per_hour: diskRate * diskGb,
    });
  }
  items.push({
    key: "public_ipv4",
    label: "Public IPv4",
    usd_per_hour: GCP_PUBLIC_IPV4_HOURLY_USD[pricingModel],
  });
  return {
    items,
    total_usd_per_hour: items.reduce((sum, item) => sum + item.usd_per_hour, 0),
  };
}

export function normalizeNebiusPricingToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeNebiusPricingProduct(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^preemptible\s+/i, "");
  normalized = normalized.replace(/\.\s*(cpu|ram|gpu)$/i, "");
  return normalizeNebiusPricingToken(normalized);
}

export function getNebiusPlatformAliases(platform?: string | null): string[] {
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
  instance: NebiusCatalogInstanceType,
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

function nebiusHourlyUnitRate(item: NebiusCatalogPriceItem | undefined) {
  if (!item) return undefined;
  const price = Number(item.price_usd);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  const unit = `${item.unit ?? ""}`.trim();
  if (/gpu hour$/i.test(unit)) return price;
  if (/(?:vcpu|cpu) hour$/i.test(unit)) return price;
  if (/gib hour$/i.test(unit)) return price;
  const monthMatch = unit.match(/gib per (\d+) hours/i);
  if (monthMatch) {
    const hours = Number(monthMatch[1]);
    return Number.isFinite(hours) && hours > 0 ? price / hours : undefined;
  }
  return undefined;
}

function selectNebiusFamilyRate(opts: {
  prices: NebiusCatalogPriceItem[];
  region: string;
  pricing_model?: HostPricingModel | null;
  instance: NebiusCatalogInstanceType;
}):
  | {
      family: string;
      cpuRate?: number;
      ramRate?: number;
      gpuRate?: number;
    }
  | undefined {
  const wantPreemptible = opts.pricing_model === "spot";
  const matching = opts.prices.filter((item) => {
    if (item.region !== opts.region || !item.product || !item.unit) {
      return false;
    }
    const isPreemptible = /^preemptible\s+/i.test(item.product);
    return isPreemptible === wantPreemptible;
  });
  const families = new Map<string, NebiusCatalogPriceItem[]>();
  for (const item of matching) {
    const family = normalizeNebiusPricingProduct(item.product);
    if (!family) continue;
    const list = families.get(family) ?? [];
    list.push(item);
    families.set(family, list);
  }
  for (const [family, items] of families) {
    if ((opts.instance.gpus ?? 0) > 0) {
      if (!isNebiusGpuProductLabel(items[0]?.product)) continue;
      if (!matchesNebiusPriceFamily(opts.instance, family)) continue;
    } else {
      if (!isNebiusCpuProductLabel(items[0]?.product)) continue;
      if (!matchesNebiusPriceFamily(opts.instance, family)) continue;
    }
    return {
      family,
      cpuRate: nebiusHourlyUnitRate(
        items.find((item) => /(?:vcpu|cpu) hour$/i.test(item.unit)),
      ),
      ramRate: nebiusHourlyUnitRate(
        items.find((item) => /gib hour$/i.test(item.unit)),
      ),
      gpuRate: nebiusHourlyUnitRate(
        items.find((item) => /gpu hour$/i.test(item.unit)),
      ),
    };
  }
  if ((opts.instance.gpus ?? 0) <= 0) {
    const fallback = Array.from(families.entries()).find(([family]) =>
      family.startsWith("non gpu"),
    );
    if (fallback) {
      return {
        family: fallback[0],
        cpuRate: nebiusHourlyUnitRate(
          fallback[1].find((item) => /(?:vcpu|cpu) hour$/i.test(item.unit)),
        ),
        ramRate: nebiusHourlyUnitRate(
          fallback[1].find((item) => /gib hour$/i.test(item.unit)),
        ),
      };
    }
  }
  return undefined;
}

export function estimateNebiusCatalogRateUsdPerHour(opts: {
  prices: NebiusCatalogPriceItem[];
  region?: string | null;
  pricing_model?: HostPricingModel | null;
  instance?: NebiusCatalogInstanceType | null;
  disk_type?: string | null;
  disk_gb?: number | null;
  storage_mode?: string | null;
}): number | undefined {
  return estimateNebiusCatalogRateBreakdown(opts)?.total_usd_per_hour;
}

export function estimateNebiusCatalogRateBreakdown(opts: {
  prices: NebiusCatalogPriceItem[];
  region?: string | null;
  pricing_model?: HostPricingModel | null;
  instance?: NebiusCatalogInstanceType | null;
  disk_type?: string | null;
  disk_gb?: number | null;
  storage_mode?: string | null;
}): HostPriceBreakdown | undefined {
  const region = `${opts.region ?? ""}`.trim();
  const instance = opts.instance ?? undefined;
  if (!region || !instance) return undefined;
  const family = selectNebiusFamilyRate({
    prices: opts.prices,
    region,
    pricing_model: opts.pricing_model,
    instance,
  });
  if (
    !isFinitePositiveNumber(family?.cpuRate) ||
    !isFinitePositiveNumber(family?.ramRate)
  ) {
    return undefined;
  }
  const items: HostPriceBreakdownItem[] = [
    {
      key: "vm",
      label: "VM",
      usd_per_hour:
        family.cpuRate * Number(instance.vcpus ?? 0) +
        family.ramRate * Number(instance.memory_gib ?? 0),
    },
  ];
  if ((instance.gpus ?? 0) > 0) {
    if (!isFinitePositiveNumber(family.gpuRate)) return undefined;
    items.push({
      key: "gpu",
      label: "GPU",
      usd_per_hour: family.gpuRate * Number(instance.gpus ?? 0),
    });
  }
  if (`${opts.storage_mode ?? "persistent"}`.trim() === "persistent") {
    const diskGb = Number(opts.disk_gb ?? 0);
    const diskProduct = nebiusDiskProductForType(opts.disk_type);
    if (diskGb > 0 && diskProduct) {
      const diskRate = nebiusHourlyUnitRate(
        opts.prices.find(
          (item) =>
            item.region === region &&
            item.product === diskProduct &&
            /gib/i.test(item.unit),
        ),
      );
      if (!isFinitePositiveNumber(diskRate)) return undefined;
      items.push({
        key: "disk",
        label: "Persistent disk",
        usd_per_hour: diskRate * diskGb,
      });
    }
  }
  return {
    items,
    total_usd_per_hour: items.reduce((sum, item) => sum + item.usd_per_hour, 0),
  };
}
