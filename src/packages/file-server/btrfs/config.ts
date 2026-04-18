function envIsDisabled(name: string): boolean {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value);
}

// IMPORTANT: classic btrfs qgroups are intentionally unsupported in CoCalc.
//
// They caused severe lag, hangs, and daemon failures under our snapshot-heavy
// workload. We keep only simple quotas and a full disable switch so nobody
// accidentally "improves semantics" by reintroducing qgroup accounting.
export type BtrfsQuotaMode = "disabled" | "simple";

export function btrfsQuotaMode(): BtrfsQuotaMode {
  if (envIsDisabled("COCALC_DISABLE_BTRFS_QUOTAS")) {
    return "disabled";
  }
  const value = `${process.env.COCALC_BTRFS_QUOTA_MODE ?? ""}`
    .trim()
    .toLowerCase();
  if (value === "disabled" || value === "off" || value === "none") {
    return "disabled";
  }
  if (value === "simple" || value === "squota") {
    return "simple";
  }
  // Intentionally treat the old qgroup/default modes as simple quotas.
  return "simple";
}

export function btrfsQuotasDisabled(): boolean {
  return btrfsQuotaMode() === "disabled";
}

export function btrfsSimpleQuotasEnabled(): boolean {
  return btrfsQuotaMode() === "simple";
}

export function btrfsRollingSnapshotsDisabled(): boolean {
  return envIsDisabled("COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS");
}
