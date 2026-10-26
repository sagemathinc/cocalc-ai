/*
 *  This file is part of CoCalc: Copyright © 2026, SageMath, Inc.
 *  License: MS-RSL – see https://github.com/sagemathinc/cocalc-ai/blob/master/LICENSE.md
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  DEFAULT_SITE_FUNDED_CODEX_POLICY,
  getSiteFundedCodexPrice,
  type SiteFundedCodexPolicy,
  usdToMicrousd,
} from "@cocalc/util/ai/site-funded-codex";
import { DEFAULT_SITE_FUNDED_CLAUDE_POLICY } from "@cocalc/util/ai/site-funded-claude";
import { to_bool } from "@cocalc/util/db-schema/site-defaults";

type Settings = Record<string, unknown>;

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function positiveUsdMicrousd(value: unknown, fallback: number): number {
  try {
    const parsed = usdToMicrousd(`${value ?? ""}`);
    return parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export type SiteFundedCodexConfiguration = {
  enabled: boolean;
  policy: SiteFundedCodexPolicy;
  globalPoolWeeklyLimitMicrousd: number;
  freePoolWeeklyLimitMicrousd: number;
  paidPoolWeeklyLimitMicrousd: number;
  globalConcurrency: number;
};

export function siteFundedCodexConfigurationFromSettings(
  settings: Settings,
): SiteFundedCodexConfiguration {
  const model = `${
    settings.site_funded_codex_model ?? DEFAULT_SITE_FUNDED_CODEX_POLICY.model
  }`.trim();
  // This is deliberately an eager fail-closed validation.
  getSiteFundedCodexPrice(model, "openai");
  const policy: SiteFundedCodexPolicy = {
    ...DEFAULT_SITE_FUNDED_CODEX_POLICY,
    model,
    reasoning:
      settings.site_funded_codex_reasoning === "low"
        ? "low"
        : DEFAULT_SITE_FUNDED_CODEX_POLICY.reasoning,
    serviceTier: "standard",
    maxTurnCostMicrousd: positiveUsdMicrousd(
      settings.site_funded_codex_max_turn_usd,
      DEFAULT_SITE_FUNDED_CODEX_POLICY.maxTurnCostMicrousd,
    ),
    maxTurnDurationMs:
      positiveInteger(
        settings.site_funded_codex_max_turn_seconds,
        DEFAULT_SITE_FUNDED_CODEX_POLICY.maxTurnDurationMs / 1_000,
        24 * 60 * 60,
      ) * 1_000,
    contextWindowTokens: positiveInteger(
      settings.site_funded_codex_max_input_tokens_per_request,
      DEFAULT_SITE_FUNDED_CODEX_POLICY.contextWindowTokens,
      272_000,
    ),
    maxOutputTokensPerRequest: positiveInteger(
      settings.site_funded_codex_max_output_tokens_per_request,
      DEFAULT_SITE_FUNDED_CODEX_POLICY.maxOutputTokensPerRequest,
      128_000,
    ),
    maxRequestsPerTurn: positiveInteger(
      settings.site_funded_codex_max_requests_per_turn,
      DEFAULT_SITE_FUNDED_CODEX_POLICY.maxRequestsPerTurn,
      10_000,
    ),
  };
  policy.autoCompactTokenLimit = Math.min(
    policy.contextWindowTokens - 1,
    Math.floor(policy.contextWindowTokens * 0.75),
  );
  return {
    enabled: to_bool(settings.site_funded_codex_enabled),
    policy,
    globalPoolWeeklyLimitMicrousd: positiveUsdMicrousd(
      settings.site_funded_codex_global_pool_weekly_usd,
      100 * 1_000_000,
    ),
    freePoolWeeklyLimitMicrousd: positiveUsdMicrousd(
      settings.site_funded_codex_free_pool_weekly_usd,
      100 * 1_000_000,
    ),
    paidPoolWeeklyLimitMicrousd: positiveUsdMicrousd(
      settings.site_funded_codex_paid_pool_weekly_usd,
      100 * 1_000_000,
    ),
    globalConcurrency: positiveInteger(
      settings.site_funded_codex_global_concurrency,
      50,
      100_000,
    ),
  };
}

/**
 * Site-funded Claude: its own switch, model and per-turn guards; the same
 * weekly pools and concurrency as Codex (one included-AI budget).
 */
export function siteFundedClaudeConfigurationFromSettings(
  settings: Settings,
): SiteFundedCodexConfiguration {
  const shared = siteFundedCodexConfigurationFromSettings({
    ...settings,
    // Pools and concurrency only: an invalid Codex model must not disable
    // Claude.
    site_funded_codex_model: DEFAULT_SITE_FUNDED_CODEX_POLICY.model,
  });
  const model = `${
    settings.site_funded_claude_model ?? DEFAULT_SITE_FUNDED_CLAUDE_POLICY.model
  }`.trim();
  // This is deliberately an eager fail-closed validation.
  getSiteFundedCodexPrice(model, "anthropic");
  return {
    ...shared,
    enabled: to_bool(settings.site_funded_claude_enabled),
    policy: {
      ...DEFAULT_SITE_FUNDED_CLAUDE_POLICY,
      model,
      maxTurnCostMicrousd: positiveUsdMicrousd(
        settings.site_funded_claude_max_turn_usd,
        DEFAULT_SITE_FUNDED_CLAUDE_POLICY.maxTurnCostMicrousd,
      ),
      maxTurnDurationMs:
        positiveInteger(
          settings.site_funded_claude_max_turn_seconds,
          DEFAULT_SITE_FUNDED_CLAUDE_POLICY.maxTurnDurationMs / 1_000,
          24 * 60 * 60,
        ) * 1_000,
      maxOutputTokensPerRequest: positiveInteger(
        settings.site_funded_claude_max_output_tokens_per_request,
        DEFAULT_SITE_FUNDED_CLAUDE_POLICY.maxOutputTokensPerRequest,
        64_000,
      ),
      maxRequestsPerTurn: positiveInteger(
        settings.site_funded_claude_max_requests_per_turn,
        DEFAULT_SITE_FUNDED_CLAUDE_POLICY.maxRequestsPerTurn,
        10_000,
      ),
    },
  };
}

export async function getSiteFundedClaudeConfiguration(): Promise<SiteFundedCodexConfiguration> {
  return siteFundedClaudeConfigurationFromSettings(
    (await getServerSettings()) as Settings,
  );
}

export async function getSiteFundedCodexConfiguration(): Promise<SiteFundedCodexConfiguration> {
  return siteFundedCodexConfigurationFromSettings(
    (await getServerSettings()) as Settings,
  );
}

export async function getSiteFundedAIGlobalPoolLimitMicrousd(): Promise<number> {
  const settings = (await getServerSettings()) as Settings;
  return positiveUsdMicrousd(
    settings.site_funded_codex_global_pool_weekly_usd,
    100 * 1_000_000,
  );
}
