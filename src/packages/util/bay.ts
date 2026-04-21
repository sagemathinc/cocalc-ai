/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type BayId = string;

export const DEFAULT_BAY_ID = "bay-0";
export const DEFAULT_SEED_BAY_ID = DEFAULT_BAY_ID;

export function isDefaultBayId(bay_id: unknown): boolean {
  return `${bay_id ?? ""}`.trim().toLowerCase() === DEFAULT_BAY_ID;
}
