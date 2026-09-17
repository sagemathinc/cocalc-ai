import type { MembershipEntitlements } from "@cocalc/conat/hub/api/purchases";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveRuntimeMembership } from "./runtime-resolution";

const SETTINGS_FIELDS = ["memory", "memory_request", "disk_quota"] as const;

type SettingsField = (typeof SETTINGS_FIELDS)[number];
export type MembershipProjectDefaults = Partial<Record<SettingsField, number>>;
export type MembershipIoClass = "standard" | "member" | "premium";
export type MembershipRuntimeScheduling = {
  io_class: MembershipIoClass;
  shared_compute_priority: number;
};

export function normalizeSharedComputePriority(priority: unknown): number {
  const value = Number(priority);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function ioClassFromSharedComputePriority(
  priority: unknown,
): MembershipIoClass {
  const value = normalizeSharedComputePriority(priority);
  if (value <= 0) return "standard";
  if (value >= 4) return "premium";
  return "member";
}

export function runtimeSchedulingFromSharedComputePriority(
  priority: unknown,
): MembershipRuntimeScheduling {
  const shared_compute_priority = normalizeSharedComputePriority(priority);
  return {
    shared_compute_priority,
    io_class: ioClassFromSharedComputePriority(shared_compute_priority),
  };
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value == "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value == "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (typeof value == "boolean") {
    return value ? 1 : 0;
  }
  return undefined;
}

export function normalizeMembershipProjectDefaults(
  raw: MembershipEntitlements["project_defaults"] | undefined,
): MembershipProjectDefaults {
  if (raw == null || typeof raw !== "object") {
    return {};
  }
  const defaults: MembershipProjectDefaults = {};
  for (const key of SETTINGS_FIELDS) {
    const value = coerceNumber((raw as Record<string, unknown>)[key]);
    if (value == null || value < 0) continue;
    defaults[key] = value;
  }
  return defaults;
}

export async function getMembershipProjectDefaultsFromUsers(users: unknown) {
  const owner = getProjectOwnerFromUsers(users);
  if (!owner) return {};
  const resolution = await resolveRuntimeMembership(owner);
  return normalizeMembershipProjectDefaults(
    resolution.entitlements?.project_defaults,
  );
}

export async function getMembershipProjectDefaultsForAccount(
  account_id?: string,
): Promise<MembershipProjectDefaults> {
  if (!account_id) return {};
  const resolution = await resolveRuntimeMembership(account_id);
  return normalizeMembershipProjectDefaults(
    resolution.entitlements?.project_defaults,
  );
}

export async function getMembershipRuntimeSchedulingForAccount(
  account_id?: string,
): Promise<MembershipRuntimeScheduling> {
  if (!account_id) return runtimeSchedulingFromSharedComputePriority(0);
  const resolution = await resolveRuntimeMembership(account_id);
  return runtimeSchedulingFromSharedComputePriority(
    resolution.effective_limits?.shared_compute_priority ??
      resolution.entitlements?.usage_limits?.shared_compute_priority,
  );
}

export async function getMembershipBrowserIdleTimeoutForAccount(
  account_id?: string,
): Promise<number> {
  if (!account_id) return 0;
  const resolution = await resolveRuntimeMembership(account_id);
  return (
    getEffectiveMembershipUsageLimits(resolution)
      .browser_idle_timeout_seconds ?? 0
  );
}

function getProjectOwnerFromUsers(users: unknown): string | undefined {
  if (users == null || typeof users !== "object") return;
  for (const [account_id, user] of Object.entries(
    users as Record<string, { group?: string }>,
  )) {
    if (user?.group == "owner") {
      return account_id;
    }
  }
  return;
}
