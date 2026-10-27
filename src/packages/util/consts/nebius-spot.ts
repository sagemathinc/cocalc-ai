/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Since 2026-10-08 Nebius prices preemptible (Spot) VMs dynamically, and a
// preemptible VM needs a pricing option (a max price or "follow spot price")
// or it is stopped. Until that is supported (#684), Nebius machines are
// offered on-demand only.
export const NEBIUS_SPOT_OFFERED = false;

export const NEBIUS_SPOT_UNAVAILABLE_MESSAGE =
  "Nebius Spot is unavailable until spot pricing support lands; use Standard pricing";

/** Refuses Nebius Spot (for dedicated VMs and project hosts alike) while it
 * is not offered; anything else passes. */
export function assertNebiusSpotOffered(
  provider: unknown,
  pricingModel: unknown,
): void {
  if (NEBIUS_SPOT_OFFERED) return;
  if (`${provider ?? ""}`.toLowerCase() !== "nebius") return;
  if (pricingModel !== "spot") return;
  throw new Error(NEBIUS_SPOT_UNAVAILABLE_MESSAGE);
}
