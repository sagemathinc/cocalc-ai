/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Site-funded Claude: Anthropic Messages API usage, in the shared funded
// accounting (see site-funded-codex.ts for the cost of a request).

import {
  DEFAULT_SITE_FUNDED_CODEX_POLICY,
  type SiteFundedCodexPolicy,
  type SiteFundedCodexRequestUsage,
} from "./site-funded-codex";

/** Web search is $10 per 1,000 searches, on top of its tokens. */
export const ANTHROPIC_WEB_SEARCH_MICROUSD = 10_000;

/** The `usage` of an Anthropic Messages API response. */
export type AnthropicMessagesUsage = {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  output_tokens?: number | null;
  server_tool_use?: {
    web_search_requests?: number | null;
    web_fetch_requests?: number | null;
  } | null;
};

function count(value: number | null | undefined, name: string): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return normalized;
}

/**
 * Anthropic reports input without its cache reads and writes; the funded
 * accounting counts all input, so a request's prompt length (what prices it
 * over 100,000 tokens) is the sum of the three.
 */
export function siteFundedUsageFromAnthropic(
  usage: AnthropicMessagesUsage,
): SiteFundedCodexRequestUsage {
  const input = count(usage.input_tokens, "input_tokens");
  const cacheRead = count(
    usage.cache_read_input_tokens,
    "cache_read_input_tokens",
  );
  const cacheWrite5m = count(
    usage.cache_creation?.ephemeral_5m_input_tokens,
    "ephemeral_5m_input_tokens",
  );
  const cacheWrite1h = count(
    usage.cache_creation?.ephemeral_1h_input_tokens,
    "ephemeral_1h_input_tokens",
  );
  const cacheWrite =
    usage.cache_creation_input_tokens == null
      ? cacheWrite5m + cacheWrite1h
      : count(usage.cache_creation_input_tokens, "cache_creation_input_tokens");
  if (cacheWrite5m + cacheWrite1h > cacheWrite) {
    throw new Error(
      "cache write breakdown exceeds cache_creation_input_tokens",
    );
  }
  // The breakdown should account for every cache write. Any it does not (a
  // missing or short breakdown) is priced as the dearer 1-hour write: never
  // undercharged, and still recorded rather than refused.
  const cacheWrite1hPriced = cacheWrite - cacheWrite5m;
  const searches = count(
    usage.server_tool_use?.web_search_requests,
    "web_search_requests",
  );
  const inputTokens = input + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(inputTokens)) {
    throw new Error("input tokens are outside the supported range");
  }
  return {
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    cacheWrite1hInputTokens: cacheWrite1hPriced,
    outputTokens: count(usage.output_tokens, "output_tokens"),
    providerToolFeesMicrousd: searches * ANTHROPIC_WEB_SEARCH_MICROUSD,
  };
}

/** Site-funded Claude: like Codex's policy, with Claude Haiku 5.5. */
export const DEFAULT_SITE_FUNDED_CLAUDE_POLICY: SiteFundedCodexPolicy = {
  ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
  model: "claude-haiku-5-5",
  // Claude Code compacts at about 80% of a 100,000-token window, below the
  // price that applies to longer prompts.
  contextWindowTokens: 100_000,
  autoCompactTokenLimit: 80_000,
};

/**
 * The monthly period a site key's spend limit applies to: from its reset
 * point (day of month 1-28 and hour, UTC) at or before `now`, to the same
 * point a month later.
 */
export function siteFundedKeyPeriodBounds({
  resetDay,
  resetHour,
  now = new Date(),
}: {
  resetDay: number;
  resetHour: number;
  now?: Date;
}): { start: Date; end: Date } {
  if (
    !Number.isInteger(resetDay) ||
    resetDay < 1 ||
    resetDay > 28 ||
    !Number.isInteger(resetHour) ||
    resetHour < 0 ||
    resetHour > 23
  ) {
    throw new Error("a key resets on day 1-28 at hour 0-23 (UTC)");
  }
  const at = (year: number, month: number) =>
    new Date(Date.UTC(year, month, resetDay, resetHour));
  let start = at(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { start, end: at(start.getUTCFullYear(), start.getUTCMonth() + 1) };
}

/** A site key as admins see it: never its secret. */
export type SiteFundedProviderKeyInfo = {
  keyId: string;
  provider: "openai" | "anthropic";
  label: string;
  /** The key's last four characters, to tell keys apart. */
  last4: string;
  monthlyLimitMicrousd: number;
  resetDay: number;
  resetHour: number;
  position: number;
  enabled: boolean;
  periodStart: string;
  periodEnd: string;
  /** Committed spend plus what running turns may still spend. */
  exposureMicrousd: number;
};

/** What an admin can do to the site's Claude keys. */
export type SiteFundedProviderKeyAction =
  | {
      op: "add";
      label: string;
      apiKey: string;
      monthlyLimitUsd: number;
      resetDay: number;
      resetHour: number;
    }
  | {
      op: "update";
      keyId: string;
      label?: string;
      monthlyLimitUsd?: number;
      resetDay?: number;
      resetHour?: number;
      enabled?: boolean;
    }
  | { op: "remove"; keyId: string }
  /** Every key, in the new order. */
  | { op: "reorder"; keyIds: string[] };
