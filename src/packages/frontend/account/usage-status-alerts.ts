/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MembershipUsageStatus } from "@cocalc/conat/hub/api/purchases";

export type UsageStatusAlert = {
  key: string;
  title: string;
  type: "warning" | "error";
};

export function getUsageStatusAlerts(
  usageStatus?: MembershipUsageStatus | null,
): UsageStatusAlert[] {
  if (!usageStatus) return [];
  const alerts: UsageStatusAlert[] = [];
  if (usageStatus.over_total_storage_hard) {
    alerts.push({
      key: "over-hard-storage",
      type: "error",
      title:
        "Your account is over the hard total storage cap. Storage-increasing operations are blocked until you delete data or upgrade membership.",
    });
  } else if (usageStatus.over_total_storage_soft) {
    alerts.push({
      key: "over-soft-storage",
      type: "warning",
      title:
        "Your account is over the soft total storage cap. Storage-increasing operations are blocked until you delete data or upgrade membership.",
    });
  }
  if (usageStatus.over_max_projects) {
    alerts.push({
      key: "over-max-projects",
      type: "warning",
      title:
        "Your account is over the project limit. Creating new projects is blocked until you delete a project or upgrade membership.",
    });
  }
  if (usageStatus.over_rootfs_count) {
    alerts.push({
      key: "over-rootfs-count",
      type: "warning",
      title:
        "Your account is over the RootFS image count limit. Publishing or saving new RootFS images is blocked until you delete images or upgrade membership.",
    });
  }
  if (usageStatus.over_rootfs_total_storage) {
    alerts.push({
      key: "over-rootfs-storage",
      type: "warning",
      title:
        "Your account is over the RootFS storage limit. Publishing or saving larger RootFS images is blocked until you delete images or upgrade membership.",
    });
  }
  if (
    usageStatus.unsampled_project_count > 0 ||
    (usageStatus.measurement_error_count ?? 0) > 0
  ) {
    alerts.push({
      key: "partial-usage-measurement",
      type: "warning",
      title:
        "Current storage usage is only partially sampled from your projects, so totals may temporarily be incomplete.",
    });
  }
  if (usageStatus.over_managed_cpu_5h) {
    alerts.push({
      key: "over-managed-cpu-5h",
      type: "warning",
      title:
        "Your account is over the managed-CPU 5-hour window. Starting new projects may be blocked until this window resets.",
    });
  }
  if (usageStatus.over_managed_cpu_7d) {
    alerts.push({
      key: "over-managed-cpu-7d",
      type: "warning",
      title:
        "Your account is over the managed-CPU 7-day window. Starting new projects may be blocked until this window resets.",
    });
  }
  if (usageStatus.over_managed_egress_5h) {
    alerts.push({
      key: "over-managed-egress-5h",
      type: "error",
      title:
        "Your account is over the managed-egress 5-hour window. Metered downloads may be blocked until this window resets.",
    });
  }
  if (usageStatus.over_managed_egress_7d) {
    alerts.push({
      key: "over-managed-egress-7d",
      type: "error",
      title:
        "Your account is over the managed-egress 7-day window. Metered downloads may be blocked until this window resets.",
    });
  }
  return alerts;
}
