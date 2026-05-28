import getLogger from "@cocalc/backend/logger";
import { normalizeNebiusPricingToken } from "@cocalc/util/project-host-pricing";
import { NebiusClient, type NebiusCreds } from "../nebius/client";
import type {
  CatalogEntry,
  NebiusImage,
  NebiusInstanceType,
  NebiusPriceItem,
} from "./types";
import type {
  Image,
  Platform,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";
import {
  ListImagesRequest,
  ListPublicRequest,
  ListPlatformsRequest,
} from "@nebius/js-sdk/api/nebius/compute/v1/index";
import { Long } from "@nebius/js-sdk/runtime/protos/index";
import { fetchNebiusPricingFromDocs } from "./nebius-pricing";

const logger = getLogger("cloud:catalog:nebius");

type DocumentedNebiusPlatform = {
  platform: string;
  platform_label: string;
  regions: string[];
  allowed_for_preemptibles: boolean;
  price_aliases: string[];
  presets: Array<{
    name: string;
    vcpus: number;
    memory_gib: number;
    gpus: number;
  }>;
};

// Nebius' platform API can lag behind the public image and pricing catalogs for
// newly launched GPU platforms. Keep a documented fallback so the host catalog
// can expose platform/preset pairs once region images and prices are visible.
const DOCUMENTED_GPU_PLATFORMS: DocumentedNebiusPlatform[] = [
  {
    platform: "gpu-b300-sxm",
    platform_label: "NVIDIA® B300 NVLink",
    regions: ["uk-south1"],
    allowed_for_preemptibles: true,
    price_aliases: ["NVIDIA B300 NVLink"],
    presets: [
      { name: "1gpu-24vcpu-346gb", vcpus: 24, memory_gib: 346, gpus: 1 },
      { name: "8gpu-192vcpu-2768gb", vcpus: 192, memory_gib: 2768, gpus: 8 },
    ],
  },
  {
    platform: "gpu-b200-sxm",
    platform_label: "NVIDIA® B200 NVLink",
    regions: ["us-central1"],
    allowed_for_preemptibles: true,
    price_aliases: ["NVIDIA B200 NVLink"],
    presets: [
      { name: "1gpu-20vcpu-224gb", vcpus: 20, memory_gib: 224, gpus: 1 },
      { name: "8gpu-160vcpu-1792gb", vcpus: 160, memory_gib: 1792, gpus: 8 },
    ],
  },
  {
    platform: "gpu-b200-sxm-a",
    platform_label: "NVIDIA® B200 NVLink",
    regions: ["me-west1"],
    allowed_for_preemptibles: true,
    price_aliases: ["NVIDIA B200 NVLink"],
    presets: [
      { name: "1gpu-20vcpu-224gb", vcpus: 20, memory_gib: 224, gpus: 1 },
      { name: "8gpu-160vcpu-1792gb", vcpus: 160, memory_gib: 1792, gpus: 8 },
    ],
  },
  {
    platform: "gpu-rtx6000",
    platform_label: "NVIDIA® RTX PRO™ 6000",
    regions: ["us-central1"],
    allowed_for_preemptibles: true,
    price_aliases: ["NVIDIA RTX PRO 6000", "NVIDIA RTX 6000"],
    presets: [
      { name: "1gpu-24vcpu-218gb", vcpus: 24, memory_gib: 218, gpus: 1 },
      { name: "8gpu-192vcpu-1744gb", vcpus: 192, memory_gib: 1744, gpus: 8 },
    ],
  },
];

// Snapshot of Nebius console pricing table (from nebius.html).
const NEBIUS_CONSOLE_PRICES: NebiusPriceItem[] = [
  {
    service: "Compute",
    product: "NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "eu-north1",
    price_usd: "3.5",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA H100 NVLink with Intel Sapphire Rapids",
    region: "eu-north1",
    price_usd: "2.95",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with Intel Ice Lake. GPU",
    region: "eu-north1",
    price_usd: "1.35",
    unit: "GPU hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with Intel Ice Lake. CPU",
    region: "eu-north1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with Intel Ice Lake. RAM",
    region: "eu-north1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with AMD Epyc Genoa. GPU",
    region: "eu-north1",
    price_usd: "1.35",
    unit: "GPU hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with AMD Epyc Genoa. CPU",
    region: "eu-north1",
    price_usd: "0.01",
    unit: "vCPU hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "NVIDIA L40S PCIe with AMD Epyc Genoa. RAM",
    region: "eu-north1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "eu-north1",
    price_usd: "1.45",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA H100 NVLink with Intel Sapphire Rapids",
    region: "eu-north1",
    price_usd: "1.25",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "eu-west1",
    price_usd: "3.5",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "eu-west1",
    price_usd: "1.45",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA RTX PRO 6000",
    region: "us-central1",
    price_usd: "1.8",
    unit: "GPU hour",
    valid_from: "2026-05-27",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA RTX PRO 6000",
    region: "us-central1",
    price_usd: "0.95",
    unit: "GPU hour",
    valid_from: "2026-05-27",
  },
  {
    service: "Compute",
    product: "NVIDIA B200 NVLink with Intel Emerald Rapids",
    region: "us-central1",
    price_usd: "5.5",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "us-central1",
    price_usd: "3.5",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA B200 NVLink with Intel Emerald Rapids",
    region: "us-central1",
    price_usd: "2.9",
    unit: "GPU hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA H200 NVLink with Intel Sapphire Rapids",
    region: "us-central1",
    price_usd: "1.45",
    unit: "GPU hour",
    valid_from: "2025-09-01",
  },
  {
    service: "Compute",
    product: "NVIDIA B200 NVLink with Intel Emerald Rapids",
    region: "me-west1",
    price_usd: "5.5",
    unit: "GPU hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Preemptible NVIDIA B200 NVLink with Intel Emerald Rapids",
    region: "me-west1",
    price_usd: "2.9",
    unit: "GPU hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. CPU",
    region: "eu-north1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. RAM",
    region: "eu-north1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Non-GPU Intel Ice Lake. CPU",
    region: "eu-north1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Non-GPU Intel Ice Lake. RAM",
    region: "eu-north1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. CPU",
    region: "eu-west1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. RAM",
    region: "eu-west1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. CPU",
    region: "us-central1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2025-03-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. RAM",
    region: "us-central1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2025-03-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. CPU",
    region: "me-west1",
    price_usd: "0.012",
    unit: "vCPU hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Non-GPU AMD Epyc Genoa. RAM",
    region: "me-west1",
    price_usd: "0.0032",
    unit: "GiB hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Network SSD IO M3 disk",
    region: "eu-north1",
    price_usd: "0.000161111",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Shared Filesystem SSD",
    region: "eu-north1",
    price_usd: "0.000109589",
    unit: "GiB hour",
    valid_from: "2025-07-01",
  },
  {
    service: "Compute",
    product: "Network SSD disk",
    region: "eu-north1",
    price_usd: "0.000097222",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Network SSD Non-replicated disk",
    region: "eu-north1",
    price_usd: "0.000072222",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Shared Filesystem HDD",
    region: "eu-north1",
    price_usd: "0.000054794",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Network HDD disk",
    region: "eu-north1",
    price_usd: "0.000027778",
    unit: "GiB hour",
    valid_from: "2024-10-01",
  },
  {
    service: "Compute",
    product: "Network SSD IO M3 disk",
    region: "eu-west1",
    price_usd: "0.000161111",
    unit: "GiB hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Shared Filesystem SSD",
    region: "eu-west1",
    price_usd: "0.000109589",
    unit: "GiB hour",
    valid_from: "2025-07-01",
  },
  {
    service: "Compute",
    product: "Network SSD disk",
    region: "eu-west1",
    price_usd: "0.000097222",
    unit: "GiB hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Network SSD Non-replicated disk",
    region: "eu-west1",
    price_usd: "0.000072222",
    unit: "GiB hour",
    valid_from: "2024-11-01",
  },
  {
    service: "Compute",
    product: "Network SSD IO M3 disk",
    region: "us-central1",
    price_usd: "0.000161111",
    unit: "GiB hour",
    valid_from: "2025-03-01",
  },
  {
    service: "Compute",
    product: "Shared Filesystem SSD",
    region: "us-central1",
    price_usd: "0.000109589",
    unit: "GiB hour",
    valid_from: "2025-07-01",
  },
  {
    service: "Compute",
    product: "Network SSD disk",
    region: "us-central1",
    price_usd: "0.000097222",
    unit: "GiB hour",
    valid_from: "2025-03-01",
  },
  {
    service: "Compute",
    product: "Network SSD Non-replicated disk",
    region: "us-central1",
    price_usd: "0.000072222",
    unit: "GiB hour",
    valid_from: "2025-03-01",
  },
  {
    service: "Compute",
    product: "Network SSD IO M3 disk",
    region: "me-west1",
    price_usd: "0.000161643",
    unit: "GiB hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Shared Filesystem SSD",
    region: "me-west1",
    price_usd: "0.000109589",
    unit: "GiB hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Network SSD disk",
    region: "me-west1",
    price_usd: "0.000097222",
    unit: "GiB hour",
    valid_from: "2025-10-01",
  },
  {
    service: "Compute",
    product: "Network SSD Non-replicated disk",
    region: "me-west1",
    price_usd: "0.000072222",
    unit: "GiB hour",
    valid_from: "2025-10-01",
  },
];

export type NebiusCatalog = {
  regions: string[];
  instance_types: NebiusInstanceType[];
  images: NebiusImage[];
  prices: NebiusPriceItem[];
};

type NebiusCatalogOpts = NebiusCreds & {
  regions?: string[];
};

function parseVersionParts(value?: string | null): number[] | undefined {
  if (!value) return undefined;
  const parts = value.match(/\d+/g);
  if (!parts?.length) return undefined;
  const nums = parts.map((part) => Number(part)).filter(Number.isFinite);
  return nums.length ? nums : undefined;
}

function compareVersionParts(a?: number[], b?: number[]): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function imageTimestamp(image: NebiusImage): number {
  const value = image.updated_at ?? image.created_at;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNewerImage(next: NebiusImage, current: NebiusImage): boolean {
  const versionCmp = compareVersionParts(
    parseVersionParts(next.version),
    parseVersionParts(current.version),
  );
  if (versionCmp !== 0) return versionCmp > 0;
  const timeCmp = imageTimestamp(next) - imageTimestamp(current);
  if (timeCmp !== 0) return timeCmp > 0;
  return false;
}

async function listAllPlatforms(client: NebiusClient): Promise<Platform[]> {
  const items: Platform[] = [];
  let pageToken = "";
  while (true) {
    const response = await client.platforms.list(
      ListPlatformsRequest.create({
        parentId: client.parentId() ?? "",
        pageSize: Long.fromNumber(100),
        pageToken,
      }),
    );
    if (response.items?.length) items.push(...response.items);
    pageToken = response.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items;
}

async function listAllImages(client: NebiusClient): Promise<Image[]> {
  const items: Image[] = [];
  let pageToken = "";
  while (true) {
    const response = await client.images.list(
      ListImagesRequest.create({
        parentId: client.parentId() ?? "",
        pageSize: Long.fromNumber(100),
        pageToken,
        filter: "",
      }),
    );
    if (response.items?.length) items.push(...response.items);
    pageToken = response.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items;
}

async function listPublicImagesForRegion(
  client: NebiusClient,
  region: string,
): Promise<Image[]> {
  const items: Image[] = [];
  let pageToken = "";
  while (true) {
    const response = await client.images.listPublic(
      ListPublicRequest.create({
        region,
        pageSize: Long.fromNumber(100),
        pageToken,
      }),
    );
    if (response.items?.length) items.push(...response.items);
    pageToken = response.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return items;
}

const normalizedNebiusPriceProduct = (product?: string | null) => {
  let normalized = `${product ?? ""}`.trim();
  normalized = normalized.replace(/^preemptible\s+/i, "");
  normalized = normalized.replace(/\.\s*(cpu|ram|gpu)$/i, "");
  return normalizeNebiusPricingToken(normalized);
};

const hasNebiusPriceForPlatform = (
  prices: NebiusPriceItem[],
  platform: DocumentedNebiusPlatform,
  region: string,
) => {
  const aliases = platform.price_aliases.map(normalizeNebiusPricingToken);
  return prices.some((item) => {
    if (item.region !== region) return false;
    const product = normalizedNebiusPriceProduct(item.product);
    return aliases.some(
      (alias) => product.includes(alias) || alias.includes(product),
    );
  });
};

const imageRecommendsPlatform = (
  images: Array<{ image: Image; region?: string }>,
  platform: string,
  region: string,
) =>
  images.some(
    ({ image, region: imageRegion }) =>
      imageRegion === region &&
      (image.spec?.recommendedPlatforms ?? []).includes(platform),
  );

function addDocumentedNebiusGpuPlatforms(opts: {
  instance_types: NebiusInstanceType[];
  images: Array<{ image: Image; region?: string }>;
  prices: NebiusPriceItem[];
}) {
  const seen = new Set(
    opts.instance_types.map((entry) => `${entry.platform}:${entry.name}`),
  );
  for (const platform of DOCUMENTED_GPU_PLATFORMS) {
    const usableRegions = platform.regions.filter(
      (region) =>
        hasNebiusPriceForPlatform(opts.prices, platform, region) &&
        imageRecommendsPlatform(opts.images, platform.platform, region),
    );
    if (!usableRegions.length) continue;
    for (const preset of platform.presets) {
      const key = `${platform.platform}:${preset.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opts.instance_types.push({
        name: preset.name,
        platform: platform.platform,
        platform_label: platform.platform_label,
        regions: usableRegions,
        allowed_for_preemptibles: platform.allowed_for_preemptibles,
        vcpus: preset.vcpus,
        memory_gib: preset.memory_gib,
        gpus: preset.gpus,
        gpu_label: platform.platform_label,
      });
    }
  }
}

export async function fetchNebiusCatalog(
  opts: NebiusCatalogOpts,
): Promise<NebiusCatalog> {
  const client = new NebiusClient(opts);
  const regions = (opts.regions ?? []).filter(Boolean);
  const [platforms, images] = await Promise.all([
    listAllPlatforms(client),
    regions.length
      ? Promise.all(
          regions.map(async (region) => ({
            region,
            items: await listPublicImagesForRegion(client, region),
          })),
        ).then((lists) =>
          lists.flatMap((entry) =>
            entry.items.map((image) => ({
              image,
              region: entry.region,
            })),
          ),
        )
      : listAllImages(client).then((items) =>
          items.map((image) => ({
            image,
            region: undefined as string | undefined,
          })),
        ),
  ]);

  const instance_types: NebiusInstanceType[] = [];
  for (const platform of platforms) {
    const platformName = platform.metadata?.name ?? "";
    const platformLabel =
      platform.spec?.shortHumanReadableName ||
      platform.spec?.humanReadableName ||
      platformName;
    const presets = platform.spec?.presets ?? [];
    for (const preset of presets) {
      const resources = preset.resources as
        | { vcpuCount?: number; memoryGibibytes?: number; gpuCount?: number }
        | undefined;
      instance_types.push({
        name: preset.name,
        platform: platformName,
        platform_label: platformLabel,
        allowed_for_preemptibles:
          platform.status?.allowedForPreemptibles ?? false,
        vcpus: resources?.vcpuCount || undefined,
        memory_gib: resources?.memoryGibibytes || undefined,
        gpus: resources?.gpuCount || undefined,
        gpu_label:
          platform.spec?.shortHumanReadableName ??
          platform.spec?.humanReadableName ??
          undefined,
      });
    }
  }

  const imageMap = new Map<string, NebiusImage>();
  for (const entry of images) {
    const image = entry.image;
    const id = image.metadata?.id ?? "";
    if (!id) continue;
    const createdAt =
      image.metadata?.createdAt?.toISOString?.() ??
      (image.metadata?.createdAt as any)?.toString?.() ??
      null;
    const updatedAt =
      image.metadata?.updatedAt?.toISOString?.() ??
      (image.metadata?.updatedAt as any)?.toString?.() ??
      null;
    imageMap.set(id, {
      id,
      name: image.metadata?.name ?? null,
      family: image.spec?.imageFamily ?? null,
      version: image.spec?.version ?? null,
      architecture: image.spec?.cpuArchitecture?.name ?? null,
      recommended_platforms: image.spec?.recommendedPlatforms ?? [],
      region: entry.region ?? null,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
  const normalizedImages: NebiusImage[] = Array.from(imageMap.values());
  const latestImagesByKey = new Map<string, NebiusImage>();
  for (const image of normalizedImages) {
    const key = [
      image.region ?? "global",
      image.family ?? "unknown",
      image.architecture ?? "unknown",
    ].join("|");
    const current = latestImagesByKey.get(key);
    if (!current || isNewerImage(image, current)) {
      latestImagesByKey.set(key, image);
    }
  }
  const latestImages = Array.from(latestImagesByKey.values());
  const regionsWithImages = new Set(
    latestImages
      .map((img) => img.region ?? undefined)
      .filter((value): value is string => !!value),
  );
  const normalizedRegions = regions.length
    ? regions.filter((region) => regionsWithImages.has(region))
    : Array.from(regionsWithImages);
  let prices = NEBIUS_CONSOLE_PRICES;
  try {
    const fetched = await fetchNebiusPricingFromDocs({
      regions: normalizedRegions.length ? normalizedRegions : regions,
    });
    if (fetched.length) {
      prices = fetched;
    }
  } catch (err) {
    logger.warn(
      "fetchNebiusCatalog pricing docs fetch failed; using fallback",
      {
        err: `${err}`,
      },
    );
  }
  addDocumentedNebiusGpuPlatforms({
    instance_types,
    images,
    prices,
  });

  logger.info("fetchNebiusCatalog", {
    regions: normalizedRegions.length,
    platforms: platforms.length,
    images: latestImages.length,
    prices: prices.length,
  });

  return {
    regions: normalizedRegions.length ? normalizedRegions : regions,
    instance_types,
    images: latestImages,
    prices,
  };
}

export function nebiusCatalogEntries(catalog: NebiusCatalog): CatalogEntry[] {
  return [
    {
      kind: "regions",
      scope: "global",
      payload: catalog.regions.map((name) => ({ name })),
    },
    {
      kind: "instance_types",
      scope: "global",
      payload: catalog.instance_types,
    },
    {
      kind: "images",
      scope: "global",
      payload: catalog.images,
    },
    {
      kind: "prices",
      scope: "global",
      payload: catalog.prices,
    },
  ];
}
