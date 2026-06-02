/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  AccountUsageMeter,
  AccountUsageMeterCategory,
  AccountUsageMeterSeverity,
  AccountUsageMeterUnit,
  AccountUsageOverview,
  AccountUsageSummaryPressure,
  MembershipUsageStatus,
} from "@cocalc/conat/hub/api/purchases";
import type { MoneyValue } from "@cocalc/util/money";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
import { getDedicatedHostPolicySnapshotLocal } from "@cocalc/server/project-host/admission";
import { resolveMembershipDetailsForAccount } from "./resolve";

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function moneyNumber(value: MoneyValue | undefined): number | undefined {
  return finiteNumber(value);
}

function severityForRatio(
  ratio: number | undefined,
): AccountUsageMeterSeverity {
  if (ratio == null || !Number.isFinite(ratio)) {
    return ratio === Infinity ? "over" : "unknown";
  }
  if (ratio >= 1) return "over";
  if (ratio >= 0.75) return "near";
  return "ok";
}

function ratioFor({
  used,
  limit,
}: {
  used?: number;
  limit?: number;
}): number | undefined {
  if (used == null || limit == null || !Number.isFinite(limit)) return;
  if (limit > 0) return used / limit;
  return used > 0 ? Infinity : 0;
}

function meter({
  id,
  category,
  window,
  label,
  help,
  unit,
  used,
  limit,
  remaining,
  starts_at,
  resets_at,
  reset_at,
  reset_in,
  action_when_over,
  upgrade_relevant = true,
  source,
}: Omit<
  AccountUsageMeter,
  "severity" | "ratio" | "percent"
>): AccountUsageMeter {
  const ratio = ratioFor({ used, limit });
  const severity = severityForRatio(ratio);
  const percent =
    ratio == null
      ? undefined
      : ratio === Infinity
        ? 100
        : Math.round(ratio * 1000) / 10;
  return {
    id,
    category,
    window,
    label,
    help,
    unit,
    used,
    limit,
    remaining,
    ratio,
    percent,
    severity,
    starts_at,
    resets_at,
    reset_at,
    reset_in,
    action_when_over,
    upgrade_relevant,
    source,
  };
}

function addMeter(
  meters: AccountUsageMeter[],
  opts: Omit<AccountUsageMeter, "severity" | "ratio" | "percent">,
): void {
  if (opts.used == null && opts.limit == null) return;
  meters.push(meter(opts));
}

function pressureFor(
  meters: AccountUsageMeter[],
): AccountUsageSummaryPressure | undefined {
  const limited = meters.filter((item) => item.ratio != null);
  if (limited.length === 0) return;
  const limiting = limited.reduce((best, item) => {
    const bestRatio = best.ratio ?? -1;
    const itemRatio = item.ratio ?? -1;
    return itemRatio > bestRatio ? item : best;
  });
  return {
    percent: limiting.percent ?? 0,
    severity: limiting.severity,
    limiting_meter_id: limiting.id,
    limiting_meter_label: limiting.label,
    starts_at: limiting.starts_at,
    resets_at: limiting.resets_at,
    reset_at: limiting.reset_at,
    reset_in: limiting.reset_in,
  };
}

function addPointMeter({
  meters,
  usageStatus,
  id,
  category,
  label,
  help,
  unit,
  usedKey,
  limitKey,
  remainingKey,
  action_when_over,
}: {
  meters: AccountUsageMeter[];
  usageStatus: MembershipUsageStatus;
  id: string;
  category: AccountUsageMeterCategory;
  label: string;
  help: string;
  unit: AccountUsageMeterUnit;
  usedKey: keyof MembershipUsageStatus;
  limitKey: keyof MembershipUsageStatus;
  remainingKey?: keyof MembershipUsageStatus;
  action_when_over: string;
}): void {
  addMeter(meters, {
    id,
    category,
    window: "point",
    label,
    help,
    unit,
    used: finiteNumber(usageStatus[usedKey]),
    limit: finiteNumber(usageStatus[limitKey]),
    remaining: remainingKey
      ? finiteNumber(usageStatus[remainingKey])
      : undefined,
    action_when_over,
    upgrade_relevant: true,
    source: "membership_usage_status",
  });
}

