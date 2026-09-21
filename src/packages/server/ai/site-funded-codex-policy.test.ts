/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { siteFundedCodexConfigurationFromSettings } from "./site-funded-codex-policy";

describe("site-funded Codex policy", () => {
  it("parses bounded operator settings", () => {
    const config = siteFundedCodexConfigurationFromSettings({
      site_funded_codex_enabled: "yes",
      site_funded_codex_model: "gpt-5.6-luna",
      site_funded_codex_max_turn_usd: "0.025",
      site_funded_codex_max_turn_seconds: "600",
      site_funded_codex_max_input_tokens_per_request: "90000",
      site_funded_codex_max_output_tokens_per_request: "4000",
      site_funded_codex_max_requests_per_turn: "20",
      site_funded_codex_global_pool_weekly_usd: "90",
      site_funded_codex_free_pool_weekly_usd: "25",
      site_funded_codex_paid_pool_weekly_usd: "75",
      site_funded_codex_global_concurrency: "12",
    });
    expect(config.enabled).toBe(true);
    expect(config.policy).toMatchObject({
      version: 7,
      model: "gpt-5.6-luna",
      reasoning: "medium",
      serviceTier: "standard",
      maxConcurrentTurnsPerAccount: 50,
      maxTurnCostMicrousd: 25_000,
      maxTurnDurationMs: 600_000,
      contextWindowTokens: 90_000,
      autoCompactTokenLimit: 67_500,
      maxOutputTokensPerRequest: 4_000,
      maxRequestsPerTurn: 20,
    });
    expect(config.globalPoolWeeklyLimitMicrousd).toBe(90_000_000);
    expect(config.freePoolWeeklyLimitMicrousd).toBe(25_000_000);
    expect(config.paidPoolWeeklyLimitMicrousd).toBe(75_000_000);
    expect(config.globalConcurrency).toBe(12);
  });

  it("keeps low reasoning available as an explicit override", () => {
    const config = siteFundedCodexConfigurationFromSettings({
      site_funded_codex_reasoning: "low",
    });
    expect(config.policy.reasoning).toBe("low");
  });

  it("fails closed for an unpriced model", () => {
    expect(() =>
      siteFundedCodexConfigurationFromSettings({
        site_funded_codex_enabled: "yes",
        site_funded_codex_model: "gpt-5.6-sol",
      }),
    ).toThrow("no exact site-funded Codex price");
  });
});
