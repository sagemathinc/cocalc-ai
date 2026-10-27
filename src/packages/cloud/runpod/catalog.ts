/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Normalized RunPod GPU catalog (REST v2): types, list prices, and pod
// availability overall and per data center. Availability changes by the
// minute, so this is a snapshot with as_of; the authority re-checks the
// actual billed cost of a pod after creating it.

import type { RunpodAvailability, RunpodClient } from "./client";

export type RunpodStockLevel = Exclude<RunpodAvailability, "NONE">;

export interface RunpodGpuType {
  id: string;
  name: string;
  memoryGb?: number;
  // USD per GPU-hour list price; absent where that cloud doesn't offer it
  securePrice?: number;
  communityPrice?: number;
  // largest GPU count on one pod, per cloud (a ceiling, not stock)
  maxCountSecure?: number;
  maxCountCommunity?: number;
  availability?: RunpodAvailability;
  // data center id -> availability, only where it is in stock
  dataCenters: Record<string, RunpodStockLevel>;
}

export interface RunpodDataCenter {
  id: string;
  name?: string;
  region?: string;
  compliance: string[];
}

export interface RunpodCatalog {
  as_of: string;
  gpuTypes: RunpodGpuType[];
  dataCenters: RunpodDataCenter[];
}

export function normalizeRunpodCatalog(
  gpuTypes: any[],
  dataCenters: any[],
  now: Date = new Date(),
): RunpodCatalog {
  const types: RunpodGpuType[] = [];
  for (const t of gpuTypes ?? []) {
    if (typeof t?.id !== "string" || !t.id) continue;
    const inStock: Record<string, RunpodStockLevel> = {};
    for (const dc of t.dataCenters ?? []) {
      const level = stockLevel(dc?.availability);
      if (typeof dc?.id === "string" && level) inStock[dc.id] = level;
    }
    types.push({
      id: t.id,
      name: typeof t.name === "string" && t.name ? t.name : t.id,
      memoryGb: positive(t.memory),
      securePrice: t.secure === true ? positive(t.price?.secure) : undefined,
      communityPrice:
        t.community === true ? positive(t.price?.community) : undefined,
      maxCountSecure: positive(t.maxCount?.secure),
      maxCountCommunity: positive(t.maxCount?.community),
      availability: availability(t.availability),
      dataCenters: inStock,
    });
  }
  types.sort(
    (a, b) =>
      (a.securePrice ?? a.communityPrice ?? Infinity) -
        (b.securePrice ?? b.communityPrice ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
  const centers: RunpodDataCenter[] = [];
  for (const dc of dataCenters ?? []) {
    if (typeof dc?.id !== "string" || !dc.id) continue;
    centers.push({
      id: dc.id,
      name: typeof dc.name === "string" ? dc.name : undefined,
      region: typeof dc.region === "string" ? dc.region : undefined,
      compliance: Array.isArray(dc.compliance)
        ? dc.compliance.filter((c: unknown) => typeof c === "string")
        : [],
    });
  }
  centers.sort((a, b) => a.id.localeCompare(b.id));
  return { as_of: now.toISOString(), gpuTypes: types, dataCenters: centers };
}

export async function getRunpodCatalog(
  client: RunpodClient,
): Promise<RunpodCatalog> {
  const [gpuTypes, dataCenters] = await Promise.all([
    client.listGpuTypes(),
    client.listDataCenters(),
  ]);
  return normalizeRunpodCatalog(gpuTypes, dataCenters);
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
