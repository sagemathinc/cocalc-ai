/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectHostManagedEgressMode = "off" | "observe" | "enforce";

type BlockedAccount = {
  message: string;
  blocked_at: number;
};

const blockedAccounts = new Map<string, BlockedAccount>();

function normalizeProvider(value: string | undefined): string | undefined {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return;
  if (normalized === "gcp" || normalized === "google-cloud") {
    return "gcp";
  }
  return normalized;
}

function normalizeMode(
  value: string | undefined,
): ProjectHostManagedEgressMode | undefined {
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

export function getProjectHostManagedEgressMode(): ProjectHostManagedEgressMode {
  const explicit = normalizeMode(
    process.env.COCALC_PROJECT_HOST_MANAGED_EGRESS_MODE,
  );
  if (explicit) {
    return explicit;
  }
  const provider = normalizeProvider(
    process.env.COCALC_PROJECT_HOST_CLOUD_PROVIDER ??
      process.env.PROJECT_HOST_CLOUD_PROVIDER,
  );
  if (provider === "gcp") {
    return "enforce";
  }
  if (provider) {
    return "off";
  }
  // Preserve the current default behavior on older hosts until bootstrap starts
  // supplying an explicit provider/mode.
  return "enforce";
}

export function isProjectHostManagedEgressTrackingEnabled(): boolean {
  return getProjectHostManagedEgressMode() !== "off";
}

export function isProjectHostManagedEgressEnforced(): boolean {
  return getProjectHostManagedEgressMode() === "enforce";
}

export function setProjectHostManagedEgressBlockedAccount({
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

export function clearProjectHostManagedEgressBlockedAccount(
  account_id: string,
): void {
  const normalized = `${account_id ?? ""}`.trim();
  if (!normalized) return;
  blockedAccounts.delete(normalized);
}

export function getProjectHostManagedEgressBlockedMessage(
  account_id: string,
): string | undefined {
  return blockedAccounts.get(`${account_id ?? ""}`.trim())?.message;
}

export function listProjectHostManagedEgressBlockedAccounts(): string[] {
  return Array.from(blockedAccounts.keys());
}

export function clearProjectHostManagedEgressBlockedAccounts(): void {
  blockedAccounts.clear();
}

export const __test__ = {
  normalizeMode,
  normalizeProvider,
};
