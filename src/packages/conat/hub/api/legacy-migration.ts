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

export type LegacyMigrationProjectRestoreMode = "full";

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
  include_not_available?: boolean;
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

export type LegacyMigrationPublicSharePathType =
  | "directory"
  | "file"
  | "unknown";

export interface LegacyMigrationPublicShareSummary {
  legacy_public_path_id: string;
  legacy_project_id: string;
  legacy_account_ids: string[];
  project_title?: string | null;
  path: string;
  path_type: LegacyMigrationPublicSharePathType;
  title?: string | null;
  description?: string | null;
  legacy_url?: string | null;
  disabled: boolean;
  created?: Date | string | null;
  last_edited?: Date | string | null;
  project_id?: string | null;
  import_status: LegacyMigrationProjectImportStatus;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
}

export interface LegacyMigrationListPublicSharesOptions {
  account_id?: string;
  include_disabled?: boolean;
  limit?: number;
  offset?: number;
  query?: string;
}

export interface LegacyMigrationListPublicSharesResponse {
  legacy_account_ids: string[];
  shares: LegacyMigrationPublicShareSummary[];
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
  // Transport timeout for the bounded import setup/enqueue RPC. File restore
  // itself runs asynchronously via project LROs.
  timeout?: number;
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

export type LegacyMigrationProjectRemediationDiffKind =
  | "add"
  | "update"
  | "delete"
  | "other";

export interface LegacyMigrationProjectRemediationDiffEntry {
  path: string;
  kind: LegacyMigrationProjectRemediationDiffKind;
  itemized?: string;
}

export interface LegacyMigrationProjectRemediationStatusOptions {
  account_id?: string;
  project_id: string;
}

export interface LegacyMigrationProjectRemediationStatusResponse {
  project_id: string;
  legacy_project_id?: string | null;
  needs_remediation: boolean;
  reason?: string | null;
  restored_at?: string | null;
  r2_refreshed_at?: string | null;
  snapshot_name?: string | null;
  snapshot_path?: string | null;
  diff_counts?: Record<LegacyMigrationProjectRemediationDiffKind, number>;
  diff_files?: LegacyMigrationProjectRemediationDiffEntry[];
  diff_file_count?: number;
  truncated?: boolean;
  prepared_at?: string | null;
  applied_at?: string | null;
  dismissed_forever?: boolean;
  safety_snapshot_name?: string | null;
}

export interface LegacyMigrationPrepareProjectRemediationOptions {
  account_id?: string;
  project_id: string;
  snapshot_name?: string;
}

export type LegacyMigrationPrepareProjectRemediationResponse =
  LegacyMigrationProjectRemediationStatusResponse;

export interface LegacyMigrationAdminPrepareProjectRemediationOptions {
  account_id?: string;
  project_id: string;
  snapshot_name?: string;
}

export type LegacyMigrationAdminPrepareProjectRemediationResponse =
  LegacyMigrationProjectRemediationStatusResponse;

export interface LegacyMigrationAdminApplyProjectRemediationOptions {
  account_id?: string;
  project_id: string;
  snapshot_name?: string;
  reason: string;
  support_reference?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}

export type LegacyMigrationAdminApplyProjectRemediationResponse =
  LegacyMigrationProjectRemediationStatusResponse;

export interface LegacyMigrationApplyProjectRemediationOptions {
  account_id?: string;
  project_id: string;
  snapshot_name?: string;
}

export type LegacyMigrationApplyProjectRemediationResponse =
  LegacyMigrationProjectRemediationStatusResponse;

export interface LegacyMigrationDismissProjectRemediationOptions {
  account_id?: string;
  project_id: string;
  forever?: boolean;
}

export type LegacyMigrationDismissProjectRemediationResponse =
  LegacyMigrationProjectRemediationStatusResponse;

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
  membership_grant_ends_at?: string | null;
  membership_renewal_class?: string | null;
  membership_renewal_interval?: "month" | "year" | null;
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

export interface LegacyMigrationFinancialMembershipGrantHomeBayOptions {
  account_id: string;
}

export interface LegacyMigrationFinancialMembershipGrantHomeBayResponse {
  subscription_id: number | null;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
  membership_grant_ends_at?: string | null;
  membership_renewal_configured: boolean;
}

export interface LegacyMigrationConfigureFinancialRenewalOptions {
  account_id?: string;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
}

export interface LegacyMigrationConfigureFinancialRenewalHomeBayOptions {
  account_id: string;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
}

export interface LegacyMigrationConfigureFinancialRenewalResponse {
  subscription_id: number;
  membership_class?: string | null;
  membership_interval?: "month" | "year" | null;
  membership_grant_ends_at?: string | null;
  membership_renewal_configured: boolean;
}

export interface LegacyMigrationAdminAccountSummary {
  legacy_account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  last_active?: Date | string | null;
  project_count?: number | null;
  target_claim_methods: string[];
  support_admin_linked_account_ids: string[];
}

export interface LegacyMigrationAdminAccountSearchOptions {
  account_id?: string;
  target_account_id: string;
  query: string;
  limit?: number;
}

export interface LegacyMigrationAdminAccountSearchResponse {
  accounts: LegacyMigrationAdminAccountSummary[];
  total_count: number;
}

export interface LegacyMigrationAdminProjectAccountCandidate extends Omit<
  LegacyMigrationAdminAccountSummary,
  "project_count"
> {
  role: "owner" | "collaborator";
}

export interface LegacyMigrationAdminProjectSummary {
  legacy_project_id: string;
  name?: string | null;
  title: string;
  owner_legacy_account_id?: string | null;
  owner_email_address?: string | null;
  owner_display_name?: string | null;
  candidate_legacy_account_ids: string[];
  candidate_legacy_accounts?: LegacyMigrationAdminProjectAccountCandidate[];
  target_claim_methods: string[];
  last_edited?: Date | string | null;
  last_active?: Date | string | null;
  disk_mb?: number | null;
  artifact_status?: string | null;
  artifact_bytes?: number | null;
  project_id?: string | null;
  owner_account_id?: string | null;
  import_status: LegacyMigrationProjectImportStatus;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  joined?: boolean;
}

export interface LegacyMigrationAdminProjectSearchOptions {
  account_id?: string;
  target_account_id: string;
  query: string;
  limit?: number;
}

export interface LegacyMigrationAdminProjectSearchResponse {
  projects: LegacyMigrationAdminProjectSummary[];
  total_count: number;
}

export interface LegacyMigrationAdminLinkSummary extends LegacyMigrationAdminAccountSummary {
  claim_method: string;
  metadata?: Record<string, any> | null;
  created?: Date | string | null;
  updated?: Date | string | null;
}

export interface LegacyMigrationAdminLinksOptions {
  account_id?: string;
  target_account_id: string;
}

export interface LegacyMigrationAdminLinksResponse {
  links: LegacyMigrationAdminLinkSummary[];
}

export interface LegacyMigrationAdminLinkLegacyAccountOptions {
  account_id?: string;
  target_account_id: string;
  legacy_account_id: string;
  reason: string;
  support_reference?: string;
  evidence?: Record<string, unknown>;
  browser_id?: string | null;
  session_hash?: string | null;
}

export interface LegacyMigrationAdminLinkLegacyAccountResponse {
  link: LegacyMigrationAdminLinkSummary;
  warnings: string[];
}

export interface LegacyMigrationAdminUnlinkLegacyAccountOptions {
  account_id?: string;
  target_account_id: string;
  legacy_account_id: string;
  reason: string;
  support_reference?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}

export interface LegacyMigrationAdminUnlinkLegacyAccountResponse {
  removed: boolean;
}

export interface LegacyMigrationAdminLinkedProjectsOptions {
  account_id?: string;
  target_account_id: string;
  legacy_account_id: string;
  limit?: number;
}

export interface LegacyMigrationAdminLinkedProjectsResponse {
  projects: LegacyMigrationAdminProjectSummary[];
  total_count: number;
  limit: number;
}

export interface LegacyMigrationAdminReplayPublicPathsOptions {
  account_id?: string;
  legacy_project_id: string;
  commit?: boolean;
  reason: string;
  support_reference?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}

export interface LegacyMigrationAdminReplayPublicPathsResponse {
  legacy_project_id: string;
  project_id: string;
  restore_status?: LegacyMigrationProjectRestoreStatus | null;
  public_path_count: number;
  file_path_count: number;
  imported: number;
  skipped: number;
  committed: boolean;
}

export interface LegacyMigrationAdminReplayRestoredPublicPathsOptions {
  account_id?: string;
  after_legacy_project_id?: string;
  limit?: number;
  commit?: boolean;
  reason: string;
  support_reference?: string;
  browser_id?: string | null;
  session_hash?: string | null;
}

export interface LegacyMigrationAdminReplayRestoredPublicPathsProject {
  legacy_project_id: string;
  project_id: string;
  public_path_count: number;
  missing_share_count: number;
  pending_share_count: number;
  imported: number;
  skipped: number;
  error?: string;
}

export interface LegacyMigrationAdminReplayRestoredPublicPathsResponse {
  projects: LegacyMigrationAdminReplayRestoredPublicPathsProject[];
  committed: boolean;
  has_more: boolean;
  next_after_legacy_project_id?: string;
}

export interface LegacyMigration {
  listProjects: (
    opts?: LegacyMigrationListProjectsOptions,
  ) => Promise<LegacyMigrationListProjectsResponse>;
  listPublicShares: (
    opts?: LegacyMigrationListPublicSharesOptions,
  ) => Promise<LegacyMigrationListPublicSharesResponse>;
  importProjects: (
    opts: LegacyMigrationImportProjectsOptions,
  ) => Promise<LegacyMigrationImportProjectsResponse>;
  retryProjectRestore: (
    opts: LegacyMigrationRetryProjectRestoreOptions,
  ) => Promise<LegacyMigrationRetryProjectRestoreResponse>;
  getProjectRemediation: (
    opts: LegacyMigrationProjectRemediationStatusOptions,
  ) => Promise<LegacyMigrationProjectRemediationStatusResponse>;
  prepareProjectRemediation: (
    opts: LegacyMigrationPrepareProjectRemediationOptions,
  ) => Promise<LegacyMigrationPrepareProjectRemediationResponse>;
  adminPrepareProjectRemediation: (
    opts: LegacyMigrationAdminPrepareProjectRemediationOptions,
  ) => Promise<LegacyMigrationAdminPrepareProjectRemediationResponse>;
  adminApplyProjectRemediation: (
    opts: LegacyMigrationAdminApplyProjectRemediationOptions,
  ) => Promise<LegacyMigrationAdminApplyProjectRemediationResponse>;
  applyProjectRemediation: (
    opts: LegacyMigrationApplyProjectRemediationOptions,
  ) => Promise<LegacyMigrationApplyProjectRemediationResponse>;
  dismissProjectRemediation: (
    opts: LegacyMigrationDismissProjectRemediationOptions,
  ) => Promise<LegacyMigrationDismissProjectRemediationResponse>;
  previewFinancialMigration: (
    opts?: LegacyMigrationFinancialPreviewOptions,
  ) => Promise<LegacyMigrationFinancialPreviewResponse>;
  applyFinancialMigration: (
    opts?: LegacyMigrationApplyFinancialOptions,
  ) => Promise<LegacyMigrationApplyFinancialResponse>;
  configureFinancialMembershipRenewal: (
    opts?: LegacyMigrationConfigureFinancialRenewalOptions,
  ) => Promise<LegacyMigrationConfigureFinancialRenewalResponse>;
  adminSearchLegacyAccounts: (
    opts: LegacyMigrationAdminAccountSearchOptions,
  ) => Promise<LegacyMigrationAdminAccountSearchResponse>;
  adminSearchLegacyProjects: (
    opts: LegacyMigrationAdminProjectSearchOptions,
  ) => Promise<LegacyMigrationAdminProjectSearchResponse>;
  adminListLegacyAccountLinks: (
    opts: LegacyMigrationAdminLinksOptions,
  ) => Promise<LegacyMigrationAdminLinksResponse>;
  adminLinkLegacyAccount: (
    opts: LegacyMigrationAdminLinkLegacyAccountOptions,
  ) => Promise<LegacyMigrationAdminLinkLegacyAccountResponse>;
  adminUnlinkLegacyAccount: (
    opts: LegacyMigrationAdminUnlinkLegacyAccountOptions,
  ) => Promise<LegacyMigrationAdminUnlinkLegacyAccountResponse>;
  adminListLinkedLegacyProjects: (
    opts: LegacyMigrationAdminLinkedProjectsOptions,
  ) => Promise<LegacyMigrationAdminLinkedProjectsResponse>;
  adminReplayPublicPaths: (
    opts: LegacyMigrationAdminReplayPublicPathsOptions,
  ) => Promise<LegacyMigrationAdminReplayPublicPathsResponse>;
  adminReplayRestoredPublicPaths: (
    opts: LegacyMigrationAdminReplayRestoredPublicPathsOptions,
  ) => Promise<LegacyMigrationAdminReplayRestoredPublicPathsResponse>;
}

export const legacyMigration = {
  listProjects: authFirstRequireAccount,
  listPublicShares: authFirstRequireAccount,
  importProjects: authFirstRequireAccount,
  retryProjectRestore: authFirstRequireAccount,
  getProjectRemediation: authFirstRequireAccount,
  prepareProjectRemediation: authFirstRequireAccount,
  adminPrepareProjectRemediation: authFirstRequireAccount,
  adminApplyProjectRemediation: authFirstRequireAccount,
  applyProjectRemediation: authFirstRequireAccount,
  dismissProjectRemediation: authFirstRequireAccount,
  previewFinancialMigration: authFirstRequireAccount,
  applyFinancialMigration: authFirstRequireAccount,
  configureFinancialMembershipRenewal: authFirstRequireAccount,
  adminSearchLegacyAccounts: authFirstRequireAccount,
  adminSearchLegacyProjects: authFirstRequireAccount,
  adminListLegacyAccountLinks: authFirstRequireAccount,
  adminLinkLegacyAccount: authFirstRequireAccount,
  adminUnlinkLegacyAccount: authFirstRequireAccount,
  adminListLinkedLegacyProjects: authFirstRequireAccount,
  adminReplayPublicPaths: authFirstRequireAccount,
  adminReplayRestoredPublicPaths: authFirstRequireAccount,
} as const;
