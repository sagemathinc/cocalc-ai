/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Fresh readings for Auto: Claude reports a subscription's limits only with a
// model response, so a subscription used elsewhere (another site, claude.ai)
// or not lately here keeps an old reading, and the forecast misses that use.
// The home bay checks such subscriptions with a one-word Haiku reply
// (project-host/acp/claude-usage-probe.ts), at most once per
// CLAUDE_USAGE_PROBE_AFTER_MS each, for accounts that use Auto and turned
// the checks on (CLAUDE_USAGE_REFRESH_SETTING). Each check is a request
// through the subscription, so it is off unless the user turns it on.

import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_LIMITED_METADATA_KEY,
} from "./claude-pool";
import { CLAUDE_USAGE_METADATA_KEY } from "./claude-usage";
import { isIsoTime } from "./claude-usage-sql";

/** Credential metadata: the last check, { at (ISO), ok, error? }. */
export const CLAUDE_USAGE_PROBE_METADATA_KEY = "claude_usage_probe";

/** Account other_settings: the user's opt-in to these checks, off by
 * default (in Claude Code settings). Without it, no check is ever sent
 * through the account's subscriptions. */
export const CLAUDE_USAGE_REFRESH_SETTING = "claude_usage_refresh";

const HOUR_MS = 3600_000;
/** A reading older than this is checked again (as is a check this old). */
export const CLAUDE_USAGE_PROBE_AFTER_MS = 4 * HOUR_MS;
/** Only accounts with an Auto pick this recently are checked. */
export const CLAUDE_USAGE_PROBE_ACTIVE_MS = 7 * 24 * HOUR_MS;
/** A 5-hour window this full cannot answer until it resets. */
export const CLAUDE_USAGE_PROBE_FULL = 0.98;
/** A reading time later than now by more than this is not a reading (as in
 * parseClaudeRateLimitSnapshot). */
export const CLAUDE_USAGE_PROBE_FUTURE_MS = 5 * 60_000;
/** A reset later than now by more than this is not a reading (as in
 * util/ai/claude-usage.ts). */
export const CLAUDE_USAGE_PROBE_MAX_RESET_MS = 366 * 24 * HOUR_MS;

export interface ClaudeUsageProbeRecord {
  at: string;
  ok?: boolean;
  error?: string;
}

export function parseClaudeUsageProbe(
  value: unknown,
): ClaudeUsageProbeRecord | undefined {
  if (!value || typeof value !== "object") return;
  const { at, ok, error } = value as Record<string, unknown>;
  if (!isIsoTime(at)) return;
  return {
    at,
    ...(typeof ok === "boolean" ? { ok } : {}),
    ...(typeof error === "string" ? { error: error.slice(0, 300) } : {}),
  };
}

/**
 * Whether one of an account's subscriptions needs a fresh reading now.
 * The home bay's query (server/agents/claude-usage-probe.ts) applies exactly
 * this rule to the same raw values; keep them the same. Times count only as
 * isIsoTime allows, and then compare as text.
 */
export function claudeUsageProbeDue(
  metadata: Record<string, any> | null | undefined,
  now = Date.now(),
): boolean {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] === true) return false;
  const until = metadata?.[CLAUDE_POOL_LIMITED_METADATA_KEY]?.until;
  if (isIsoTime(until) && until >= iso(now)) return false;
  const checked = metadata?.[CLAUDE_USAGE_PROBE_METADATA_KEY]?.at;
  const stale = iso(now - CLAUDE_USAGE_PROBE_AFTER_MS);
  if (isIsoTime(checked) && checked >= stale) return false;
  const usage = metadata?.[CLAUDE_USAGE_METADATA_KEY];
  const observed = usage?.observed_at;
  // A reading time in the future is no reading.
  if (
    isIsoTime(observed) &&
    observed >= stale &&
    observed <= iso(now + CLAUDE_USAGE_PROBE_FUTURE_MS)
  )
    return false;
  // A 5-hour window that was full and has not reset cannot answer yet.
  const session = usage?.windows?.five_hour;
  const utilization = session?.utilization;
  const resets = session?.resets_at;
  return !(
    typeof utilization === "number" &&
    utilization >= CLAUDE_USAGE_PROBE_FULL &&
    utilization <= 10 &&
    Number.isInteger(resets) &&
    resets * 1000 > now &&
    resets * 1000 - now <= CLAUDE_USAGE_PROBE_MAX_RESET_MS
  );
}
