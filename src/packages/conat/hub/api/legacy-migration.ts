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
  artifact_bytes?: number | null;
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
  restore_lro_op_id?: string | null;
  restore_progress?: Record<string, any> | null;
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
  display_name?: string | null;
  match_method?: string | null;
  gmail_canonical_email?: string | null;
}

export interface LegacyMigrationListProjectsResponse {
  legacy_account_ids: string[];
  legacy_accounts?: LegacyMigrationMatchedAccount[];
  email_verification_required?: boolean;
  email_verification_email?: string | null;
  unverified_email_matches?: LegacyMigrationMatchedAccount[];
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
  restore_lro_op_id?: string | null;
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

export interface LegacyMigrationRetryProjectRestoreOptions {
  account_id?: string;
  legacy_project_id: string;
}

export interface LegacyMigrationRetryProjectRestoreResponse {
  legacy_project_id: string;
  project_id: string;
  restore_status: LegacyMigrationProjectRestoreStatus;
  restore_lro_op_id?: string | null;
}

export interface LegacyMigrationMembershipPlan {
  id: string;
  label: string;
  price_monthly?: number | null;
  price_yearly?: number | null;
}

export interface LegacyMigrationEntitlementCredit {
  source: "subscription" | "site_license" | "stripe_legacy_subscription";
  id: string;
  credit_amount: number;
  period_cost?: number | null;
  period_start?: Date | string | null;
  period_end?: Date | string | null;
  interval?: string | null;
  status?: string | null;
  description?: string | null;
}

export interface LegacyMigrationFinancialAccount {
  legacy_account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  stripe_customer_id?: string | null;
  credit_amount: number;
  balance: number;
  balance_credit_amount: number;
  entitlement_credit_amount: number;
  entitlement_credits: LegacyMigrationEntitlementCredit[];
  unvalued_active_site_license_count: number;
  active_subscription_annualized: number;
  active_subscription_count: number;
  suggested_membership_interval: "month" | "year";
  selected_membership_class?: string | null;
  selected_membership_interval?: "month" | "year" | null;
  claimed_by_account_id?: string | null;
  claimed_at?: Date | string | null;
}

export interface LegacyMigrationFinancialPreviewOptions {
  account_id?: string;
}

export interface LegacyMigrationFinancialPreviewResponse {
  legacy_accounts: LegacyMigrationFinancialAccount[];
  email_verification_required?: boolean;
  email_verification_email?: string | null;
  unverified_email_matches?: LegacyMigrationMatchedAccount[];
  pending_credit_amount: number;
  applied_credit_amount: number;
  active_subscription_annualized: number;
  active_subscription_count: number;
  suggested_membership_class?: string | null;
  suggested_membership_interval: "month" | "year";
  suggested_membership_grant_days: number;
  applied_membership_class?: string | null;
  applied_membership_interval?: "month" | "year" | null;
  membership_already_applied: boolean;
  membership_renewal_configured: boolean;
  stripe_customer_id?: string | null;
  plans: LegacyMigrationMembershipPlan[];
  can_apply: boolean;
}

export interface LegacyMigrationApplyFinancialOptions {
  account_id?: string;
  membership_class?: string | null;
  membership_interval?: "month" | "year";
}

export interface LegacyMigrationApplyFinancialResponse {
  claimed_legacy_account_ids: string[];
  credit_amount: number;
  credit_purchase_ids: number[];
  subscription_id?: number | null;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
  membership_grant_days?: number | null;
  membership_grant_ends_at?: string | null;
  stripe_customer_id?: string | null;
}

export interface LegacyMigrationApplyFinancialHomeBayOptions {
  account_id: string;
  claimed: LegacyMigrationFinancialAccount[];
  stripe_customer_id?: string | null;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
}

export interface LegacyMigrationApplyFinancialHomeBayResponse {
  credit_purchase_ids: number[];
  credit_purchase_id_by_legacy_account: Record<string, number>;
  subscription_id?: number | null;
  membership_grant_ends_at?: string | null;
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
  retryProjectRestore: (
    opts: LegacyMigrationRetryProjectRestoreOptions,
  ) => Promise<LegacyMigrationRetryProjectRestoreResponse>;
  previewFinancialMigration: (
    opts?: LegacyMigrationFinancialPreviewOptions,
  ) => Promise<LegacyMigrationFinancialPreviewResponse>;
  applyFinancialMigration: (
    opts?: LegacyMigrationApplyFinancialOptions,
  ) => Promise<LegacyMigrationApplyFinancialResponse>;
}

export const legacyMigration = {
  listProjects: authFirstRequireAccount,
  importProjects: authFirstRequireAccount,
  prepareArchiveSelection: authFirstRequireAccount,
  restoreArchiveSelection: authFirstRequireAccount,
  retryProjectRestore: authFirstRequireAccount,
  previewFinancialMigration: authFirstRequireAccount,
  applyFinancialMigration: authFirstRequireAccount,
} as const;
