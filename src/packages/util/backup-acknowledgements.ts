/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Bounded personal warning preferences, NOT backup eligibility or permission
// for data loss. Version keys include metadata/policy; path keys do not.
export const MAX_BACKUP_ACKNOWLEDGEMENTS = 10000;

export type BackupAcknowledgementScope = "version" | "path";

export function validateBackupAcknowledgementScope(
  value: unknown,
): BackupAcknowledgementScope {
  if (value === undefined) return "version";
  if (value !== "version" && value !== "path")
    throw new Error("Invalid backup warning acknowledgement scope");
  return value;
}

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
  // Defaults to version for existing callers. Reads return only this scope.
  scope?: BackupAcknowledgementScope;
  // Omitted: read. Present: acknowledge this identity within the chosen scope.
  // Path keys identify exact raw root-relative paths, not globs or subtrees.
  key?: string;
  // Remove a single preference (requires key), so persistent choices are reversible.
  remove?: boolean;
}