function addMembershipUsageMeters({
  meters,
  usageStatus,
}: {
  meters: AccountUsageMeter[];
  usageStatus?: MembershipUsageStatus;
}): string[] {
  if (!usageStatus) return ["Membership usage status is not available."];
  const warnings: string[] = [];
  if ((usageStatus.unsampled_project_count ?? 0) > 0) {
    warnings.push(
      `${usageStatus.unsampled_project_count} running project storage sample(s) were not available.`,
    );
  }
  if ((usageStatus.measurement_error_count ?? 0) > 0) {
    warnings.push(
      `${usageStatus.measurement_error_count} usage measurement attempt(s) failed.`,
    );
  }

  addMeter(meters, {
    id: "managed-cpu-5h",
    category: "compute",
    window: "5h",
    label: "Managed CPU, 5 hours",
    help: "CPU-hours attributed to your account in the current shared 5-hour membership window.",
    unit: "seconds",
    used: usageStatus.managed_cpu_5h_seconds,
    limit:
      usageStatus.managed_cpu_5h_remaining_seconds != null &&
      usageStatus.managed_cpu_5h_seconds != null
        ? usageStatus.managed_cpu_5h_seconds +
          usageStatus.managed_cpu_5h_remaining_seconds
        : undefined,
    remaining: usageStatus.managed_cpu_5h_remaining_seconds,
    starts_at: usageStatus.managed_cpu_5h_starts_at,
    resets_at: usageStatus.managed_cpu_5h_reset_at,
    reset_at: usageStatus.managed_cpu_5h_reset_at,
    reset_in: usageStatus.managed_cpu_5h_reset_in,
    action_when_over:
      "Starting new projects may be blocked until the window resets.",
    upgrade_relevant: true,
    source: "membership_usage_status",
  });
  addMeter(meters, {
    id: "managed-cpu-7d",
    category: "compute",
    window: "7d",
    label: "Managed CPU, 7 days",
    help: "CPU-hours attributed to your account in the current shared 7-day membership window.",
    unit: "seconds",
    used: usageStatus.managed_cpu_7d_seconds,
    limit:
      usageStatus.managed_cpu_7d_remaining_seconds != null &&
      usageStatus.managed_cpu_7d_seconds != null
        ? usageStatus.managed_cpu_7d_seconds +
          usageStatus.managed_cpu_7d_remaining_seconds
        : undefined,
    remaining: usageStatus.managed_cpu_7d_remaining_seconds,
    starts_at: usageStatus.managed_cpu_7d_starts_at,
    resets_at: usageStatus.managed_cpu_7d_reset_at,
    reset_at: usageStatus.managed_cpu_7d_reset_at,
    reset_in: usageStatus.managed_cpu_7d_reset_in,
    action_when_over:
      "Starting new projects may be blocked until the window resets.",
    upgrade_relevant: true,
    source: "membership_usage_status",
  });
  addMeter(meters, {
    id: "managed-egress-5h",
    category: "network",
    window: "5h",
    label: "Network egress, 5 hours",
    help: "Metered network egress in the current shared 5-hour membership window.",
    unit: "bytes",
    used: usageStatus.managed_egress_5h_bytes,
    limit:
      usageStatus.managed_egress_5h_remaining_bytes != null &&
      usageStatus.managed_egress_5h_bytes != null
        ? usageStatus.managed_egress_5h_bytes +
          usageStatus.managed_egress_5h_remaining_bytes
        : undefined,
    remaining: usageStatus.managed_egress_5h_remaining_bytes,
    starts_at: usageStatus.managed_egress_5h_starts_at,
    resets_at: usageStatus.managed_egress_5h_reset_at,
    reset_at: usageStatus.managed_egress_5h_reset_at,
    reset_in: usageStatus.managed_egress_5h_reset_in,
    action_when_over:
      "Network-heavy actions may be blocked until the window resets.",
    upgrade_relevant: true,
    source: "membership_usage_status",
  });
  addMeter(meters, {
    id: "managed-egress-7d",
    category: "network",
    window: "7d",
    label: "Network egress, 7 days",
    help: "Metered network egress in the current shared 7-day membership window.",
    unit: "bytes",
    used: usageStatus.managed_egress_7d_bytes,
    limit:
      usageStatus.managed_egress_7d_remaining_bytes != null &&
      usageStatus.managed_egress_7d_bytes != null
        ? usageStatus.managed_egress_7d_bytes +
          usageStatus.managed_egress_7d_remaining_bytes
        : undefined,
    remaining: usageStatus.managed_egress_7d_remaining_bytes,
    starts_at: usageStatus.managed_egress_7d_starts_at,
    resets_at: usageStatus.managed_egress_7d_reset_at,
    reset_at: usageStatus.managed_egress_7d_reset_at,
    reset_in: usageStatus.managed_egress_7d_reset_in,
    action_when_over:
      "Network-heavy actions may be blocked until the window resets.",
    upgrade_relevant: true,
    source: "membership_usage_status",
  });

  addPointMeter({
    meters,
    usageStatus,
    id: "project-storage-soft",
    category: "storage",
    label: "Project storage soft cap",
    help: "Total storage used across projects attributed to your account.",
    unit: "bytes",
    usedKey: "total_storage_bytes",
    limitKey: "total_storage_soft_bytes",
    remainingKey: "total_storage_soft_remaining_bytes",
    action_when_over: "Delete files, reduce project storage, or upgrade.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "project-storage-hard",
    category: "storage",
    label: "Project storage hard cap",
    help: "Hard total project storage cap across projects attributed to your account.",
    unit: "bytes",
    usedKey: "total_storage_bytes",
    limitKey: "total_storage_hard_bytes",
    remainingKey: "total_storage_hard_remaining_bytes",
    action_when_over:
      "Storage-increasing actions are blocked until usage is reduced.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "projects-owned",
    category: "projects",
    label: "Owned projects",
    help: "Number of projects attributed to your account.",
    unit: "count",
    usedKey: "owned_project_count",
    limitKey: "max_projects",
    remainingKey: "remaining_project_slots",
    action_when_over: "Delete projects or upgrade before creating more.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "rootfs-count",
    category: "rootfs",
    label: "RootFS images",
    help: "Number of RootFS images attributed to your account.",
    unit: "count",
    usedKey: "rootfs_count",
    limitKey: "rootfs_count_limit",
    remainingKey: "rootfs_remaining_count",
    action_when_over: "Delete RootFS images or upgrade.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "rootfs-storage",
    category: "rootfs",
    label: "RootFS storage",
    help: "Total RootFS image storage attributed to your account.",
    unit: "bytes",
    usedKey: "rootfs_total_storage_bytes",
    limitKey: "rootfs_total_storage_bytes_limit",
    remainingKey: "rootfs_total_storage_remaining_bytes",
    action_when_over: "Delete RootFS images or upgrade.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "blob-count",
    category: "blob",
    label: "Blob count",
    help: "Number of stored blob objects attributed to your account.",
    unit: "count",
    usedKey: "blob_count",
    limitKey: "blob_count_limit",
    remainingKey: "blob_remaining_count",
    action_when_over: "Delete blobs or upgrade.",
  });
  addPointMeter({
    meters,
    usageStatus,
    id: "blob-storage",
    category: "blob",
    label: "Blob storage",
    help: "Total stored blob bytes attributed to your account.",
    unit: "bytes",
    usedKey: "blob_total_bytes",
    limitKey: "blob_total_bytes_limit",
    remainingKey: "blob_total_remaining_bytes",
    action_when_over: "Delete blobs or upgrade.",
  });

  return warnings;
}

