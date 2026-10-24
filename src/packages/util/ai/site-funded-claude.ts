/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

// Site-funded Claude: Anthropic Messages API usage, in the shared funded
// accounting (see site-funded-codex.ts for the cost of a request).

import type { SiteFundedCodexRequestUsage } from "./site-funded-codex";

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
