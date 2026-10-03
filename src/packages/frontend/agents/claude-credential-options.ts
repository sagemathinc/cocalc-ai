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

export function newAgentClaudeCredentialValue(
  credential: AcpHarnessCredential,
): string {
  return credential.mode === "account-api-key" ||
    credential.mode === "account-subscription"
    ? `${credential.mode}:${credential.credentialId}`
    : "project-secret";
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

/** Subscriptions first, then account API keys; the project secret last. */
export function newAgentClaudeCredentialOptions(
  credentials: ExternalCredentialInfo[],
  compact = false,
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
    { value: "project-secret", label: "Project secret (ANTHROPIC_API_KEY)" },
  ];
}

/**
 * The Claude credential to use: the remembered one while it exists, else the
 * most recent subscription, else an account API key. The project secret is
 * used only when chosen, and only kept if no account credential exists.
 */
export function preferredClaudeCredential(
  remembered: AcpHarnessCredential | undefined,
  credentials: ExternalCredentialInfo[],
): AcpHarnessCredential {
  const { subscriptions, apiKeys } = activeClaudeCredentials(credentials);
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
  return { version: 1, provider: "anthropic", mode: "project-secret" };
}

/** Default for a new agent with nothing remembered. */
export function newAgentClaudeCredentialDefault(
  credentials: ExternalCredentialInfo[],
): AcpHarnessCredential {
  return preferredClaudeCredential(undefined, credentials);
}
