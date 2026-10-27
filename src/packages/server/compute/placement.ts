/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { NEBIUS_SPOT_OFFERED } from "@cocalc/util/consts/nebius-spot";
import type {
  HostCatalog,
  HostCatalogRegion,
  HostCatalogZone,
} from "@cocalc/conat/hub/api/hosts";

export function regionFromComputeZone(zone: string): string {
  return `${zone ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/-[a-z]$/, "");
}

export function requireComputeZoneInRegions(
  zone: string,
  regions?: ReadonlySet<string>,
) {
  if (regions && !regions.has(regionFromComputeZone(zone))) {
    throw new Error(
      `managed compute has no configured regional subnetwork for zone '${zone}'`,
    );
  }
}

export function restrictHostCatalogToRegions(
  catalog: HostCatalog,
  regions?: ReadonlySet<string>,
): HostCatalog {
  if (!regions) return catalog;
  return {
    ...catalog,
    entries: catalog.entries
      .filter(
        ({ kind, scope }) =>
          (kind !== "machine_types" && kind !== "gpu_types") ||
          !scope.startsWith("zone/") ||
          regions.has(regionFromComputeZone(scope.slice("zone/".length))),
      )
      .map((entry) => {
        if (entry.kind === "regions" && entry.scope === "global") {
          return {
            ...entry,
            payload: (entry.payload as HostCatalogRegion[]).filter(({ name }) =>
              regions.has(name),
            ),
          };
        }
        if (entry.kind === "zones" && entry.scope === "global") {
          return {
            ...entry,
            payload: (entry.payload as HostCatalogZone[]).filter(
              ({ name, region }) =>
                regions.has(region || regionFromComputeZone(name)),
            ),
          };
        }
        return entry;
      }),
  };
}

export function defaultComputeZone(catalog: HostCatalog): string {
  const zones = catalog.entries.find(
    ({ kind, scope }) => kind === "zones" && scope === "global",
  )?.payload as HostCatalogZone[] | undefined;
  return (
    zones?.find(({ status }) => !status || status === "UP")?.name ??
    "us-central1-a"
  );
}

export function computeMachineSupportsSpot(
  provider: "gcp" | "nebius",
  machine: {
    gpu_count?: number | null;
    provider_spec?: { allowed_for_preemptibles?: boolean | null };
  },
): boolean {
  if (provider !== "nebius") return true;
  // on-demand only until Nebius spot pricing is supported (#684)
  if (!NEBIUS_SPOT_OFFERED) return false;
  return (
    Number(machine.gpu_count ?? 0) > 0 &&
    machine.provider_spec?.allowed_for_preemptibles === true
  );
}

export function selectNebiusComputeMachine<
  T extends {
    name: string;
    platform?: string | null;
    regions?: string[] | null;
  },
>(
  machines: T[],
  opts: { region: string; machineType: string; platform?: string },
): T | undefined {
  const matches = machines.filter(
    ({ name, platform, regions }) =>
      name === opts.machineType &&
      (!regions?.length || regions.includes(opts.region)) &&
      (!opts.platform || platform === opts.platform),
  );
  if (!opts.platform) {
    const platforms = new Set(matches.map(({ platform }) => platform ?? ""));
    if (platforms.size > 1) {
      throw new Error(
        `Nebius machine '${opts.machineType}' is ambiguous in ${opts.region}; specify its provider platform`,
      );
    }
  }
  return matches[0];
}
