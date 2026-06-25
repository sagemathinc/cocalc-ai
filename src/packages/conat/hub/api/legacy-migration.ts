/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";

export type LegacyMigrationProjectImportStatus =
  | "not-imported"
  | "creating"
  | "imported"
  | "failed";

export type LegacyMigrationProjectRestoreStatus =
  | "pending"
  | "restoring"
  | "restored"
  | "skipped"
  | "selection-pending"
  | "indexing"
  | "indexed"
  | "failed";

export type LegacyMigrationProjectRestoreMode = "full" | "select";

export interface LegacyMigrationArchiveEntry {
  path: string;
  size: number;
  type: "file" | "directory" | "symlink" | "other";
  mtime?: string;
}

export interface LegacyMigrationArchiveIndex {
  cache_id: string;
  bytes: number;
  sha256: string;
  file_count: number;
  uncompressed_bytes: number;
  entries: LegacyMigrationArchiveEntry[];
  truncated: boolean;
  duration_ms: number;
}

export interface LegacyMigrationProjectSummary {
  legacy_project_id: string;
  title: string;
  description?: string | null;
  last_edited?: Date | string | null;
  last_active?: Date | string | null;
  hidden?: boolean | null;
  artifact_status?: string | null;
  disk_mb?: number | null;
  artifact_bucket?: string | null;
  artifact_key?: string | null;
  manifest_key?: string | null;
  artifact_manifest?: Record<string, any> | null;
  matched_legacy_account_ids: string[];
  project_id?: string | null;
  owner_account_id?: string | null;
  import_status: LegacyMigrationProjectImportStatus;
  restore_mode?: LegacyMigrationProjectRestoreMode | null;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_error?: string | null;
  restore_result?: Record<string, any> | null;
  joined?: boolean;
}

export interface LegacyMigrationListProjectsOptions {
  account_id?: string;
  include_hidden?: boolean;
  limit?: number;
  max_disk_mb?: number;
  query?: string;
}

export interface LegacyMigrationMatchedAccount {
  legacy_account_id: string;
  email_address?: string | null;
  match_method?: string | null;
  gmail_canonical_email?: string | null;
}

export interface LegacyMigrationListProjectsResponse {
  legacy_account_ids: string[];
  legacy_accounts?: LegacyMigrationMatchedAccount[];
  projects: LegacyMigrationProjectSummary[];
  total_count: number;
}

export interface LegacyMigrationImportProjectsOptions {
  account_id?: string;
  legacy_project_ids: string[];
  restore_mode?: LegacyMigrationProjectRestoreMode;
  rootfs_image?: string;
  rootfs_image_id?: string;
  host_id?: string;
  region?: string;
}

export interface LegacyMigrationImportProjectResult {
  legacy_project_id: string;
  project_id?: string;
  status: "imported" | "joined" | "creating" | "failed";
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  error?: string;
}

export interface LegacyMigrationImportProjectsResponse {
  results: LegacyMigrationImportProjectResult[];
}

export interface LegacyMigrationPrepareArchiveSelectionOptions {
  account_id?: string;
  legacy_project_id: string;
  max_entries?: number;
}

export interface LegacyMigrationPrepareArchiveSelectionResponse {
  legacy_project_id: string;
  project_id: string;
  index: LegacyMigrationArchiveIndex;
}

export interface LegacyMigrationRestoreArchiveSelectionOptions {
  account_id?: string;
  legacy_project_id: string;
  include_paths?: string[];
  exclude_paths?: string[];
}

export interface LegacyMigrationRestoreArchiveSelectionResponse {
  legacy_project_id: string;
  project_id: string;
  restore_status: LegacyMigrationProjectRestoreStatus;
  result?: Record<string, any>;
}

export interface LegacyMigration {
  listProjects: (
    opts?: LegacyMigrationListProjectsOptions,
  ) => Promise<LegacyMigrationListProjectsResponse>;
  importProjects: (
    opts: LegacyMigrationImportProjectsOptions,
  ) => Promise<LegacyMigrationImportProjectsResponse>;
  prepareArchiveSelection: (
    opts: LegacyMigrationPrepareArchiveSelectionOptions,
  ) => Promise<LegacyMigrationPrepareArchiveSelectionResponse>;
  restoreArchiveSelection: (
    opts: LegacyMigrationRestoreArchiveSelectionOptions,
  ) => Promise<LegacyMigrationRestoreArchiveSelectionResponse>;
}

export const legacyMigration = {
  listProjects: authFirstRequireAccount,
  importProjects: authFirstRequireAccount,
  prepareArchiveSelection: authFirstRequireAccount,
  restoreArchiveSelection: authFirstRequireAccount,
} as const;
