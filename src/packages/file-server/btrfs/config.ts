function envIsDisabled(name: string): boolean {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value);
}

export type BtrfsQuotaMode = "disabled" | "qgroup" | "simple";

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
  return "qgroup";
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
