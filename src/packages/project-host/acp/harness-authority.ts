/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { HarnessBinding } from "@cocalc/ai/acp/harness";
import { validateAnthropicAccountCredentialAuthority } from "./anthropic-credential-relay";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";

export async function validateHarnessAuthority(
  binding: HarnessBinding,
): Promise<void> {
  if (
    binding.credential.mode !== "account-api-key" &&
    binding.credential.mode !== "account-subscription"
  )
    return;
  if (
    binding.profile.version !== 2 ||
    binding.profile.id !== "claude-code" ||
    binding.credential.provider !== "anthropic"
  ) {
    throw Error("Unsupported account credential binding");
  }
  const args = {
    projectId: binding.projectId,
    accountId: binding.accountId,
    credentialId: binding.credential.credentialId,
  };
  if (binding.credential.mode === "account-subscription") {
    await getClaudeSubscriptionCredential(args);
  } else {
    await validateAnthropicAccountCredentialAuthority(args);
  }
}
