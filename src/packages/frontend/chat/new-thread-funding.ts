/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CodexThreadConfig } from "@cocalc/chat";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import type { NewThreadSetup } from "./chatroom-thread-panel";

export function reconcileCodexConfigWithSiteFundedPolicy({
  config,
  paymentSource,
}: {
  config: Partial<CodexThreadConfig>;
  paymentSource?: CodexPaymentSourceInfo;
}): Partial<CodexThreadConfig> {
  const preference = config.paymentSource ?? "auto";
  const policy =
    (preference === "auto" || preference === "site-api-key") &&
    paymentSource?.source === "site-api-key" &&
    paymentSource.siteFundedCodex?.enabled
      ? paymentSource.siteFundedCodex.policy
      : undefined;
  if (!policy) return config;
  if (
    config.model === policy.model &&
    config.reasoning === policy.reasoning &&
    config.serviceTier === policy.serviceTier
  ) {
    return config;
  }
  return {
    ...config,
    model: policy.model,
    reasoning: policy.reasoning,
    serviceTier: policy.serviceTier,
  };
}

export function reconcileNewThreadSetupWithSiteFundedPolicy({
  setup,
  paymentSource,
}: {
  setup: NewThreadSetup;
  paymentSource?: CodexPaymentSourceInfo;
}): NewThreadSetup {
  if (setup.agentMode !== "codex") return setup;
  const codexConfig = reconcileCodexConfigWithSiteFundedPolicy({
    config: setup.codexConfig,
    paymentSource,
  });
  if (codexConfig === setup.codexConfig && setup.model === codexConfig.model) {
    return setup;
  }
  return {
    ...setup,
    model: codexConfig.model ?? setup.model,
    codexConfig,
  };
}
