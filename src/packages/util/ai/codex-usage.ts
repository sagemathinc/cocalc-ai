/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// ChatGPT Codex plan limits as Codex reports them (account/rateLimits/read,
// and account/rateLimits/updated during a turn), stored on the subscription's
// credential like Claude's (claude-usage.ts), in the same shape: a 5-hour and
// a weekly window, each a fraction used and when it resets. So the history,
// rate and forecast code is shared.

import {
  parseClaudeRateLimitSnapshot,
  type ClaudeRateLimitSnapshot,
} from "./claude-usage";

/** Credential metadata: the latest snapshot (ClaudeRateLimitSnapshot shape). */
export const CODEX_USAGE_METADATA_KEY = "codex_usage";
/** Credential metadata: recent weekly readings (ClaudeUsageReading[]). */
export const CODEX_USAGE_HISTORY_METADATA_KEY = "codex_usage_history";

const FIVE_HOURS_MINS = 300;
const WEEK_MINS = 7 * 24 * 60;

type CodexWindow = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

/** The Codex limit set in a reported value: a RateLimitSnapshot, the
 * notification's { rateLimits }, or a read response keyed by limit. */
function codexLimits(value: unknown): Record<string, any> | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as Record<string, any>;
  const byId = data.rateLimitsByLimitId ?? data.rate_limits_by_limit_id;
  const candidate = byId?.codex ?? data.rateLimits ?? data.rate_limits ?? data;
  return candidate && typeof candidate === "object" ? candidate : undefined;
}

function reading(
  window: CodexWindow | null | undefined,
): { utilization: number; resets_at: number } | undefined {
  if (!window || typeof window !== "object") return;
  const used = window.usedPercent ?? (window as any).used_percent;
  const resets = window.resetsAt ?? (window as any).resets_at;
  if (typeof used !== "number" || !Number.isFinite(used)) return;
  if (typeof resets !== "number" || !Number.isFinite(resets)) return;
  return { utilization: used / 100, resets_at: Math.round(resets) };
}

function windowKey(
  window: CodexWindow | null | undefined,
  fallback: "five_hour" | "seven_day",
): "five_hour" | "seven_day" | undefined {
  const mins =
    window?.windowDurationMins ?? (window as any)?.window_duration_mins;
  if (mins == null) return fallback;
  if (mins === FIVE_HOURS_MINS) return "five_hour";
  if (mins === WEEK_MINS) return "seven_day";
  // A window of another length is not one of the two this tracks.
  return undefined;
}

/**
 * A snapshot from what Codex reported: primary is the 5-hour window and
 * secondary the weekly one (by their stated lengths, when given). Only the
 * revalidated numbers are kept; undefined when it names no usable window.
 */
export function codexRateLimitSnapshot(
  value: unknown,
  now = Date.now(),
): ClaudeRateLimitSnapshot | undefined {
  const limits = codexLimits(value);
  if (!limits) return;
  const windows: Record<string, unknown> = {};
  for (const [name, fallback] of [
    ["primary", "five_hour"],
    ["secondary", "seven_day"],
  ] as const) {
    const window = limits[name] as CodexWindow | null | undefined;
    const key = windowKey(window, fallback);
    const read = reading(window);
    if (key && read && windows[key] == null) windows[key] = read;
  }
  return parseClaudeRateLimitSnapshot(
    { observed_at: new Date(now).toISOString(), windows },
    now,
  );
}

/**
 * The stored snapshot after a new report. Codex's rolling updates may carry
 * only some windows, so a window the report lacks keeps its stored reading
 * until that reading's reset passes (then it is unknown, not 0).
 */
export function mergeCodexUsage(
  stored: unknown,
  next: ClaudeRateLimitSnapshot,
  now = Date.now(),
): ClaudeRateLimitSnapshot {
  const previous = parseClaudeRateLimitSnapshot(stored, now);
  const windows = { ...next.windows };
  for (const key of ["five_hour", "seven_day"] as const) {
    const old = previous?.windows[key];
    if (!windows[key] && old && old.resets_at * 1000 > now) windows[key] = old;
  }
  return { observed_at: next.observed_at, windows };
}
