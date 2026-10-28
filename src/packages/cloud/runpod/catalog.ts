/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Normalized RunPod GPU catalog (REST v2): types with list price, maximum
// GPU count and pod availability per cloud tier (Secure and Community are
// queried separately: availability differs by tier), plus data centers.
// Availability changes by the minute, so this is a snapshot with as_of; the
// authority re-checks the actual billed cost of a pod after creating it.

import type { RunpodClient } from "./client";
import type {
  RunpodAvailability,
  RunpodCatalog,
  RunpodCloud,
  RunpodCloudOffer,
  RunpodDataCenter,
  RunpodGpuType,
  RunpodStockLevel,
} from "@cocalc/util/gpu/runpod";

// The catalog types are shared with the hub API and frontend.
export type {
  RunpodCatalog,
  RunpodCloudOffer,
  RunpodDataCenter,
  RunpodGpuType,
  RunpodStockLevel,
} from "@cocalc/util/gpu/runpod";

export function normalizeRunpodCatalog(
  byCloud: { secure: any[]; community: any[] },
  dataCenters: any[],
  now: Date = new Date(),
): RunpodCatalog {
  const types = new Map<string, RunpodGpuType>();
  const add = (rows: any[], cloud: RunpodCloud) => {
    const key = cloud === "SECURE" ? "secure" : "community";
    for (const t of rows ?? []) {
      if (typeof t?.id !== "string" || !t.id) continue;
      const type = types.get(t.id) ?? {
        id: t.id,
        name: typeof t.name === "string" && t.name ? t.name : t.id,
        manufacturer:
          typeof t.manufacturer === "string" && t.manufacturer
            ? t.manufacturer
            : undefined,
        memoryGb: positive(t.memory),
      };
      // `secure`/`community` say whether that cloud offers the type at all;
      // RunPod lists a price even where it doesn't.
      if (t[key] === true) type[key] = offer(t, key);
      types.set(t.id, type);
    }
  };
  add(byCloud.secure, "SECURE");
  add(byCloud.community, "COMMUNITY");
  const gpuTypes = [...types.values()]
    .map(compact)
    .sort((a, b) => cheapest(a) - cheapest(b) || a.id.localeCompare(b.id));
  const centers: RunpodDataCenter[] = [];
  for (const dc of dataCenters ?? []) {
    if (typeof dc?.id !== "string" || !dc.id) continue;
    centers.push(
      compact({
        id: dc.id,
        name: typeof dc.name === "string" ? dc.name : undefined,
        region: typeof dc.region === "string" ? dc.region : undefined,
        compliance: Array.isArray(dc.compliance)
          ? dc.compliance.filter((c: unknown) => typeof c === "string")
          : [],
        globalNetwork:
          typeof dc.globalNetwork === "boolean" ? dc.globalNetwork : undefined,
        networkVolumeTypes: Array.isArray(dc.networkVolumeTypes)
          ? dc.networkVolumeTypes.filter((v: unknown) => typeof v === "string")
          : undefined,
      }),
    );
  }
  centers.sort((a, b) => a.id.localeCompare(b.id));
  return { as_of: now.toISOString(), gpuTypes, dataCenters: centers };
}

export async function getRunpodCatalog(
  client: RunpodClient,
): Promise<RunpodCatalog> {
  const [secure, community, dataCenters] = await Promise.all([
    client.listGpuTypes("SECURE"),
    client.listGpuTypes("COMMUNITY"),
    client.listDataCenters(),
  ]);
  return normalizeRunpodCatalog({ secure, community }, dataCenters);
}

function offer(t: any, key: "secure" | "community"): RunpodCloudOffer {
  const inStock: Record<string, RunpodStockLevel> = {};
  for (const dc of t.dataCenters ?? []) {
    const level = stockLevel(dc?.availability);
    if (typeof dc?.id === "string" && level) inStock[dc.id] = level;
  }
  const o: RunpodCloudOffer = {
    price: positive(t.price?.[key]),
    maxCount: positive(t.maxCount?.[key]),
    availability: availability(t.availability),
    dataCenters: inStock,
  };
  return compact(o);
}

function cheapest(t: RunpodGpuType): number {
  return Math.min(t.secure?.price ?? Infinity, t.community?.price ?? Infinity);
}

function availability(v: unknown): RunpodAvailability | undefined {
  return v === "NONE" || v === "LOW" || v === "MEDIUM" || v === "HIGH"
    ? v
    : undefined;
}

function stockLevel(v: unknown): RunpodStockLevel | undefined {
  const a = availability(v);
  return a && a !== "NONE" ? a : undefined;
}

function positive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
