/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

export const SITE_FUNDED_CODEX_PRICE_VERSION = "openai-2026-09-22";

export type SiteFundedCodexPrice = {
  version: string;
  provider: "openai";
  model: string;
  effectiveAt: string;
  sourceUrl: string;
  verifiedAt: string;
  inputUsdPerMillion: string;
  cachedInputUsdPerMillion: string;
  cacheWriteUsdPerMillion: string;
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

const PRICE_CATALOG = new Map<string, SiteFundedCodexPrice>([
  [GPT_5_6_LUNA_PRICE.model, GPT_5_6_LUNA_PRICE],
  [GPT_6_LUNA_PRICE.model, GPT_6_LUNA_PRICE],
]);

export function hasSiteFundedCodexPrice(model: string): boolean {
  return PRICE_CATALOG.has(`${model ?? ""}`.trim());
}

export function getSiteFundedCodexPrice(model: string): SiteFundedCodexPrice {
  const price = PRICE_CATALOG.get(`${model ?? ""}`.trim());
  if (!price) {
    throw new Error(
      `no exact site-funded Codex price is configured for model '${model}'`,
    );
  }
  return price;
}
