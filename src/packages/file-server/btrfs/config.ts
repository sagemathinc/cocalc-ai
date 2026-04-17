function envIsDisabled(name: string): boolean {
  const value = `${process.env[name] ?? ""}`.trim().toLowerCase();
  if (!value) return false;
  return !["0", "false", "no", "off"].includes(value);
}

export function btrfsQuotasDisabled(): boolean {
  return envIsDisabled("COCALC_DISABLE_BTRFS_QUOTAS");
}

export function btrfsRollingSnapshotsDisabled(): boolean {
  return envIsDisabled("COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS");
}
