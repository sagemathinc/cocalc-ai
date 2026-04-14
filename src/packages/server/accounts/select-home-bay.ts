/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Request } from "express";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
  type ConfiguredClusterBayInfo,
} from "@cocalc/server/bay-config";
import { detectSignupRegionHint } from "@cocalc/server/bay-public-origin";
import { getClusterAccountHomeBayCounts } from "@cocalc/server/inter-bay/accounts";

function normalize(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function regionMatchRank(
  regionHint: string | undefined,
  bay: ConfiguredClusterBayInfo,
): number {
  const hint = normalize(regionHint);
  const region = normalize(bay.region);
  if (!hint || !region) {
    return 2;
  }
  if (hint === region) {
    return 0;
  }
  if (hint.includes(region) || region.includes(hint)) {
    return 1;
  }
  return 3;
}

export async function selectSignupHomeBay({
  req,
}: {
  req: Request;
}): Promise<string> {
  const catalog = getConfiguredClusterBayCatalog();
  if (catalog.length <= 1) {
    return catalog[0]?.bay_id ?? getConfiguredBayId();
  }
  const counts = await getClusterAccountHomeBayCounts();
  const currentBayId = getConfiguredBayId();
  const regionHint = detectSignupRegionHint(req);
  const ranked = catalog
    .map((bay) => ({
      bay,
      regionRank: regionMatchRank(regionHint, bay),
      accountCount: Math.max(0, Number(counts[bay.bay_id] ?? 0) || 0),
      currentBias: bay.bay_id === currentBayId ? 0 : 1,
    }))
    .sort((a, b) => {
      if (a.regionRank !== b.regionRank) {
        return a.regionRank - b.regionRank;
      }
      if (a.accountCount !== b.accountCount) {
        return a.accountCount - b.accountCount;
      }
      if (a.currentBias !== b.currentBias) {
        return a.currentBias - b.currentBias;
      }
      return a.bay.bay_id.localeCompare(b.bay.bay_id);
    });
  return ranked[0]?.bay.bay_id ?? currentBayId;
}
