/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export class BackupEvidenceCleanupError extends Error {
  constructor(readonly cause: unknown) {
    super("Backup evidence cleanup failed; operator reconciliation required");
  }
}

// Failed cleanup must not release an aggregate cache reservation as if the
// temporary files/handles were gone. Keep that distinction across nested scopes.
export async function cleanupBackupEvidence(
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (cause) {
    throw new BackupEvidenceCleanupError(cause);
  }
}
