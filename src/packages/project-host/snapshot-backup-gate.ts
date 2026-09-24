/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface SnapshotBackupMaintenanceGate {
  checked_at: string;
  blocked_reason?:
    | "available_memory"
    | "memory_pressure"
    | "memory_measurement_unavailable";
  memory_psi_full_avg10?: number;
}

let current: SnapshotBackupMaintenanceGate | undefined;

export function setSnapshotBackupMaintenanceGate(
  gate: SnapshotBackupMaintenanceGate,
): void {
  current = gate;
}

export function getSnapshotBackupMaintenanceGate():
  | SnapshotBackupMaintenanceGate
  | undefined {
  return current ? { ...current } : undefined;
}
