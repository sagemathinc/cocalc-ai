/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

export const SITE_FUNDED_CODEX_PRICE_VERSION = "openai-2026-09-22";

export type SiteFundedCodexPrice = {
  version: string;
  provider: "openai" | "anthropic";
  model: string;
  effectiveAt: string;
  sourceUrl: string;
  verifiedAt: string;
  inputUsdPerMillion: string;
  cachedInputUsdPerMillion: string;
  cacheWriteUsdPerMillion: string;
  /** Anthropic's 1-hour cache writes; absent where a provider has none. */
  cacheWrite1hUsdPerMillion?: string;
  outputUsdPerMillion: string;
  longContextThresholdTokens: number;
  longContextInputMultiplier: string;
  longContextOutputMultiplier: string;
};

const GPT_5_6_LUNA_PRICE: SiteFundedCodexPrice = {
  version: "openai-2026-07-30",
  provider: "openai",
  model: "gpt-5.6-luna",
  effectiveAt: "2026-07-30T00:00:00.000Z",
  sourceUrl: "https://openai.com/business/pricing/#api",
  verifiedAt: "2026-08-02T00:00:00.000Z",
  inputUsdPerMillion: "0.20",
  cachedInputUsdPerMillion: "0.02",
  cacheWriteUsdPerMillion: "0.25",
  outputUsdPerMillion: "1.20",
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: "2",
  longContextOutputMultiplier: "1.5",
};

const GPT_6_LUNA_PRICE: SiteFundedCodexPrice = {
  version: SITE_FUNDED_CODEX_PRICE_VERSION,
  provider: "openai",
  model: "gpt-6-luna",
  effectiveAt: "2026-09-22T00:00:00.000Z",
  sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-luna",
  verifiedAt: "2026-09-23T00:00:00.000Z",
  inputUsdPerMillion: "0.10",
  cachedInputUsdPerMillion: "0.01",
  cacheWriteUsdPerMillion: "0.125",
  outputUsdPerMillion: "0.50",
  longContextThresholdTokens: 272_000,
  longContextInputMultiplier: "2",
  longContextOutputMultiplier: "1.5",
};

// Priced by prompt length: a request whose prompt (all input, cache reads
// and writes included) is over 100,000 tokens pays 5x for every category.
const CLAUDE_HAIKU_5_5_PRICE: SiteFundedCodexPrice = {
  version: "anthropic-2026-10-24",
  provider: "anthropic",
  model: "claude-haiku-5-5",
  effectiveAt: "2026-10-24T00:00:00.000Z",
  sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
  verifiedAt: "2026-10-24T00:00:00.000Z",
  inputUsdPerMillion: "0.10",
  cachedInputUsdPerMillion: "0.01",
  cacheWriteUsdPerMillion: "0.125",
  cacheWrite1hUsdPerMillion: "0.20",
  outputUsdPerMillion: "0.50",
  longContextThresholdTokens: 100_000,
  longContextInputMultiplier: "5",
  longContextOutputMultiplier: "5",
};

const PRICE_CATALOG = new Map<string, SiteFundedCodexPrice>([
  [GPT_5_6_LUNA_PRICE.model, GPT_5_6_LUNA_PRICE],
  [GPT_6_LUNA_PRICE.model, GPT_6_LUNA_PRICE],
  [CLAUDE_HAIKU_5_5_PRICE.model, CLAUDE_HAIKU_5_5_PRICE],
]);

export type SiteFundedProvider = SiteFundedCodexPrice["provider"];

/** A verified price, of `provider`'s models only when one is given. */
export function hasSiteFundedCodexPrice(
  model: string,
  provider?: SiteFundedProvider,
): boolean {
  const price = PRICE_CATALOG.get(`${model ?? ""}`.trim());
  return price != null && (provider == null || price.provider === provider);
}

export function getSiteFundedCodexPrice(
  model: string,
  provider?: SiteFundedProvider,
): SiteFundedCodexPrice {
  const price = PRICE_CATALOG.get(`${model ?? ""}`.trim());
  if (!price || (provider != null && price.provider !== provider)) {
    throw new Error(
      `no exact site-funded Codex price is configured for model '${model}'`,
    );
  }
  return price;
}
