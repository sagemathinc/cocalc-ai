/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export interface BackupExclusionBinding {
  schema_version: 1;
  project_id: string;
  backup_id: string;
  source: {
    subvolume_uuid: string;
    snapshot_uuid: string;
    captured_at: string;
    generation: string;
  };
  policy_sha256: string;
  report: { sha256: string; header_sha256: string; bytes: number };
}

export interface BackupExclusionReadLimits {
  max_bytes: number;
  max_record_bytes: number;
  max_entries: number;
  max_path_depth: number;
}

export interface BackupProducerEvidence {
  binding: BackupExclusionBinding;
  policy_version: number;
  exclude_larger_than_bytes: string;
  binary_sha256: string;
  outcome: "complete" | "partial_policy_exclusions";
  excluded_files: string;
  report_path: string;
  read_limits: BackupExclusionReadLimits;
}

// Bounded owning-bay metadata, not the potentially large path report itself.
export interface BackupOutcomeReceipt {
  producer: BackupProducerEvidence;
  bucket: string;
  object_key: string;
  excluded_apparent_bytes: string;
  sample: Array<{
    path_hex: string;
    apparent_bytes: string;
    acknowledgement_key: string | null;
  }>;
}
