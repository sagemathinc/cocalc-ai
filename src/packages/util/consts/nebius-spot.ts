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
