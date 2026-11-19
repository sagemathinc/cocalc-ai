/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Fresh readings for Auto: Claude reports a subscription's limits only with a
// model response, so a subscription used elsewhere (another site, claude.ai)
// or not lately here keeps an old reading, and the forecast misses that use.
// The home bay checks such subscriptions with a one-word Haiku reply
// (project-host/acp/claude-usage-probe.ts), at most once per
// CLAUDE_USAGE_PROBE_AFTER_MS each, for accounts that use Auto.

import {
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_LIMITED_METADATA_KEY,
  CLAUDE_USAGE_HISTORY_METADATA_KEY,
} from "./claude-pool";
import {
  CLAUDE_USAGE_METADATA_KEY,
  parseClaudeRateLimitSnapshot,
} from "./claude-usage";

/** Credential metadata: the last check, { at (ISO), ok, error? }. */
export const CLAUDE_USAGE_PROBE_METADATA_KEY = "claude_usage_probe";

const HOUR_MS = 3600_000;
/** A reading older than this is checked again (as is a check this old). */
export const CLAUDE_USAGE_PROBE_AFTER_MS = 4 * HOUR_MS;
/** Only accounts with an Auto pick this recently are checked. */
export const CLAUDE_USAGE_PROBE_ACTIVE_MS = 7 * 24 * HOUR_MS;
// A 5-hour window this full cannot answer until it resets.
const FULL = 0.98;

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
  if (
    typeof at !== "string" ||
    at.length > 40 ||
    !Number.isFinite(Date.parse(at))
  )
    return;
  return {
    at,
    ...(typeof ok === "boolean" ? { ok } : {}),
    ...(typeof error === "string" ? { error: error.slice(0, 300) } : {}),
  };
}

/** Whether one of an account's subscriptions needs a fresh reading now. */
export function claudeUsageProbeDue(
  metadata: Record<string, any> | null | undefined,
  now = Date.now(),
): boolean {
  if (metadata?.[CLAUDE_POOL_EXCLUDED_METADATA_KEY] === true) return false;
  const limited = Date.parse(
    metadata?.[CLAUDE_POOL_LIMITED_METADATA_KEY]?.until,
  );
  if (Number.isFinite(limited) && limited > now) return false;
  const probe = parseClaudeUsageProbe(
    metadata?.[CLAUDE_USAGE_PROBE_METADATA_KEY],
  );
  if (probe && Date.parse(probe.at) > now - CLAUDE_USAGE_PROBE_AFTER_MS)
    return false;
  const reading = parseClaudeRateLimitSnapshot(
    metadata?.[CLAUDE_USAGE_METADATA_KEY],
    now,
  );
  if (!reading) return true;
  if (Date.parse(reading.observed_at) > now - CLAUDE_USAGE_PROBE_AFTER_MS)
    return false;
  const session = reading.windows.five_hour;
  return !(
    session &&
    session.utilization >= FULL &&
    session.resets_at * 1000 > now
  );
}

/** Whether the account used Auto lately: a pick records each member's
 * reading in its usage history. */
export function claudeAccountUsesAuto(
  rows: { metadata?: Record<string, any> | null }[],
  now = Date.now(),
): boolean {
  return rows.some((row) => {
    const history = row.metadata?.[CLAUDE_USAGE_HISTORY_METADATA_KEY];
    if (!Array.isArray(history) || history.length === 0) return false;
    const at = Number(history[history.length - 1]?.at);
    return Number.isFinite(at) && at > now - CLAUDE_USAGE_PROBE_ACTIVE_MS;
  });
}
