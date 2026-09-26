/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { ExternalCredentialInfo } from "@cocalc/conat/hub/api/system";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";

export function newAgentClaudeCredentialValue(
  credential: AcpHarnessCredential,
): string {
  return credential.mode === "account-api-key" ||
    credential.mode === "account-subscription"
    ? `${credential.mode}:${credential.credentialId}`
    : "project-secret";
}

export function newAgentClaudeCredentialOptions(
  credentials: ExternalCredentialInfo[],
  compact = false,
): { value: string; label: string }[] {
  return [
    { value: "project-secret", label: "Project secret" },
    ...credentials
      .filter(
        (row) =>
          !row.revoked &&
          (row.kind === "anthropic-api-key" ||
            row.kind === CLAUDE_SUBSCRIPTION_KIND),
      )
      .map((row) => {
        const identity = String(
          row.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY] ||
            "unknown account",
        );
        const plan = String(row.metadata?.plan || "Pro/Max").replace(
          /^(pro|max)$/i,
          (value) => value[0].toUpperCase() + value.slice(1).toLowerCase(),
        );
        return {
          value: `${row.kind === CLAUDE_SUBSCRIPTION_KIND ? "account-subscription" : "account-api-key"}:${row.id}`,
          label:
            row.kind === CLAUDE_SUBSCRIPTION_KIND
              ? `Claude ${plan} - ${compact ? identity.split("@")[0] : identity}`
              : row.metadata?.label || `Anthropic key ${row.id.slice(0, 8)}`,
        };
      }),
  ];
}

/** Reuse an unambiguous existing subscription; never guess between accounts. */
export function newAgentClaudeCredentialDefault(
  credentials: ExternalCredentialInfo[],
): AcpHarnessCredential {
  const subscriptions = credentials.filter(
    (row) => !row.revoked && row.kind === CLAUDE_SUBSCRIPTION_KIND,
  );
  return subscriptions.length === 1
    ? {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId: subscriptions[0].id,
      }
    : { version: 1, provider: "anthropic", mode: "project-secret" };
}
