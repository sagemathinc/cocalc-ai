/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// This is a caller rollout gate, not a resource policy. Actual admission and
// process-tree limits belong to the separately installed root-owned helper.
export function managedRusticSupervisionEnabled(): boolean {
  const value = process.env.COCALC_MANAGED_RUSTIC_SUPERVISION;
  if (value == null || value === "0") return false;
  if (value === "1") return true;
  throw new Error("COCALC_MANAGED_RUSTIC_SUPERVISION must be 0 or 1");
}

export function assertLegacyRusticOperationAllowed(command: string): void {
  if (
    (command === "backup" || command === "restore") &&
    managedRusticSupervisionEnabled()
  ) {
    throw new Error(
      "This managed backup or restore requires the supervised storage path; " +
        "the unsupervised fallback is disabled. Upgrade the host integration " +
        "before retrying. No fallback backup or restore was started.",
    );
  }
}
