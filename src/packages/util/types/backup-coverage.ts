/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type BackupOutcome = "complete" | "partial_policy_exclusions" | "failed";

export interface BackupExcludedFileView {
  path_hex: string;
  apparent_bytes: string;
  acknowledgement_key: string | null;
  acknowledged: boolean;
}

/** A bounded, account-specific view, not lifecycle/deletion authority. */
export interface BackupCoverageView {
  schema_version: 1;
  project_id: string;
  backup_id: string | null;
  outcome: BackupOutcome;
  captured_at: string | null;
  policy_sha256: string | null;
  exclude_larger_than_bytes: string | null;
  excluded_files: string;
  unacknowledged_files: string;
  files: BackupExcludedFileView[];
  next_cursor: string | null;
  report_available: boolean;
}
