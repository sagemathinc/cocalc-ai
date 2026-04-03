/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const DEFAULT_BAY_ID = "bay-0";

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
