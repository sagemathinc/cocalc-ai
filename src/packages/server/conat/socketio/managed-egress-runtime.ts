/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type HubManagedEgressMode = "off" | "observe" | "enforce";

type BlockedAccount = {
  message: string;
  blocked_at: number;
};

const blockedAccounts = new Map<string, BlockedAccount>();

function normalizeMode(
  value: string | undefined,
): HubManagedEgressMode | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "observe" ||
    normalized === "enforce"
  ) {
    return normalized;
  }
  return undefined;
}

export function getHubManagedEgressMode(): HubManagedEgressMode {
  return (
    normalizeMode(process.env.COCALC_HUB_MANAGED_EGRESS_MODE) ??
    normalizeMode(process.env.COCALC_SERVER_MANAGED_EGRESS_MODE) ??
    "enforce"
  );
}

export function setHubManagedEgressBlockedAccount({
  account_id,
  message,
}: {
  account_id: string;
  message: string;
}): void {
  const normalized = `${account_id ?? ""}`.trim();
  if (!normalized) return;
  blockedAccounts.set(normalized, {
    message,
    blocked_at: Date.now(),
  });
}

export function clearHubManagedEgressBlockedAccount(account_id: string): void {
  const normalized = `${account_id ?? ""}`.trim();
  if (!normalized) return;
  blockedAccounts.delete(normalized);
}

export function getHubManagedEgressBlockedMessage(
  account_id: string,
): string | undefined {
  return blockedAccounts.get(`${account_id ?? ""}`.trim())?.message;
}

export function listHubManagedEgressBlockedAccounts(): string[] {
  return Array.from(blockedAccounts.keys());
}

export function clearHubManagedEgressBlockedAccounts(): void {
  blockedAccounts.clear();
}

export const __test__ = {
  normalizeMode,
};
