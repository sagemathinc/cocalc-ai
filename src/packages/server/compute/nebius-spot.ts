/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Nebius Spot for dedicated VMs, max-price mode only (#684). The VM's Spot
// rate is fixed when it is set (at create, a machine change or a switch to
// Spot, always while the VM is stopped): Nebius's live price plus the
// headroom gives the per-GPU cap, and the VM is billed the cap plus the
// surcharge. Nebius never charges more than the cap, and stops the VM if its
// price rises above it.

import {
  estimateDedicatedHostRate,
  type DedicatedHostRateEstimate,
  type DedicatedHostRateEstimateInput,
} from "@cocalc/server/project-host/spend";
import { getDedicatedHostSurchargeFraction } from "@cocalc/util/project-host-pricing";
import {
  nebiusSpotMaxPricePerGpuHour,
  normalizeNebiusSpotHeadroomPercent,
} from "@cocalc/util/nebius-spot-pricing";
import { quoteNebiusComputeSpotPrice } from "./provider";

export const NEBIUS_SPOT_NOT_CHEAPER_MESSAGE =
  "Nebius Spot isn't cheaper than Standard right now; use Standard pricing";

export const NEBIUS_SPOT_COURSE_MESSAGE =
  "Course-sponsored compute uses Standard pricing; Nebius Spot isn't available for it";

/** What a Nebius Spot VM's rate was based on, kept in its billing metadata. */
export interface NebiusSpotBilling {
  max_price_per_gpu_hour: string;
  quoted_price_per_gpu_hour: string;
  quoted_at: string;
  headroom_percent: number;
  region: string;
  platform: string;
}

/** Course-sponsored compute keeps Spot off: a price stop would interrupt a
 * class, and course budgets are reserved at Standard rates. */
export function assertNebiusSpotFundingAllowed(opts: {
  provider: unknown;
  pricing_model: unknown;
  course_funded: boolean;
}): void {
  if (
    opts.course_funded &&
    `${opts.provider ?? ""}` === "nebius" &&
    opts.pricing_model === "spot"
  ) {
    throw new Error(NEBIUS_SPOT_COURSE_MESSAGE);
  }
}

/** The provider's on-demand price per GPU-hour for the instance (no disks or
 * licenses), from a customer rate that includes the surcharge. Nebius caps a
 * policy 1 cent under this. */
export function nebiusOnDemandPricePerGpuHour(
  onDemandRate: DedicatedHostRateEstimate,
  surchargeFraction: number,
  gpuCount: number,
): string | undefined {
  if (!(gpuCount > 0)) return undefined;
  const compute = onDemandRate.pricing_snapshot.components
    .filter(
      (component) =>
        component.key !== "windows_license" &&
        (component.billing_states ?? []).length === 1 &&
        component.billing_states?.[0] === "running",
    )
    .reduce((sum, component) => sum + Number(component.hourly_cost_usd), 0);
  const perGpu = compute / (1 + surchargeFraction) / gpuCount;
  return Number.isFinite(perGpu) && perGpu > 0 ? perGpu.toFixed(6) : undefined;
}

/** A Nebius Spot VM's running rate from a live quote. Throws (so the caller
 * refuses Spot) when there is no quote, no cap fits under on-demand, or the
 * capped rate isn't cheaper than Standard. */
export async function nebiusSpotRunningRate(opts: {
  rate_input: Omit<
    DedicatedHostRateEstimateInput,
    "pricing_model" | "billing_state"
  >;
  on_demand_rate: DedicatedHostRateEstimate;
  settings: Record<string, any>;
  quote?: typeof quoteNebiusComputeSpotPrice;
  estimate?: typeof estimateDedicatedHostRate;
}): Promise<{ rate: DedicatedHostRateEstimate; spot: NebiusSpotBilling }> {
  const region = `${opts.rate_input.region ?? ""}`.trim();
  const platform = `${opts.rate_input.provider_platform ?? ""}`.trim();
  const gpuCount = Number(opts.rate_input.gpu_count ?? 0);
  if (!region || !platform || !(gpuCount > 0)) {
    throw new Error("Nebius Spot is offered for GPU machines only");
  }
  const quote = await (opts.quote ?? quoteNebiusComputeSpotPrice)({
    region,
    platform,
  });
  const headroom = normalizeNebiusSpotHeadroomPercent(
    opts.settings?.nebius_spot_headroom_percent,
  );
  const onDemandPerGpu = nebiusOnDemandPricePerGpuHour(
    opts.on_demand_rate,
    getDedicatedHostSurchargeFraction("nebius", opts.settings),
    gpuCount,
  );
  if (!onDemandPerGpu) throw new Error(NEBIUS_SPOT_NOT_CHEAPER_MESSAGE);
  const cap = nebiusSpotMaxPricePerGpuHour({
    live_price_per_gpu_hour: quote.price_per_gpu_hour,
    headroom_percent: headroom,
    on_demand_price_per_gpu_hour: onDemandPerGpu,
  });
  if (!cap) throw new Error(NEBIUS_SPOT_NOT_CHEAPER_MESSAGE);
  const rate = await (opts.estimate ?? estimateDedicatedHostRate)({
    ...opts.rate_input,
    pricing_model: "spot",
    billing_state: "running",
    nebius_spot_max_price_per_gpu_hour: cap,
  });
  if (
    !rate ||
    !(
      Number(rate.hourly_cost_usd) < Number(opts.on_demand_rate.hourly_cost_usd)
    )
  ) {
    throw new Error(NEBIUS_SPOT_NOT_CHEAPER_MESSAGE);
  }
  return {
    rate,
    spot: {
      max_price_per_gpu_hour: cap,
      quoted_price_per_gpu_hour: quote.price_per_gpu_hour,
      quoted_at: quote.quoted_at,
      headroom_percent: headroom,
      region,
      platform,
    },
  };
}