async function addDedicatedHostSpendMeters({
  account_id,
  meters,
}: {
  account_id: string;
  meters: AccountUsageMeter[];
}): Promise<string[]> {
  try {
    const snapshot = await getDedicatedHostPolicySnapshotLocal(account_id);
    const limits = snapshot.effective_limits ?? {};
    const usage = snapshot.dedicated_host_window_usage ?? {};
    addMeter(meters, {
      id: "dedicated-host-prepaid-5h",
      category: "spend",
      window: "5h",
      label: "Dedicated host prepaid spend, 5 hours",
      help: "Prepaid dedicated-host usage in the current shared 5-hour membership window.",
      unit: "usd",
      used: moneyNumber(usage.prepaid_5h_usd),
      limit: limits.prepaid_host_usage_limit_5h_usd,
      action_when_over:
        "Dedicated-host prepaid actions may be blocked until the window resets.",
      upgrade_relevant: true,
      source: "dedicated_host_policy_snapshot",
    });
    addMeter(meters, {
      id: "dedicated-host-prepaid-7d",
      category: "spend",
      window: "7d",
      label: "Dedicated host prepaid spend, 7 days",
      help: "Prepaid dedicated-host usage in the current shared 7-day membership window.",
      unit: "usd",
      used: moneyNumber(usage.prepaid_7d_usd),
      limit: limits.prepaid_host_usage_limit_7d_usd,
      action_when_over:
        "Dedicated-host prepaid actions may be blocked until the window resets.",
      upgrade_relevant: true,
      source: "dedicated_host_policy_snapshot",
    });
    addMeter(meters, {
      id: "dedicated-host-credit-5h",
      category: "spend",
      window: "5h",
      label: "Dedicated host credit spend, 5 hours",
      help: "Postpaid dedicated-host usage in the current shared 5-hour membership window.",
      unit: "usd",
      used: moneyNumber(usage.credit_5h_usd),
      limit: limits.credit_spend_limit_5h_usd,
      action_when_over:
        "Dedicated-host postpaid actions may be blocked until the window resets.",
      upgrade_relevant: true,
      source: "dedicated_host_policy_snapshot",
    });
    addMeter(meters, {
      id: "dedicated-host-credit-7d",
      category: "spend",
      window: "7d",
      label: "Dedicated host credit spend, 7 days",
      help: "Postpaid dedicated-host usage in the current shared 7-day membership window.",
      unit: "usd",
      used: moneyNumber(usage.credit_7d_usd),
      limit: limits.credit_spend_limit_7d_usd,
      action_when_over:
        "Dedicated-host postpaid actions may be blocked until the window resets.",
      upgrade_relevant: true,
      source: "dedicated_host_policy_snapshot",
    });
    return [];
  } catch (err) {
    return [`Dedicated-host spend usage is not available: ${err}`];
  }
}

