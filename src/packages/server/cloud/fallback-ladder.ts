/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Pure planning for Spot host recovery when the desired machine type cannot
// start: spot desired -> standard desired -> spot alternates -> standard
// alternates. Alternates have the same physical cores and memory (within a
// tolerance) in another machine family, which has its own quota pool and
// hardware capacity. The caller performs each rung and never throws.

import type { GcpCatalogPrices } from "@cocalc/util/project-host-pricing";

export type HostPricing = "spot" | "on_demand";

export type StartFailureKind =
  // No hardware for this type right now: try another rung.
  | "capacity"
  // The project cannot get more of this family/pricing: try another rung.
  | "quota"
  // This instance cannot run this type (NIC, disk, zone): try another rung.
  | "incompatible"
  // Anything else: retry the same rung later.
  | "transient";

export function classifyStartFailure(err: unknown): StartFailureKind {
  const message = `${(err as any)?.message ?? err ?? ""}`.toUpperCase();
  if (
    message.includes("QUOTA_EXCEEDED") ||
    /QUOTA '[A-Z0-9_]+' EXCEEDED/.test(message)
  ) {
    return "quota";
  }
  if (
    [
      "ZONE_RESOURCE_POOL_EXHAUSTED",
      "RESOURCE_POOL_EXHAUSTED",
      "INSUFFICIENT CAPACITY",
      "STOCKOUT",
      "DOES NOT HAVE ENOUGH RESOURCES",
    ].some((pattern) => message.includes(pattern))
  ) {
    return "capacity";
  }
  if (
    [
      "REQUIRES GVNIC",
      "GVNIC",
      "IS NOT SUPPORTED FOR MACHINE TYPE",
      "NOT SUPPORTED BY MACHINE TYPE",
      "DOES NOT SUPPORT",
      "INVALID VALUE FOR FIELD 'RESOURCE.MACHINETYPE'",
      "MACHINE TYPE WITH NAME",
      "UNSUPPORTED_OPERATION",
    ].some((pattern) => message.includes(pattern))
  ) {
    return "incompatible";
  }
  return "transient";
}

export interface GcpMachineTypeEntry {
  name: string;
  guestCpus?: number;
  memoryMb?: number;
  isSharedCpu?: boolean;
}

export interface MachineShape {
  name: string;
  family: string;
  vcpus: number;
  memory_gb: number;
  // Physical cores: what users actually get. T2D/T2A have one thread per
  // core; the other families here expose two vCPUs per core (SMT).
  cores: number;
}

// Families allowed as recovery targets. Each supports pd-balanced disks and
// stop/setMachineType on an existing instance. C3/C3D additionally require a
// gVNIC network interface, which cannot be added to an existing VM.
const VIRTIO_FAMILIES = ["t2d", "n2d", "n2", "c2d"] as const;
const GVNIC_ONLY_FAMILIES = ["c3d", "c3"] as const;
const SINGLE_THREAD_FAMILIES = new Set(["t2d", "t2a"]);

export function machineFamily(machineType: string): string {
  return `${machineType ?? ""}`.trim().toLowerCase().split("-")[0] ?? "";
}

export function machineShape(
  entry: GcpMachineTypeEntry | undefined,
): MachineShape | undefined {
  if (!entry?.name || entry.isSharedCpu) return undefined;
  const vcpus = Number(entry.guestCpus);
  const memoryMb = Number(entry.memoryMb);
  if (!(vcpus > 0) || !(memoryMb > 0)) return undefined;
  const family = machineFamily(entry.name);
  const threadsPerCore = SINGLE_THREAD_FAMILIES.has(family) ? 1 : 2;
  return {
    name: entry.name,
    family,
    vcpus,
    memory_gb: memoryMb / 1024,
    cores: vcpus / threadsPerCore,
  };
}

export function allowedRecoveryFamilies(opts: { gvnic?: boolean }): string[] {
  return opts.gvnic
    ? [...VIRTIO_FAMILIES, ...GVNIC_ONLY_FAMILIES]
    : [...VIRTIO_FAMILIES];
}

export function hourlyPriceUsd(opts: {
  prices?: GcpCatalogPrices;
  region: string;
  shape: MachineShape;
  pricing: HostPricing;
}): number | undefined {
  const entry = (opts.prices?.families as any)?.[opts.shape.family];
  if (!entry) return undefined;
  const cpu = (opts.pricing === "spot" ? entry.spot_cpu : entry.cpu)?.[
    opts.region
  ];
  const ram = (opts.pricing === "spot" ? entry.spot_ram : entry.ram)?.[
    opts.region
  ];
  if (!(cpu > 0) || !(ram > 0)) return undefined;
  return cpu * opts.shape.vcpus + ram * opts.shape.memory_gb;
}

