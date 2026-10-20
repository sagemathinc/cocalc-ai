/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Claude subscription limits as Claude reports them with each model response
// of a CoCalc turn. Account-private; not token counts or a billing estimate.

/** Credential metadata key holding the latest ClaudeRateLimitSnapshot. */
export const CLAUDE_USAGE_METADATA_KEY = "claude_usage";

const WINDOWS = [
  ["five_hour", "Current session (5 hours)"],
  ["seven_day", "This week"],
] as const;

type WindowKey = (typeof WINDOWS)[number][0];

/** What is stored: whitelisted numbers only, never a provider response. */
export interface ClaudeRateLimitSnapshot {
  // When Claude reported these limits (ISO time).
  observed_at: string;
  windows: Partial<
    Record<WindowKey, { utilization: number; resets_at: number }>
  >;
}

export interface ClaudeUsageWindow {
  name: string;
  usedPercent: number;
  // ISO time the window resets (or reset).
  resetsAt: string;
  // The window reset after Claude last reported it, so usedPercent is stale.
  resetSinceObserved?: boolean;
  /**
   * Present when, at the rate used so far in this window, the limit would be
   * reached before it resets: when (limitAt) and how much would be used by
   * the reset at that rate (percentAtReset, at least 100).
   */
  projection?: { limitAt: string; percentAtReset: number };
}

const HOUR_MS = 3600_000;
const WINDOW_LENGTH_MS: Record<string, number> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
};
// Too little of a window has passed before this for its rate to mean much.
const MIN_ELAPSED_FRACTION = 0.2;

/**
 * Linear projection of one window: usage so far divided by the fraction of
 * the window elapsed when it was observed. Undefined unless the limit is
 * projected to be hit before the reset.
 */
export function claudeUsageProjection({
  utilization,
  resetsAtMs,
  observedAtMs,
  lengthMs,
}: {
  utilization: number;
  resetsAtMs: number;
  observedAtMs: number;
  lengthMs: number;
}): ClaudeUsageWindow["projection"] {
  if (!(utilization > 0) || !(lengthMs > 0)) return;
  const startMs = resetsAtMs - lengthMs;
  const elapsed = (observedAtMs - startMs) / lengthMs;
  if (!(elapsed >= MIN_ELAPSED_FRACTION) || elapsed >= 1) return;
  const atReset = utilization / elapsed;
  if (atReset < 1) return;
  const limitAtMs = startMs + (observedAtMs - startMs) / utilization;
  if (!(limitAtMs < resetsAtMs)) return;
  return {
    limitAt: new Date(Math.max(observedAtMs, limitAtMs)).toISOString(),
    percentAtReset: Math.round(atReset * 100),
  };
}

export interface ClaudeSubscriptionUsage {
  observedAt: string;
  windows: ClaudeUsageWindow[];
}

function window(
  value: unknown,
  now: number,
): { utilization: number; resets_at: number } | undefined {
  if (!value || typeof value !== "object") return;
  const { utilization, resets_at } = value as Record<string, unknown>;
  if (
    typeof utilization !== "number" ||
    !Number.isFinite(utilization) ||
    utilization < 0 ||
    utilization > 10 ||
    typeof resets_at !== "number" ||
    !Number.isInteger(resets_at) ||
    // Seconds since the epoch, within a year of now.
    Math.abs(resets_at * 1000 - now) > 366 * 24 * 3600 * 1000
  )
    return;
  return { utilization: Math.min(1, utilization), resets_at };
}

/**
 * Snapshot from an SDK rate_limit_info: prefer its per-window readings, else
 * use the single limiter it names. Undefined when it reports no window.
 */
export function claudeRateLimitSnapshot(
  info: unknown,
  now = Date.now(),
): ClaudeRateLimitSnapshot | undefined {
  if (!info || typeof info !== "object") return;
  const data = info as Record<string, any>;
  const windows: ClaudeRateLimitSnapshot["windows"] = {};
  for (const [key] of WINDOWS) {
    const reading = window(
      data.unifiedWindows?.[key] && {
        utilization: data.unifiedWindows[key].utilization,
        resets_at: data.unifiedWindows[key].resetsAt,
      },
      now,
    );
    if (reading) windows[key] = reading;
  }
  if (Object.keys(windows).length === 0) {
    const key = WINDOWS.find(([key]) => key === data.rateLimitType)?.[0];
    const reading =
      key &&
      window({ utilization: data.utilization, resets_at: data.resetsAt }, now);
    if (key && reading) windows[key] = reading;
  }
  if (Object.keys(windows).length === 0) return;
  return { observed_at: new Date(now).toISOString(), windows };
}

/** Revalidate a stored snapshot (e.g. from credential metadata). */
export function parseClaudeRateLimitSnapshot(
  value: unknown,
  now = Date.now(),
): ClaudeRateLimitSnapshot | undefined {
  if (!value || typeof value !== "object") return;
  const { observed_at, windows } = value as Record<string, any>;
  const observed =
    typeof observed_at === "string" && observed_at.length < 40
      ? Date.parse(observed_at)
      : NaN;
  if (!Number.isFinite(observed) || observed > now + 5 * 60_000) return;
  const result: ClaudeRateLimitSnapshot = {
    observed_at: new Date(observed).toISOString(),
    windows: {},
  };
  for (const [key] of WINDOWS) {
    const reading = window(windows?.[key], now);
    if (reading) result.windows[key] = reading;
  }
  return Object.keys(result.windows).length ? result : undefined;
}

/** Display form of a stored snapshot. */
export function claudeSubscriptionUsage(
  value: unknown,
  now = Date.now(),
): ClaudeSubscriptionUsage | undefined {
  const snapshot = parseClaudeRateLimitSnapshot(value, now);
  if (!snapshot) return;
  const windows: ClaudeUsageWindow[] = [];
  for (const [key, name] of WINDOWS) {
    const reading = snapshot.windows[key];
    if (!reading) continue;
    const resetSinceObserved = reading.resets_at * 1000 <= now;
    const projection = resetSinceObserved
      ? undefined
      : claudeUsageProjection({
          utilization: reading.utilization,
          resetsAtMs: reading.resets_at * 1000,
          observedAtMs: Date.parse(snapshot.observed_at),
          lengthMs: WINDOW_LENGTH_MS[key],
        });
    windows.push({
      name,
      usedPercent: Math.round(reading.utilization * 100),
      resetsAt: new Date(reading.resets_at * 1000).toISOString(),
      ...(resetSinceObserved ? { resetSinceObserved } : {}),
      ...(projection ? { projection } : {}),
    });
  }
  return { observedAt: snapshot.observed_at, windows };
}
