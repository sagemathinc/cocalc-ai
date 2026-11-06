/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Nebius Spot for dedicated VMs in max-price mode (#684). At create, CoCalc
// quotes Nebius's live spot price, sets a per-GPU cap with some headroom
// above it, and bills the VM a fixed rate at that cap. Nebius never charges
// more than the cap, and stops the VM if its price rises above it.

export const DEFAULT_NEBIUS_SPOT_HEADROOM_PERCENT = 20;
export const MAX_NEBIUS_SPOT_HEADROOM_PERCENT = 200;

export const NEBIUS_SPOT_PRICE_STOP_REASON = "spot_price_above_max" as const;

/** Nebius prices are USD decimal strings with at most 3 decimals in a policy;
 * all cap arithmetic is in integer thousandths of a dollar. */
function toMilli(value: unknown, round: "up" | "down"): number | undefined {
  const text = `${value ?? ""}`.trim();
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  const whole = Number(match[1]);
  const fraction = match[2] ?? "";
  const kept = Number((fraction + "000").slice(0, 3));
  const rest = fraction.slice(3);
  let milli = whole * 1000 + kept;
  if (round === "up" && /[1-9]/.test(rest)) milli += 1;
  return Number.isSafeInteger(milli) ? milli : undefined;
}

function fromMilli(milli: number): string {
  return `${Math.floor(milli / 1000)}.${`${milli % 1000}`.padStart(3, "0")}`;
}

export function normalizeNebiusSpotHeadroomPercent(value: unknown): number {
  const n = Number(value);
  if (
    value == null ||
    value === "" ||
    !Number.isFinite(n) ||
    n < 0 ||
    n > MAX_NEBIUS_SPOT_HEADROOM_PERCENT
  ) {
    return DEFAULT_NEBIUS_SPOT_HEADROOM_PERCENT;
  }
  return n;
}

/**
 * The per-GPU-hour max price for a new Spot VM, as Nebius's 3-decimal string:
 * the live price plus the headroom, rounded up, and kept at least 1 cent
 * under the on-demand GPU-hour price when that is known (Nebius's upper limit
 * for a policy). Returns undefined when no cap at or above the live price
 * fits, so the caller refuses Spot.
 */
export function nebiusSpotMaxPricePerGpuHour(opts: {
  live_price_per_gpu_hour: unknown;
  headroom_percent: unknown;
  on_demand_price_per_gpu_hour?: unknown;
}): string | undefined {
  const live = toMilli(opts.live_price_per_gpu_hour, "up");
  if (live == null || live <= 0) return undefined;
  const headroom = normalizeNebiusSpotHeadroomPercent(opts.headroom_percent);
  // integer percent-thousandths, so 20% of 2.345 rounds up exactly
  let cap = Math.ceil((live * (100 + headroom)) / 100 - 1e-9);
  if (opts.on_demand_price_per_gpu_hour != null) {
    const onDemand = toMilli(opts.on_demand_price_per_gpu_hour, "down");
    if (onDemand == null) return undefined;
    cap = Math.min(cap, onDemand - 10);
  }
  if (cap < live) return undefined;
  return fromMilli(cap);
}

/** One immutable pricing policy per (platform, cap); a new cap gets a new
 * policy, so a policy is never edited while VMs run under it. */
export function nebiusSpotPolicyName(
  platform: string,
  maxPricePerGpuHour: string,
): string {
  const safePlatform = `${platform}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safePlatform) throw new Error("Nebius Spot platform is required");
  const milli = toMilli(maxPricePerGpuHour, "up");
  if (milli == null || fromMilli(milli) !== maxPricePerGpuHour) {
    throw new Error(`invalid Nebius Spot max price '${maxPricePerGpuHour}'`);
  }
  return `cocalc-spot-${safePlatform}-${maxPricePerGpuHour.replace(".", "-")}`;
}

/** True when the live price is at or below the VM's cap, so a start may be
 * scheduled. Unparseable values never allow a start. */
export function nebiusSpotPriceWithinCap(
  livePricePerGpuHour: unknown,
  maxPricePerGpuHour: unknown,
): boolean {
  const live = toMilli(livePricePerGpuHour, "up");
  const cap = toMilli(maxPricePerGpuHour, "down");
  return live != null && cap != null && live <= cap;
}

export function nebiusSpotPriceStopMessage(maxPricePerGpuHour: string): string {
  return `Nebius stopped this Spot VM because its spot price rose above this VM's cap ($${maxPricePerGpuHour} per GPU-hour). Disks and files are kept, and compute charges stopped. Start it again when the price is back under the cap, or switch it to Standard (never stopped for price).`;
}
