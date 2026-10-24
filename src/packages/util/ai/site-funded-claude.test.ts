/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import {
  computeSiteFundedCodexRequestCost,
  getSiteFundedCodexPrice,
  hasSiteFundedCodexPrice,
} from "./site-funded-codex";
import {
  siteFundedKeyPeriodBounds,
  siteFundedUsageFromAnthropic,
} from "./site-funded-claude";
import { EXTRAS } from "../db-schema/site-settings-extras";

const cost = (usage: Parameters<typeof siteFundedUsageFromAnthropic>[0]) =>
  computeSiteFundedCodexRequestCost({
    model: "claude-haiku-5-5",
    usage: siteFundedUsageFromAnthropic(usage),
  });

describe("site-funded Claude accounting", () => {
  it("uses the verified Claude Haiku 5.5 price, 5x over 100,000 tokens", () => {
    expect(getSiteFundedCodexPrice("claude-haiku-5-5")).toMatchObject({
      provider: "anthropic",
      inputUsdPerMillion: "0.10",
      cachedInputUsdPerMillion: "0.01",
      cacheWriteUsdPerMillion: "0.125",
      cacheWrite1hUsdPerMillion: "0.20",
      outputUsdPerMillion: "0.50",
      longContextThresholdTokens: 100_000,
      longContextInputMultiplier: "5",
      longContextOutputMultiplier: "5",
    });
    expect(hasSiteFundedCodexPrice("claude-haiku-5-5", "anthropic")).toBe(true);
  });

  it("never offers a Claude price as a Codex model", () => {
    expect(hasSiteFundedCodexPrice("claude-haiku-5-5", "openai")).toBe(false);
    expect(() => getSiteFundedCodexPrice("claude-haiku-5-5", "openai")).toThrow(
      /no exact site-funded/,
    );
    const valid = EXTRAS.site_funded_codex_model.valid as (
      value: string,
    ) => boolean;
    expect(valid("claude-haiku-5-5")).toBe(false);
    expect(valid("gpt-6-luna")).toBe(true);
  });

  it("prices every input category, 1-hour cache writes and web searches", () => {
    expect(
      cost({
        input_tokens: 1_000,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 14_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 10_000,
          ephemeral_1h_input_tokens: 4_000,
        },
        output_tokens: 2_000,
        server_tool_use: { web_search_requests: 3 },
      }),
    ).toMatchObject({
      longContext: false,
      ordinaryInputTokens: 1_000,
      cachedInputTokens: 50_000,
      cacheWriteInputTokens: 14_000,
      cacheWrite1hInputTokens: 4_000,
      ordinaryInputCostMicrousd: 100,
      cachedInputCostMicrousd: 500,
      // 10,000 x 0.125 + 4,000 x 0.20
      cacheWriteInputCostMicrousd: 2_050,
      outputCostMicrousd: 1_000,
      providerToolFeesMicrousd: 30_000,
      costMicrousd: 33_650,
    });
  });

  it("prices a prompt of exactly 100,000 tokens at the standard rate", () => {
    expect(cost({ input_tokens: 100_000 })).toMatchObject({
      longContext: false,
      costMicrousd: 10_000,
    });
  });

  it("prices a prompt over 100,000 tokens at 5x, output included", () => {
    expect(cost({ input_tokens: 100_001, output_tokens: 1_000 })).toMatchObject(
      {
        longContext: true,
        // 100,001 x 0.10 x 5 = 50,000.5, rounded up
        ordinaryInputCostMicrousd: 50_001,
        outputCostMicrousd: 2_500,
        costMicrousd: 52_501,
      },
    );
  });

  it("counts cache reads and writes toward the 100,000-token threshold", () => {
    expect(
      cost({ input_tokens: 1, cache_read_input_tokens: 100_000 }),
    ).toMatchObject({
      longContext: true,
      // (1 x 0.10 + 100,000 x 0.01) x 5
      costMicrousd: 5_001,
    });
    expect(
      cost({ input_tokens: 1, cache_creation_input_tokens: 100_000 }),
    ).toMatchObject({ longContext: true });
  });

  it("takes the cache write total from the breakdown when it is missing", () => {
    expect(
      siteFundedUsageFromAnthropic({
        input_tokens: 10,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 2,
        },
      }),
    ).toMatchObject({
      inputTokens: 15,
      cacheWriteInputTokens: 5,
      cacheWrite1hInputTokens: 2,
    });
  });

  it("prices cache writes the breakdown does not explain as 1-hour writes", () => {
    // No breakdown: all of it at the 1-hour rate.
    expect(
      siteFundedUsageFromAnthropic({
        input_tokens: 0,
        cache_creation_input_tokens: 1_000,
      }),
    ).toMatchObject({
      cacheWriteInputTokens: 1_000,
      cacheWrite1hInputTokens: 1_000,
    });
    expect(
      cost({ input_tokens: 0, cache_creation_input_tokens: 1_000 }),
    ).toMatchObject({ cacheWriteInputCostMicrousd: 200 });
    // A short breakdown: the unexplained 400 at the 1-hour rate.
    expect(
      cost({
        input_tokens: 0,
        cache_creation_input_tokens: 1_000,
        cache_creation: { ephemeral_5m_input_tokens: 600 },
      }),
    ).toMatchObject({
      cacheWrite1hInputTokens: 400,
      // 600 x 0.125 + 400 x 0.20
      cacheWriteInputCostMicrousd: 155,
    });
  });

  it("rejects malformed usage", () => {
    expect(() => siteFundedUsageFromAnthropic({ input_tokens: -1 })).toThrow();
    expect(() =>
      siteFundedUsageFromAnthropic({ output_tokens: 1.5 }),
    ).toThrow();
    expect(() =>
      siteFundedUsageFromAnthropic({
        cache_creation_input_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 2 },
      }),
    ).toThrow(/breakdown/);
  });

  it("refuses 1-hour cache writes for a model without that price", () => {
    expect(() =>
      computeSiteFundedCodexRequestCost({
        model: "gpt-6-luna",
        usage: {
          inputTokens: 10,
          cacheWriteInputTokens: 5,
          cacheWrite1hInputTokens: 5,
          outputTokens: 0,
        },
      }),
    ).toThrow(/1-hour/);
  });
});

