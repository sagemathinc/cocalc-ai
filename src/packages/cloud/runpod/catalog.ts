/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Normalized RunPod GPU catalog: types, prices and stock per data center.
// Availability changes by the minute, so this is a snapshot with as_of; the
// authority re-checks the actual price (costPerHr) when it creates a pod.

import type { RunpodClient } from "./client";

export type RunpodStockStatus = "High" | "Medium" | "Low";

export interface RunpodGpuType {
  id: string;
  displayName: string;
  memoryGb?: number;
  // USD per GPU-hour; absent when RunPod doesn't offer that cloud type.
  securePrice?: number;
  communityPrice?: number;
  stock?: RunpodStockStatus;
  // data center id -> stock, only where the type is currently in stock
  dataCenters: Record<string, RunpodStockStatus>;
}

export interface RunpodDataCenter {
  id: string;
  name?: string;
  location?: string;
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
  const byType = new Map<string, Record<string, RunpodStockStatus>>();
  const centers: RunpodDataCenter[] = [];
  for (const dc of dataCenters ?? []) {
    if (typeof dc?.id !== "string" || dc.listed === false) continue;
    centers.push({
      id: dc.id,
      name: typeof dc.name === "string" ? dc.name : undefined,
      location: typeof dc.location === "string" ? dc.location : undefined,
    });
    for (const g of dc.gpuAvailability ?? []) {
      const stock = stockStatus(g?.stockStatus);
      if (typeof g?.gpuTypeId !== "string" || !stock) continue;
      const m = byType.get(g.gpuTypeId) ?? {};
      m[dc.id] = stock;
      byType.set(g.gpuTypeId, m);
    }
  }
  const types: RunpodGpuType[] = [];
  for (const t of gpuTypes ?? []) {
    if (typeof t?.id !== "string" || t.id === "unknown") continue;
    types.push({
      id: t.id,
      displayName: typeof t.displayName === "string" ? t.displayName : t.id,
      memoryGb: positive(t.memoryInGb),
      // RunPod reports 0 for a cloud type it doesn't offer.
      securePrice:
        t.secureCloud === false ? undefined : positive(t.securePrice),
      communityPrice:
        t.communityCloud === false ? undefined : positive(t.communityPrice),
      stock: stockStatus(t.lowestPrice?.stockStatus),
      dataCenters: byType.get(t.id) ?? {},
    });
  }
  types.sort(
    (a, b) =>
      (a.securePrice ?? a.communityPrice ?? Infinity) -
        (b.securePrice ?? b.communityPrice ?? Infinity) ||
      a.id.localeCompare(b.id),
  );
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

function stockStatus(v: unknown): RunpodStockStatus | undefined {
  return v === "High" || v === "Medium" || v === "Low" ? v : undefined;
}

function positive(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}
