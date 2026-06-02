/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipUsageStatus } from "@cocalc/conat/hub/api/purchases";
import { humanSize } from "@cocalc/util/misc";

export type UsageStatusItem = {
  danger?: boolean;
  key: string;
  label: string;
  progress?: {
    caption: string;
    current: number;
    limit: number;
  };
  value: string;
};

function formatCpuSeconds(seconds: number): string {
  const hours = Math.max(0, seconds) / 3600;
  let digits = 0;
  if (hours < 1) {
    digits = 3;
  } else if (hours < 10) {
    digits = 2;
  } else if (hours < 100) {
    digits = 1;
  }
  return `${hours.toFixed(digits)} CPU-hours`;
}

export function getUsageStatusItems(
  usageStatus?: MembershipUsageStatus | null,
  usageLimits?: Record<string, unknown>,
): UsageStatusItem[] {
  if (!usageStatus) return [];
  const maxProjects =
    typeof usageLimits?.max_projects === "number" &&
    Number.isFinite(usageLimits.max_projects)
      ? usageLimits.max_projects
      : undefined;
  const totalStorageProgressLimit =
    typeof usageStatus.total_storage_hard_bytes === "number" &&
    Number.isFinite(usageStatus.total_storage_hard_bytes) &&
    usageStatus.total_storage_hard_bytes > 0
      ? usageStatus.total_storage_hard_bytes
      : typeof usageStatus.total_storage_soft_bytes === "number" &&
          Number.isFinite(usageStatus.total_storage_soft_bytes) &&
          usageStatus.total_storage_soft_bytes > 0
        ? usageStatus.total_storage_soft_bytes
        : undefined;
  const egress5hLimit =
    typeof usageLimits?.egress_5h_bytes === "number" &&
    Number.isFinite(usageLimits.egress_5h_bytes) &&
    usageLimits.egress_5h_bytes > 0
      ? usageLimits.egress_5h_bytes
      : undefined;
  const egress7dLimit =
    typeof usageLimits?.egress_7d_bytes === "number" &&
    Number.isFinite(usageLimits.egress_7d_bytes) &&
    usageLimits.egress_7d_bytes > 0
      ? usageLimits.egress_7d_bytes
      : undefined;
  const cpu5hLimit =
    typeof usageLimits?.cpu_5h_seconds === "number" &&
    Number.isFinite(usageLimits.cpu_5h_seconds) &&
    usageLimits.cpu_5h_seconds > 0
      ? usageLimits.cpu_5h_seconds
      : undefined;
  const cpu7dLimit =
    typeof usageLimits?.cpu_7d_seconds === "number" &&
    Number.isFinite(usageLimits.cpu_7d_seconds) &&
    usageLimits.cpu_7d_seconds > 0
      ? usageLimits.cpu_7d_seconds
      : undefined;
  const items: UsageStatusItem[] = [
    {
      key: "owned_project_count",
      label: "Owned projects",
      value: `${usageStatus.owned_project_count}`,
      danger: usageStatus.over_max_projects === true,
      progress:
        maxProjects != null
          ? {
              current: usageStatus.owned_project_count,
              limit: maxProjects,
              caption: `${usageStatus.owned_project_count} of ${maxProjects} project slots`,
            }
          : undefined,
    },
    {
      key: "total_storage_bytes",
      label: "Current total account storage",
      value: humanSize(usageStatus.total_storage_bytes),
      danger:
        usageStatus.over_total_storage_hard === true ||
        usageStatus.over_total_storage_soft === true,
      progress:
        totalStorageProgressLimit != null
          ? {
              current: usageStatus.total_storage_bytes,
              limit: totalStorageProgressLimit,
              caption: `${humanSize(usageStatus.total_storage_bytes)} of ${humanSize(totalStorageProgressLimit)}`,
            }
          : undefined,
    },
  ];
  if (
    typeof usageStatus.remaining_project_slots === "number" &&
    Number.isFinite(usageStatus.remaining_project_slots)
  ) {
    items.push({
      key: "remaining_project_slots",
      label: "Remaining project slots",
      value: `${usageStatus.remaining_project_slots}`,
      danger: usageStatus.remaining_project_slots < 0,
    });
  }
  if (
    typeof usageStatus.total_storage_soft_remaining_bytes === "number" &&
    Number.isFinite(usageStatus.total_storage_soft_remaining_bytes)
  ) {
    items.push({
      key: "total_storage_soft_remaining_bytes",
      label: "Storage remaining before soft cap",
      value: humanSize(
        Math.abs(usageStatus.total_storage_soft_remaining_bytes),
      ),
      danger: usageStatus.total_storage_soft_remaining_bytes < 0,
    });
  }
  if (
    typeof usageStatus.total_storage_hard_remaining_bytes === "number" &&
    Number.isFinite(usageStatus.total_storage_hard_remaining_bytes)
  ) {
    items.push({
      key: "total_storage_hard_remaining_bytes",
      label: "Storage remaining before hard cap",
      value: humanSize(
        Math.abs(usageStatus.total_storage_hard_remaining_bytes),
      ),
      danger: usageStatus.total_storage_hard_remaining_bytes < 0,
    });
  }
  items.push({
    key: "sampled_project_count",
    label: "Storage sampled from projects",
    value:
      usageStatus.unsampled_project_count > 0
        ? `${usageStatus.sampled_project_count} of ${usageStatus.owned_project_count}`
        : `${usageStatus.sampled_project_count}`,
    danger: usageStatus.unsampled_project_count > 0,
  });
  if (
    typeof usageStatus.measurement_error_count === "number" &&
    usageStatus.measurement_error_count > 0
  ) {
    items.push({
      key: "measurement_error_count",
      label: "Sampling errors",
      value: `${usageStatus.measurement_error_count}`,
      danger: true,
    });
  }
  if (
    typeof usageStatus.rootfs_count === "number" &&
    Number.isFinite(usageStatus.rootfs_count)
  ) {
    items.push({
      key: "rootfs_count",
      label: "Root filesystems",
      value: `${usageStatus.rootfs_count}`,
      danger: usageStatus.over_rootfs_count === true,
      progress:
        typeof usageStatus.rootfs_count_limit === "number" &&
        Number.isFinite(usageStatus.rootfs_count_limit)
          ? {
              current: usageStatus.rootfs_count,
              limit: usageStatus.rootfs_count_limit,
              caption: `${usageStatus.rootfs_count} of ${usageStatus.rootfs_count_limit} root filesystems`,
            }
          : undefined,
    });
  }
  if (
    typeof usageStatus.rootfs_remaining_count === "number" &&
    Number.isFinite(usageStatus.rootfs_remaining_count)
  ) {
    items.push({
      key: "rootfs_remaining_count",
      label: "Remaining root filesystem slots",
      value:
        usageStatus.rootfs_remaining_count < 0
          ? `Over by ${Math.abs(usageStatus.rootfs_remaining_count)}`
          : `${usageStatus.rootfs_remaining_count}`,
      danger: usageStatus.rootfs_remaining_count < 0,
    });
  }
  if (
    typeof usageStatus.rootfs_total_storage_bytes === "number" &&
    Number.isFinite(usageStatus.rootfs_total_storage_bytes)
  ) {
    items.push({
      key: "rootfs_total_storage_bytes",
      label: "RootFS storage used",
      value: humanSize(usageStatus.rootfs_total_storage_bytes),
      danger: usageStatus.over_rootfs_total_storage === true,
      progress:
        typeof usageStatus.rootfs_total_storage_bytes_limit === "number" &&
        Number.isFinite(usageStatus.rootfs_total_storage_bytes_limit) &&
        usageStatus.rootfs_total_storage_bytes_limit > 0
          ? {
              current: usageStatus.rootfs_total_storage_bytes,
              limit: usageStatus.rootfs_total_storage_bytes_limit,
              caption: `${humanSize(usageStatus.rootfs_total_storage_bytes)} of ${humanSize(usageStatus.rootfs_total_storage_bytes_limit)}`,
            }
          : undefined,
    });
  }
  if (
    typeof usageStatus.rootfs_total_storage_remaining_bytes === "number" &&
    Number.isFinite(usageStatus.rootfs_total_storage_remaining_bytes)
  ) {
    items.push({
      key: "rootfs_total_storage_remaining_bytes",
      label: "RootFS storage remaining",
      value: humanSize(
        Math.abs(usageStatus.rootfs_total_storage_remaining_bytes),
      ),
      danger: usageStatus.rootfs_total_storage_remaining_bytes < 0,
    });
  }
  if (
    typeof usageStatus.rootfs_max_storage_bytes_limit === "number" &&
    Number.isFinite(usageStatus.rootfs_max_storage_bytes_limit)
  ) {
    items.push({
      key: "rootfs_max_storage_bytes_limit",
      label: "RootFS per-image cap",
      value: humanSize(usageStatus.rootfs_max_storage_bytes_limit),
    });
  }
  if (
    typeof usageStatus.managed_cpu_5h_seconds === "number" &&
    Number.isFinite(usageStatus.managed_cpu_5h_seconds)
  ) {
    items.push({
      key: "managed_cpu_5h_seconds",
      label: "Managed CPU used in 5 hours",
      value: formatCpuSeconds(usageStatus.managed_cpu_5h_seconds),
      danger: usageStatus.over_managed_cpu_5h === true,
      progress:
        cpu5hLimit != null
          ? {
              current: usageStatus.managed_cpu_5h_seconds,
              limit: cpu5hLimit,
              caption: `${formatCpuSeconds(usageStatus.managed_cpu_5h_seconds)} of ${formatCpuSeconds(cpu5hLimit)}`,
            }
          : undefined,
    });
  }
  if (
    typeof usageStatus.managed_cpu_7d_seconds === "number" &&
    Number.isFinite(usageStatus.managed_cpu_7d_seconds)
  ) {
    items.push({
      key: "managed_cpu_7d_seconds",
      label: "Managed CPU used in 7 days",
      value: formatCpuSeconds(usageStatus.managed_cpu_7d_seconds),
      danger: usageStatus.over_managed_cpu_7d === true,
      progress:
        cpu7dLimit != null
          ? {
              current: usageStatus.managed_cpu_7d_seconds,
              limit: cpu7dLimit,
              caption: `${formatCpuSeconds(usageStatus.managed_cpu_7d_seconds)} of ${formatCpuSeconds(cpu7dLimit)}`,
            }
          : undefined,
    });
  }
  if (
    typeof usageStatus.managed_egress_5h_bytes === "number" &&
    Number.isFinite(usageStatus.managed_egress_5h_bytes)
  ) {
    items.push({
      key: "managed_egress_5h_bytes",
      label: "Managed egress used in 5 hours",
      value: humanSize(usageStatus.managed_egress_5h_bytes),
      danger: usageStatus.over_managed_egress_5h === true,
      progress:
        egress5hLimit != null
          ? {
              current: usageStatus.managed_egress_5h_bytes,
              limit: egress5hLimit,
              caption: `${humanSize(usageStatus.managed_egress_5h_bytes)} of ${humanSize(egress5hLimit)}`,
            }
          : undefined,
    });
  }
  if (
    typeof usageStatus.managed_egress_7d_bytes === "number" &&
    Number.isFinite(usageStatus.managed_egress_7d_bytes)
  ) {
    items.push({
      key: "managed_egress_7d_bytes",
      label: "Managed egress used in 7 days",
      value: humanSize(usageStatus.managed_egress_7d_bytes),
      danger: usageStatus.over_managed_egress_7d === true,
      progress:
        egress7dLimit != null
          ? {
              current: usageStatus.managed_egress_7d_bytes,
              limit: egress7dLimit,
              caption: `${humanSize(usageStatus.managed_egress_7d_bytes)} of ${humanSize(egress7dLimit)}`,
            }
          : undefined,
    });
  }
  return items;
}