describe("a site key's monthly period", () => {
  const bounds = (now: string, resetDay = 15, resetHour = 8) => {
    const { start, end } = siteFundedKeyPeriodBounds({
      resetDay,
      resetHour,
      now: new Date(now),
    });
    return [start.toISOString(), end.toISOString()];
  };

  it("starts at this month's reset point once it has passed", () => {
    expect(bounds("2026-10-24T17:00:00Z")).toEqual([
      "2026-10-15T08:00:00.000Z",
      "2026-11-15T08:00:00.000Z",
    ]);
    expect(bounds("2026-10-15T08:00:00Z")).toEqual([
      "2026-10-15T08:00:00.000Z",
      "2026-11-15T08:00:00.000Z",
    ]);
  });

  it("starts at last month's reset point before this month's", () => {
    expect(bounds("2026-10-15T07:59:59Z")).toEqual([
      "2026-09-15T08:00:00.000Z",
      "2026-10-15T08:00:00.000Z",
    ]);
    expect(bounds("2027-01-03T00:00:00Z", 28, 23)).toEqual([
      "2026-12-28T23:00:00.000Z",
      "2027-01-28T23:00:00.000Z",
    ]);
  });

  it("only resets on day 1-28 at hour 0-23", () => {
    for (const [day, hour] of [
      [0, 0],
      [29, 0],
      [1, 24],
      [1.5, 0],
    ]) {
      expect(() =>
        siteFundedKeyPeriodBounds({ resetDay: day, resetHour: hour }),
      ).toThrow(/day 1-28/);
    }
  });
});