// Same physical cores and memory as the desired shape, within 10%, without
// paying for much more than that (at most 1.5x either).
export function isCoreEquivalent(
  desired: MachineShape,
  candidate: MachineShape,
): boolean {
  return (
    candidate.cores >= desired.cores * 0.9 &&
    candidate.memory_gb >= desired.memory_gb * 0.9 &&
    candidate.cores <= desired.cores * 1.5 &&
    candidate.memory_gb <= desired.memory_gb * 2.01
  );
}

export function alternateMachineTypes(opts: {
  desired: MachineShape;
  available: GcpMachineTypeEntry[];
  families: string[];
  prices?: GcpCatalogPrices;
  region: string;
  pricing: HostPricing;
  limit?: number;
}): Array<{ machine_type: string; usd_per_hour?: number }> {
  const allowed = new Set(opts.families);
  const candidates = opts.available
    .map(machineShape)
    .filter(
      (shape): shape is MachineShape =>
        !!shape &&
        shape.name !== opts.desired.name &&
        shape.family !== opts.desired.family &&
        allowed.has(shape.family) &&
        isCoreEquivalent(opts.desired, shape),
    )
    .map((shape) => ({
      shape,
      usd_per_hour: hourlyPriceUsd({
        prices: opts.prices,
        region: opts.region,
        shape,
        pricing: opts.pricing,
      }),
    }));
  // Cheapest first; unpriced types last (smallest first), and only the
  // cheapest type per family so one family's stockout does not stall us.
  candidates.sort((a, b) => {
    if (a.usd_per_hour != null && b.usd_per_hour != null) {
      return a.usd_per_hour - b.usd_per_hour;
    }
    if (a.usd_per_hour != null) return -1;
    if (b.usd_per_hour != null) return 1;
    return a.shape.vcpus - b.shape.vcpus;
  });
  const seenFamilies = new Set<string>();
  const result: Array<{ machine_type: string; usd_per_hour?: number }> = [];
  for (const { shape, usd_per_hour } of candidates) {
    if (seenFamilies.has(shape.family)) continue;
    seenFamilies.add(shape.family);
    result.push({ machine_type: shape.name, usd_per_hour });
    if (result.length >= (opts.limit ?? 3)) break;
  }
  return result;
}

export interface LadderRung {
  pricing: HostPricing;
  machine_type: string;
}

export function rungKey(rung: LadderRung): string {
  return `${rung.pricing}:${rung.machine_type}`;
}

// Order: Spot on the desired type, standard on the desired type, Spot
// alternates, standard alternates. Rungs already tried in this outage are
// skipped, so the first pass starts after the failed Spot attempt and a
// retry pass (tried reset) can still come back on Spot.
export function buildFallbackLadder(opts: {
  desired_machine_type: string;
  spot_alternates: string[];
  standard_alternates: string[];
  tried?: string[];
}): LadderRung[] {
  const tried = new Set(opts.tried ?? []);
  const rungs: LadderRung[] = [
    { pricing: "spot", machine_type: opts.desired_machine_type },
    { pricing: "on_demand", machine_type: opts.desired_machine_type },
    ...opts.spot_alternates.map((machine_type) => ({
      pricing: "spot" as const,
      machine_type,
    })),
    ...opts.standard_alternates.map((machine_type) => ({
      pricing: "on_demand" as const,
      machine_type,
    })),
  ];
  const seen = new Set<string>();
  return rungs.filter((rung) => {
    const key = rungKey(rung);
    if (!rung.machine_type || seen.has(key) || tried.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Regional quota a rung consumes: Spot VMs use PREEMPTIBLE_CPUS when the
// project has that quota; standard VMs use the per-family CPU quota.
export function quotaMetricForRung(rung: LadderRung): string {
  if (rung.pricing === "spot") return "PREEMPTIBLE_CPUS";
  return `${machineFamily(rung.machine_type).toUpperCase()}_CPUS`;
}

export function rungFitsQuota(opts: {
  rung: LadderRung;
  vcpus: number;
  headroom?: Record<string, number>;
}): boolean {
  if (!opts.headroom) return true;
  const metric = quotaMetricForRung(opts.rung);
  const available = opts.headroom[metric];
  // Unknown metric: let the provider decide rather than skipping a rung.
  if (available == null || !Number.isFinite(available)) return true;
  return available >= opts.vcpus;
}

// Backoff for a fully exhausted ladder: retry everything, since capacity and
// quota change over minutes. 2, 4, 8, then every 10 minutes.
export function exhaustedLadderRetryDelayMs(cycle: number): number {
  const minutes = Math.min(10, 2 * 2 ** Math.max(0, cycle - 1));
  return minutes * 60 * 1000;
}
