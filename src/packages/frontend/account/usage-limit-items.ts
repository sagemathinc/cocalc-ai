/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { humanSize } from "@cocalc/util/misc";

export function formatSharedComputePriority(priority: number): string {
  if (priority <= 0) return "Low";
  if (priority === 1) return "Medium";
  if (priority === 2) return "High";
  return "Highest";
}

export function getUsageLimitsItems(
  usageLimits: Record<string, unknown>,
): Array<{
  key: string;
  label: string;
  value: string;
}> {
  const items: Array<{
    key: string;
    label: string;
    value: string;
  }> = [];
  const computePriority = usageLimits.shared_compute_priority;
  if (typeof computePriority === "number" && Number.isFinite(computePriority)) {
    items.push({
      key: "shared_compute_priority",
      label: "CPU priority",
      value: formatSharedComputePriority(computePriority),
    });
  }
  const totalSoft = usageLimits.total_storage_soft_bytes;
  if (typeof totalSoft === "number" && Number.isFinite(totalSoft)) {
    items.push({
      key: "total_storage_soft_bytes",
      label: "Total account storage soft cap",
      value: humanSize(totalSoft),
    });
  }
  const totalHard = usageLimits.total_storage_hard_bytes;
  if (typeof totalHard === "number" && Number.isFinite(totalHard)) {
    items.push({
      key: "total_storage_hard_bytes",
      label: "Total account storage hard cap",
      value: humanSize(totalHard),
    });
  }
  const maxProjects = usageLimits.max_projects;
  if (typeof maxProjects === "number" && Number.isFinite(maxProjects)) {
    items.push({
      key: "max_projects",
      label: "Max projects",
      value: `${maxProjects}`,
    });
  }
  const maxSnapshots = usageLimits.max_snapshots_per_project;
  if (typeof maxSnapshots === "number" && Number.isFinite(maxSnapshots)) {
    items.push({
      key: "max_snapshots_per_project",
      label: "Max snapshots per project",
      value: `${maxSnapshots}`,
    });
  }
  const maxBackups = usageLimits.max_backups_per_project;
  if (typeof maxBackups === "number" && Number.isFinite(maxBackups)) {
    items.push({
      key: "max_backups_per_project",
      label: "Max backups per project",
      value: `${maxBackups}`,
    });
  }
  const rootfsCount = usageLimits.rootfs_count;
  if (typeof rootfsCount === "number" && Number.isFinite(rootfsCount)) {
    items.push({
      key: "rootfs_count",
      label: "Max images",
      value: `${rootfsCount}`,
    });
  }
  const rootfsTotalStorage = usageLimits.rootfs_total_storage_gb;
  if (
    typeof rootfsTotalStorage === "number" &&
    Number.isFinite(rootfsTotalStorage)
  ) {
    items.push({
      key: "rootfs_total_storage_gb",
      label: "Image total storage cap",
      value: `${rootfsTotalStorage} GB`,
    });
  }
  const rootfsMaxStorage = usageLimits.rootfs_max_storage_gb;
  if (
    typeof rootfsMaxStorage === "number" &&
    Number.isFinite(rootfsMaxStorage)
  ) {
    items.push({
      key: "rootfs_max_storage_gb",
      label: "Image per-image cap",
      value: `${rootfsMaxStorage} GB`,
    });
  }
  const rootfsOciImages = usageLimits.rootfs_oci_images;
  if (typeof rootfsOciImages === "boolean") {
    items.push({
      key: "rootfs_oci_images",
      label: "Remote OCI images",
      value: rootfsOciImages ? "Enabled" : "Disabled",
    });
  }
  const egress5h = usageLimits.egress_5h_bytes;
  if (typeof egress5h === "number" && Number.isFinite(egress5h)) {
    items.push({
      key: "egress_5h_bytes",
      label: "Data transfer 5-hour window",
      value: humanSize(egress5h),
    });
  }
  const egress7d = usageLimits.egress_7d_bytes;
  if (typeof egress7d === "number" && Number.isFinite(egress7d)) {
    items.push({
      key: "egress_7d_bytes",
      label: "Data transfer 7-day window",
      value: humanSize(egress7d),
    });
  }
  return items;
}
