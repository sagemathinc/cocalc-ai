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

/**
 * How to refer to a Claude subscription: the owner's name for it, else the
 * plan and email a full sign-in reported. A long-lived token reports neither.
 */
export function claudeSubscriptionName(
  row: Pick<ExternalCredentialInfo, "metadata">,
  compact = false,
): string {
  const label = `${row.metadata?.label ?? ""}`.trim();
  if (label) return label;
  const identity = row.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY];
  if (typeof identity !== "string" || !identity) return "Claude subscription";
  const plan = String(row.metadata?.plan || "Pro/Max")
    .replace(/^claude\s+/i, "")
    .replace(
      /^(pro|max)$/i,
      (value) => value[0].toUpperCase() + value.slice(1).toLowerCase(),
    );
  return `Claude ${plan} - ${compact ? identity.split("@")[0] : identity}`;
}

/** The picker value for included Claude, paid by the CoCalc membership. */
export const SITE_FUNDED_CLAUDE_VALUE = "site-funded";

export function siteFundedClaudeLabel(compact = false): string {
  return compact ? "CoCalc Membership" : "CoCalc Membership (Claude Haiku 5.5)";
}

export function newAgentClaudeCredentialValue(
  credential: AcpHarnessCredential,
): string {
  if (credential.mode === "site-funded") return SITE_FUNDED_CLAUDE_VALUE;
  return credential.mode === "account-api-key" ||
    credential.mode === "account-subscription"
    ? `${credential.mode}:${credential.credentialId}`
    : "project-secret";
}

/** The credential a picker value names (the inverse of the above). */
export function claudeCredentialFromValue(value: string): AcpHarnessCredential {
  if (value === SITE_FUNDED_CLAUDE_VALUE)
    return { version: 1, provider: "anthropic", mode: "site-funded" };
  for (const mode of ["account-subscription", "account-api-key"] as const) {
    if (value.startsWith(`${mode}:`))
      return {
        version: 1,
        provider: "anthropic",
        mode,
        credentialId: value.slice(mode.length + 1),
      };
  }
  return { version: 1, provider: "anthropic", mode: "project-secret" };
}

// Most recently used (or connected) first.
function byRecency(a: ExternalCredentialInfo, b: ExternalCredentialInfo) {
  const time = (row: ExternalCredentialInfo) =>
    new Date(row.last_used ?? row.updated ?? row.created ?? 0).valueOf() || 0;
  return time(b) - time(a);
}

function activeClaudeCredentials(credentials: ExternalCredentialInfo[]) {
  const active = credentials.filter((row) => !row.revoked);
  return {
    subscriptions: active
      .filter((row) => row.kind === CLAUDE_SUBSCRIPTION_KIND)
      .sort(byRecency),
    apiKeys: active
      .filter((row) => row.kind === "anthropic-api-key")
      .sort(byRecency),
  };
}

/**
 * Subscriptions first, then account API keys, then included Claude (when the
 * account's membership includes it); the project secret last.
 */
export function newAgentClaudeCredentialOptions(
  credentials: ExternalCredentialInfo[],
  compact = false,
  membership = false,
): { value: string; label: string }[] {
  const { subscriptions, apiKeys } = activeClaudeCredentials(credentials);
  return [
    ...subscriptions.map((row) => ({
      value: `account-subscription:${row.id}`,
      label: claudeSubscriptionName(row, compact),
    })),
    ...apiKeys.map((row) => ({
      value: `account-api-key:${row.id}`,
      label: row.metadata?.label || "Anthropic API key",
    })),
    ...(membership
      ? [
          {
            value: SITE_FUNDED_CLAUDE_VALUE,
            label: siteFundedClaudeLabel(compact),
          },
        ]
      : []),
    { value: "project-secret", label: "Project secret (ANTHROPIC_API_KEY)" },
  ];
}

/**
 * The Claude credential to use: the remembered one while it exists, else the
 * most recent subscription, else an account API key, else included Claude
 * (when the membership includes it). The project secret is used only when
 * chosen, and only kept if no account credential exists; included Claude
 * never replaces it.
 */
export function preferredClaudeCredential(
  remembered: AcpHarnessCredential | undefined,
  credentials: ExternalCredentialInfo[],
  membership = false,
): AcpHarnessCredential {
  const { subscriptions, apiKeys } = activeClaudeCredentials(credentials);
  if (remembered?.mode === "site-funded" && membership) return remembered;
  if (
    remembered &&
    (remembered.mode === "account-subscription" ||
      remembered.mode === "account-api-key") &&
    [...subscriptions, ...apiKeys].some(
      (row) => row.id === remembered.credentialId,
    )
  )
    return remembered;
  if (subscriptions.length)
    return {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: subscriptions[0].id,
      ...(remembered?.mode === "account-subscription" &&
      remembered.claudeAiConnectors === false
        ? { claudeAiConnectors: false }
        : {}),
    };
  if (apiKeys.length)
    return {
      version: 1,
      provider: "anthropic",
      mode: "account-api-key",
      credentialId: apiKeys[0].id,
    };
  if (membership && remembered?.mode !== "project-secret")
    return { version: 1, provider: "anthropic", mode: "site-funded" };
  return { version: 1, provider: "anthropic", mode: "project-secret" };
}

/** Default for a new agent with nothing remembered. */
export function newAgentClaudeCredentialDefault(
  credentials: ExternalCredentialInfo[],
  membership = false,
): AcpHarnessCredential {
  return preferredClaudeCredential(undefined, credentials, membership);
}
