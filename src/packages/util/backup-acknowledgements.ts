/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Bounded personal warning preferences, NOT backup eligibility or permission
// for data loss. Keys include the exact raw path, file version and policy hash.
export const MAX_BACKUP_ACKNOWLEDGEMENTS = 10000;

export function validateBackupAcknowledgementKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_BACKUP_ACKNOWLEDGEMENTS ||
    value.some((key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))
  )
    throw new Error("Invalid backup warning acknowledgement keys");
  return [...new Set(value)];
}

export interface BackupAcknowledgementRequest {
  account_id: string;
  project_id: string;
  // Omitted: read. Present: explicitly acknowledge this ONE file-version key.
  key?: string;
}
