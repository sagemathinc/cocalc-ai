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
  | "failed";

export interface LegacyMigrationProjectSummary {
  legacy_project_id: string;
  title: string;
  description?: string | null;
  last_edited?: Date | string | null;
  last_active?: Date | string | null;
  hidden?: boolean | null;
  artifact_status?: string | null;
  artifact_bucket?: string | null;
  artifact_key?: string | null;
  manifest_key?: string | null;
  artifact_manifest?: Record<string, any> | null;
  matched_legacy_account_ids: string[];
  project_id?: string | null;
  owner_account_id?: string | null;
  import_status: LegacyMigrationProjectImportStatus;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  restore_error?: string | null;
  joined?: boolean;
}

export interface LegacyMigrationListProjectsOptions {
  account_id?: string;
  include_hidden?: boolean;
  limit?: number;
  query?: string;
}

export interface LegacyMigrationListProjectsResponse {
  legacy_account_ids: string[];
  projects: LegacyMigrationProjectSummary[];
}

export interface LegacyMigrationImportProjectsOptions {
  account_id?: string;
  legacy_project_ids: string[];
  rootfs_image?: string;
  rootfs_image_id?: string;
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

export interface LegacyMigration {
  listProjects: (
    opts?: LegacyMigrationListProjectsOptions,
  ) => Promise<LegacyMigrationListProjectsResponse>;
  importProjects: (
    opts: LegacyMigrationImportProjectsOptions,
  ) => Promise<LegacyMigrationImportProjectsResponse>;
}

export const legacyMigration = {
  listProjects: authFirstRequireAccount,
  importProjects: authFirstRequireAccount,
} as const;
