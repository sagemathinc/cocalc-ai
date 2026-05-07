/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  DedicatedHostEgressPolicy,
  MembershipEffectiveLimits,
  MembershipEgressPolicy,
  MembershipResolution,
  MembershipUsageLimits,
} from "@cocalc/conat/hub/api/purchases";

const EGRESS_POLICIES = new Set<MembershipEgressPolicy>([
  "metered-shared-hosts",
  "all-shared-hosts",
  "disabled",
]);

const DEDICATED_HOST_EGRESS_POLICIES = new Set<DedicatedHostEgressPolicy>([
  "tier-capped",
  "meter-and-bill",
  "disabled",
]);

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeEgressPolicy(
  value: unknown,
): MembershipEgressPolicy | undefined {
  return typeof value === "string" &&
    EGRESS_POLICIES.has(value as MembershipEgressPolicy)
    ? (value as MembershipEgressPolicy)
    : undefined;
}

function normalizeDedicatedHostEgressPolicy(
  value: unknown,
): DedicatedHostEgressPolicy | undefined {
  return typeof value === "string" &&
    DEDICATED_HOST_EGRESS_POLICIES.has(value as DedicatedHostEgressPolicy)
    ? (value as DedicatedHostEgressPolicy)
    : undefined;
}

export function normalizeMembershipEffectiveLimits(
  usageLimits?: MembershipUsageLimits | null,
): MembershipEffectiveLimits {
  return {
    shared_compute_priority: normalizeNonNegativeInteger(
      usageLimits?.shared_compute_priority,
    ),
    total_storage_soft_bytes: normalizeNonNegativeInteger(
      usageLimits?.total_storage_soft_bytes,
    ),
    total_storage_hard_bytes: normalizeNonNegativeInteger(
      usageLimits?.total_storage_hard_bytes,
    ),
    max_projects: normalizeNonNegativeInteger(usageLimits?.max_projects),
    max_snapshots_per_project: normalizeNonNegativeInteger(
      usageLimits?.max_snapshots_per_project,
    ),
    max_backups_per_project: normalizeNonNegativeInteger(
      usageLimits?.max_backups_per_project,
    ),
    egress_5h_bytes: normalizeNonNegativeInteger(usageLimits?.egress_5h_bytes),
    egress_7d_bytes: normalizeNonNegativeInteger(usageLimits?.egress_7d_bytes),
    egress_policy: normalizeEgressPolicy(usageLimits?.egress_policy),
    dedicated_host_egress_policy: normalizeDedicatedHostEgressPolicy(
      usageLimits?.dedicated_host_egress_policy,
    ),
    credit_spend_limit_5h_usd: normalizeNonNegativeNumber(
      usageLimits?.credit_spend_limit_5h_usd,
    ),
    credit_spend_limit_7d_usd: normalizeNonNegativeNumber(
      usageLimits?.credit_spend_limit_7d_usd,
    ),
    prepaid_host_usage_limit_5h_usd: normalizeNonNegativeNumber(
      usageLimits?.prepaid_host_usage_limit_5h_usd,
    ),
    prepaid_host_usage_limit_7d_usd: normalizeNonNegativeNumber(
      usageLimits?.prepaid_host_usage_limit_7d_usd,
    ),
  };
}

export function getEffectiveMembershipUsageLimits(
  resolution?: Pick<
    MembershipResolution,
    "effective_limits" | "entitlements"
  > | null,
): MembershipEffectiveLimits {
  if (resolution?.effective_limits != null) {
    return normalizeMembershipEffectiveLimits(resolution.effective_limits);
  }
  return normalizeMembershipEffectiveLimits(
    resolution?.entitlements?.usage_limits,
  );
}
