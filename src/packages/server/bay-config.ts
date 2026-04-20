/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DEFAULT_BAY_ID } from "@cocalc/util/bay";

function configuredEnv(name: string): string | undefined {
  const value = `${process.env[name] ?? ""}`.trim();
  return value || undefined;
}

export interface ConfiguredClusterBayInfo {
  bay_id: string;
  label: string;
  region: string | null;
}

export function getConfiguredBayId(): string {
  const bayId = `${process.env.COCALC_BAY_ID ?? ""}`.trim();
  return bayId || DEFAULT_BAY_ID;
}

export function getConfiguredBayLabel(bay_id: string): string {
  const label = `${process.env.COCALC_BAY_LABEL ?? ""}`.trim();
  return label || bay_id;
}

export function getConfiguredBayRegion(): string | null {
  const region = `${process.env.COCALC_BAY_REGION ?? ""}`.trim();
  return region || null;
}

export function getConfiguredClusterBayCatalog(): ConfiguredClusterBayInfo[] {
  const bay_ids =
    `${process.env.COCALC_CLUSTER_BAY_IDS ?? process.env.HUB_CLUSTER_BAY_IDS ?? ""}`
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const count = Math.max(
    bay_ids.length,
    Number(
      configuredEnv("HUB_CLUSTER_BAY_COUNT") ??
        configuredEnv("COCALC_CLUSTER_BAY_COUNT") ??
        0,
    ) || 0,
  );
  const infos = new Map<string, ConfiguredClusterBayInfo>();
  for (let i = 0; i < count; i += 1) {
    const bay_id =
      configuredEnv(`HUB_CLUSTER_BAY_${i}_ID`) ??
      configuredEnv(`COCALC_CLUSTER_BAY_${i}_ID`);
    if (!bay_id) continue;
    infos.set(bay_id, {
      bay_id,
      label:
        configuredEnv(`HUB_CLUSTER_BAY_${i}_LABEL`) ??
        configuredEnv(`COCALC_CLUSTER_BAY_${i}_LABEL`) ??
        bay_id,
      region:
        configuredEnv(`HUB_CLUSTER_BAY_${i}_REGION`) ??
        configuredEnv(`COCALC_CLUSTER_BAY_${i}_REGION`) ??
        null,
    });
  }
  for (const bay_id of bay_ids) {
    if (!infos.has(bay_id)) {
      infos.set(bay_id, { bay_id, label: bay_id, region: null });
    }
  }
  const currentBay = getConfiguredBayId();
  if (!infos.has(currentBay)) {
    infos.set(currentBay, {
      bay_id: currentBay,
      label: getConfiguredBayLabel(currentBay),
      region: getConfiguredBayRegion(),
    });
  }
  return [...infos.values()].sort((a, b) => a.bay_id.localeCompare(b.bay_id));
}
