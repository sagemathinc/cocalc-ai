/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import {
  computeSiteFundedCodexRequestCost,
  DEFAULT_SITE_FUNDED_CODEX_POLICY,
  formatSiteFundedLimitDetail,
  formatSiteFundedReset,
  formatSiteFundedUsageWarning,
  getSiteFundedCodexPrice,
  hasSiteFundedCodexPrice,
  microusdToUsageUnits,
  SITE_FUNDED_CODEX_MAX_REQUEST_BODY_BYTES,
  siteFundedCodexFinalRequestHeadroomMicrousd,
  siteFundedCodexMaxRequestBodyBytes,
  siteFundedUsageWarning,
  usdToMicrousd,
} from "./site-funded-codex";

describe("site-funded Codex accounting", () => {
  it("uses the verified GPT-6 Luna Standard price", () => {
    expect(getSiteFundedCodexPrice("gpt-6-luna")).toMatchObject({
      version: "openai-2026-09-22",
      inputUsdPerMillion: "0.10",
      cachedInputUsdPerMillion: "0.01",
      cacheWriteUsdPerMillion: "0.125",
      outputUsdPerMillion: "0.50",
      longContextThresholdTokens: 272_000,
      longContextInputMultiplier: "2",
      longContextOutputMultiplier: "1.5",
    });
    expect(hasSiteFundedCodexPrice("gpt-6-luna")).toBe(true);
    expect(hasSiteFundedCodexPrice("gpt-6-sol")).toBe(false);
  });

  it("prices GPT-6 Luna input and output without a cent minimum", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-6-luna",
      usage: { inputTokens: 10_000, outputTokens: 500 },
    });
    expect(cost.costMicrousd).toBe(1_250);
    expect(microusdToUsageUnits(cost.costMicrousd)).toBe(0.125);
  });

  it("prices ordinary Luna input and output without a cent minimum", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-5.6-luna",
      usage: { inputTokens: 10_000, outputTokens: 500 },
    });
    expect(cost.costMicrousd).toBe(2_600);
    expect(microusdToUsageUnits(cost.costMicrousd)).toBe(0.26);
  });

  it("treats cached reads and writes as subsets of total input", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-5.6-luna",
      usage: {
        inputTokens: 10_000,
        cachedInputTokens: 6_000,
        cacheWriteInputTokens: 1_000,
        outputTokens: 500,
      },
    });
    expect(cost.ordinaryInputTokens).toBe(3_000);
    expect(cost.costMicrousd).toBe(1_570);
  });

  it("bills reasoning tokens once as part of output", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-5.6-luna",
      usage: {
        inputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 800,
      },
    });
    expect(cost.outputCostMicrousd).toBe(1_200);
    expect(cost.costMicrousd).toBe(1_200);
  });

  it("applies long-context multipliers per request", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-5.6-luna",
      usage: { inputTokens: 272_001, outputTokens: 1_000 },
    });
    expect(cost.longContext).toBe(true);
    expect(cost.ordinaryInputCostMicrousd).toBe(108_801);
    expect(cost.outputCostMicrousd).toBe(1_800);
    expect(cost.costMicrousd).toBe(110_601);
  });

  it("includes separately reported provider tool fees", () => {
    const cost = computeSiteFundedCodexRequestCost({
      model: "gpt-5.6-luna",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        providerToolFeesMicrousd: 5_000,
      },
    });
    expect(cost.costMicrousd).toBe(5_000);
  });

  it("rejects unknown funded models", () => {
    expect(() => getSiteFundedCodexPrice("gpt-5.6-sol")).toThrow(
      "no exact site-funded Codex price",
    );
  });

  it("rejects malformed subset usage", () => {
    expect(() =>
      computeSiteFundedCodexRequestCost({
        model: "gpt-5.6-luna",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 90,
          cacheWriteInputTokens: 20,
          outputTokens: 0,
        },
      }),
    ).toThrow("cannot exceed total input");
  });

  it("converts configured dollar limits exactly to microusd", () => {
    expect(usdToMicrousd("0.05")).toBe(50_000);
    expect(usdToMicrousd(100)).toBe(100_000_000);
  });

  it("reserves a conservative final request exposure", () => {
    const policy = {
      ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
      contextWindowTokens: 10_000,
      maxOutputTokensPerRequest: 1_000,
    };
    expect(siteFundedCodexMaxRequestBodyBytes(policy)).toBe(
      SITE_FUNDED_CODEX_MAX_REQUEST_BODY_BYTES,
    );
    expect(siteFundedCodexFinalRequestHeadroomMicrousd(policy)).toBe(2_774);
  });
});

describe("site-funded usage warnings", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const in2h10m = "2026-10-27T14:10:00Z";

  it("does not warn below 80% or for a window without a limit", () => {
    expect(
      siteFundedUsageWarning([
        { window: "5h", used: 79.9, limit: 100 },
        { window: "7d", used: 50, limit: 0 },
      ]),
    ).toBeUndefined();
  });

  it("warns at 80% and at 95%", () => {
    expect(
      siteFundedUsageWarning([{ window: "5h", used: 80, limit: 100 }]),
    ).toEqual({ window: "5h", percent: 80, threshold: 80 });
    expect(
      siteFundedUsageWarning([
        { window: "7d", used: 950, limit: 1000, resetAt: in2h10m },
      ]),
    ).toEqual({ window: "7d", percent: 95, threshold: 95, resetAt: in2h10m });
  });

  it("picks the higher threshold, then the fuller window", () => {
    expect(
      siteFundedUsageWarning([
        { window: "5h", used: 90, limit: 100 },
        { window: "7d", used: 96, limit: 100 },
      ]),
    ).toMatchObject({ window: "7d", threshold: 95 });
    expect(
      siteFundedUsageWarning([
        { window: "5h", used: 88, limit: 100 },
        { window: "7d", used: 82, limit: 100 },
      ]),
    ).toMatchObject({ window: "5h", percent: 88 });
  });

  it("caps the percent of an overdrawn window at 100", () => {
    expect(
      siteFundedUsageWarning([{ window: "5h", used: 130, limit: 100 }]),
    ).toMatchObject({ percent: 100, threshold: 95 });
  });

  it("formats the reset time in UTC", () => {
    expect(formatSiteFundedReset(in2h10m, now)).toBe(
      "in about 2 h 10 min, at Oct 27, 14:10 UTC",
    );
    expect(formatSiteFundedReset("2026-10-30T12:00:00Z", now)).toBe(
      "in about 3 d, at Oct 30, 12:00 UTC",
    );
    expect(formatSiteFundedReset(undefined, now)).toBe("");
    expect(formatSiteFundedReset("not a date", now)).toBe("");
  });

  it("names the limit, its use, the reset and what to do", () => {
    expect(
      formatSiteFundedUsageWarning(
        { window: "5h", percent: 96, threshold: 95, resetAt: in2h10m },
        now,
      ),
    ).toBe(
      "You have used 96% of your 5-hour included AI allowance. It resets in about 2 h 10 min, at Oct 27, 14:10 UTC. When it runs out, agent turns that use it are refused until it resets; to keep working, upgrade your membership or use your own API key.",
    );
    expect(formatSiteFundedLimitDetail(in2h10m, now)).toBe(
      " It resets in about 2 h 10 min, at Oct 27, 14:10 UTC.",
    );
    expect(formatSiteFundedLimitDetail(undefined, now)).toBe("");
  });
});