export async function getAccountUsageOverviewForAccount({
  account_id,
}: {
  account_id: string;
}): Promise<AccountUsageOverview> {
  const [details, aiUsage] = await Promise.all([
    resolveMembershipDetailsForAccount(account_id, {
      refresh_usage_status: true,
    }),
    getAIUsageStatus({ account_id }),
  ]);
  const meters: AccountUsageMeter[] = [];
  const measurement_warnings = addMembershipUsageMeters({
    meters,
    usageStatus: details.usage_status,
  });

  for (const window of aiUsage.windows) {
    addMeter(meters, {
      id: `ai-${window.window}`,
      category: "ai",
      window: window.window,
      label: window.window === "5h" ? "AI usage, 5 hours" : "AI usage, 7 days",
      help: "AI usage units in the current shared membership window.",
      unit: "units",
      used: window.used,
      limit: window.limit,
      remaining: window.remaining,
      starts_at: window.starts_at,
      resets_at: window.resets_at,
      reset_at: window.reset_at,
      reset_in: window.reset_in,
      action_when_over: "AI requests may be blocked until the window resets.",
      upgrade_relevant: true,
      source: "ai_usage_status",
    });
  }

  measurement_warnings.push(
    ...(await addDedicatedHostSpendMeters({ account_id, meters })),
  );

  return {
    collected_at: new Date().toISOString(),
    membership_label: details.selected.class,
    membership_title: details.selected.class,
    summary: {
      pressure_5h: pressureFor(meters.filter((item) => item.window === "5h")),
      pressure_7d: pressureFor(meters.filter((item) => item.window === "7d")),
      storage: pressureFor(
        meters.filter((item) =>
          ["storage", "projects", "rootfs", "blob"].includes(item.category),
        ),
      ),
      live_capacity: pressureFor(
        meters.filter((item) => item.category === "codex"),
      ),
    },
    meters,
    recent_events: {
      managed_egress: details.usage_status?.managed_egress_recent_events,
      managed_cpu: details.usage_status?.managed_cpu_recent_events,
    },
    measurement_warnings,
  };
}
