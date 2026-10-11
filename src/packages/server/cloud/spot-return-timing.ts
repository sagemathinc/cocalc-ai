/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Returning a host from fallback capacity to Spot (or to its desired machine
// type) restarts it: a planned interruption, so do it when it hurts least.
// Return when the host is quiet, during the region's overnight window, or
// once the fallback runtime cap is reached; otherwise re-check periodically.

// Approximate standard-time UTC offsets (hours) by GCP region prefix. An hour
// of DST error only shifts the window, which is fine.
const REGION_UTC_OFFSETS: Array<[string, number]> = [
  ["asia-south", 5.5],
  ["asia-southeast", 8],
  ["asia-east", 8],
  ["asia-northeast", 9],
  ["australia-southeast", 10],
  ["europe-north", 2],
  ["europe-west", 1],
  ["europe-central", 1],
  ["europe-southwest", 1],
  ["me-central", 3],
  ["me-west", 2],
  ["africa-south", 2],
  ["northamerica-northeast", -5],
  ["northamerica-south", -6],
  ["southamerica-east", -3],
  ["southamerica-west", -4],
  ["us-east", -5],
  ["us-central", -6],
  ["us-south", -6],
  ["us-west", -8],
];

export const SPOT_RETURN_WINDOW_LOCAL_HOURS: [number, number] = [2, 6];
export const SPOT_RETURN_RECHECK_MS = 30 * 60 * 1000;
export const SPOT_RETURN_QUIET_MINUTES = 15;

export function regionUtcOffsetHours(region?: string): number | undefined {
  const value = `${region ?? ""}`.trim().toLowerCase();
  return REGION_UTC_OFFSETS.find(([prefix]) => value.startsWith(prefix))?.[1];
}

function localHour(now: Date, offsetHours: number): number {
  const hours = now.getUTCHours() + now.getUTCMinutes() / 60 + offsetHours;
  return ((hours % 24) + 24) % 24;
}

function nextWindowStart(now: Date, offsetHours: number): Date {
  const [start] = SPOT_RETURN_WINDOW_LOCAL_HOURS;
  const hoursUntil = (((start - localHour(now, offsetHours)) % 24) + 24) % 24;
  return new Date(now.getTime() + hoursUntil * 60 * 60 * 1000);
}

export type SpotReturnReason = "max_runtime" | "quiet" | "overnight";

export function spotReturnDecision(opts: {
  now: Date;
  region?: string;
  fallback_started_at?: string;
  max_fallback_runtime_ms: number;
  // Projects on this host with user or agent activity in the quiet period.
  recently_active_projects: number;
}):
  | { return_now: true; reason: SpotReturnReason }
  | { return_now: false; recheck_at: Date } {
  const nowMs = opts.now.getTime();
  const startedMs = opts.fallback_started_at
    ? Date.parse(opts.fallback_started_at)
    : NaN;
  const capMs = Number.isFinite(startedMs)
    ? startedMs + opts.max_fallback_runtime_ms
    : undefined;
  if (capMs != null && nowMs >= capMs) {
    return { return_now: true, reason: "max_runtime" };
  }
  if (opts.recently_active_projects <= 0) {
    return { return_now: true, reason: "quiet" };
  }
  const offset = regionUtcOffsetHours(opts.region);
  if (offset != null) {
    const hour = localHour(opts.now, offset);
    const [start, end] = SPOT_RETURN_WINDOW_LOCAL_HOURS;
    if (hour >= start && hour < end) {
      return { return_now: true, reason: "overnight" };
    }
  }
  const candidates = [nowMs + SPOT_RETURN_RECHECK_MS];
  if (capMs != null) candidates.push(capMs);
  if (offset != null) {
    candidates.push(nextWindowStart(opts.now, offset).getTime());
  }
  return {
    return_now: false,
    recheck_at: new Date(Math.max(nowMs + 60_000, Math.min(...candidates))),
  };
}
