import { authFirst } from "./util";
import type { MoneyValue } from "@cocalc/util/money";
export type MembershipClass = string;
export type MembershipPackageKind = "course" | "team" | "site";

export type MembershipEgressPolicy =
  | "metered-shared-hosts"
  | "all-shared-hosts"
  | "disabled";

export type DedicatedHostEgressPolicy =
  | "tier-capped"
  | "meter-and-bill"
  | "disabled";

export interface MembershipUsageLimits {
  shared_compute_priority?: number;
  total_storage_soft_bytes?: number;
  total_storage_hard_bytes?: number;
  max_projects?: number;
  max_sponsored_running_projects?: number;
  max_snapshots_per_project?: number;
  max_backups_per_project?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  cpu_5h_seconds?: number;
  cpu_7d_seconds?: number;
  egress_policy?: MembershipEgressPolicy;
  dedicated_host_egress_policy?: DedicatedHostEgressPolicy;
  credit_spend_limit_5h_usd?: number;
  credit_spend_limit_7d_usd?: number;
  prepaid_host_usage_limit_5h_usd?: number;
  prepaid_host_usage_limit_7d_usd?: number;
  notification_email_send_limit_5h?: number;
  notification_email_send_limit_7d?: number;
  invite_email_send_enabled?: boolean;
  invite_email_daily_count?: number;
  invite_email_hourly_count?: number;
  invite_email_recipients_per_batch?: number;
  invite_email_pending_per_project?: number;
  invite_email_pending_per_course?: number;
  invite_email_resend_cooldown_minutes?: number;
  invite_email_custom_message_max_chars?: number;
  invite_email_allow_project_title?: boolean;
  invite_email_allow_course_title?: boolean;
  invite_email_allow_urls?: boolean;
  invite_email_link_copy_enabled?: boolean;
  project_max_collaborators_and_pending_invites?: number;
  course_max_students_and_pending_invites?: number;
  acp_max_queued_per_account?: number;
  acp_max_queued_per_thread?: number;
  acp_max_created_5h_per_account?: number;
  acp_max_created_7d_per_account?: number;
  acp_max_running_per_account?: number;
  acp_max_running_per_project?: number;
  acp_max_active_automations_per_project?: number;
  blob_account_total_bytes?: number;
  blob_account_count?: number;
  blob_project_total_bytes?: number;
  blob_project_count?: number;
  rootfs_count?: number;
  rootfs_total_storage_gb?: number;
  rootfs_max_storage_gb?: number;
  rootfs_oci_images?: boolean;
}

export interface MembershipEffectiveLimits extends MembershipUsageLimits {}

export interface MembershipEntitlements {
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: MembershipUsageLimits;
}

export type NumericLimitRuleMode = "minimum" | "maximum" | "set";

export interface NumericLimitRule {
  mode: NumericLimitRuleMode;
  value: number;
}

export interface EnumOverride<T extends string> {
  mode: "set";
  value: T;
}

export interface AccountFeatureOverrides {
  create_hosts?: boolean;
}

export interface ProjectDefaultOverrides {
  disk_quota?: NumericLimitRule;
  memory?: NumericLimitRule;
  memory_request?: NumericLimitRule;
}

export interface AiLimitOverrides {
  units_5h?: NumericLimitRule;
  units_7d?: NumericLimitRule;
}

export interface AccountUsageLimitOverrides {
  shared_compute_priority?: NumericLimitRule;
  total_storage_soft_bytes?: NumericLimitRule;
  total_storage_hard_bytes?: NumericLimitRule;
  max_projects?: NumericLimitRule;
  max_sponsored_running_projects?: NumericLimitRule;
  max_snapshots_per_project?: NumericLimitRule;
  max_backups_per_project?: NumericLimitRule;
  egress_5h_bytes?: NumericLimitRule;
  egress_7d_bytes?: NumericLimitRule;
  cpu_5h_seconds?: NumericLimitRule;
  cpu_7d_seconds?: NumericLimitRule;
  egress_policy?: EnumOverride<MembershipEgressPolicy>;
  dedicated_host_egress_policy?: EnumOverride<DedicatedHostEgressPolicy>;
  credit_spend_limit_5h_usd?: NumericLimitRule;
  credit_spend_limit_7d_usd?: NumericLimitRule;
  prepaid_host_usage_limit_5h_usd?: NumericLimitRule;
  prepaid_host_usage_limit_7d_usd?: NumericLimitRule;
  notification_email_send_limit_5h?: NumericLimitRule;
  notification_email_send_limit_7d?: NumericLimitRule;
  invite_email_send_enabled?: EnumOverride<"true" | "false">;
  invite_email_daily_count?: NumericLimitRule;
  invite_email_hourly_count?: NumericLimitRule;
  invite_email_recipients_per_batch?: NumericLimitRule;
  invite_email_pending_per_project?: NumericLimitRule;
  invite_email_pending_per_course?: NumericLimitRule;
  invite_email_resend_cooldown_minutes?: NumericLimitRule;
  invite_email_custom_message_max_chars?: NumericLimitRule;
  invite_email_allow_project_title?: EnumOverride<"true" | "false">;
  invite_email_allow_course_title?: EnumOverride<"true" | "false">;
  invite_email_allow_urls?: EnumOverride<"true" | "false">;
  invite_email_link_copy_enabled?: EnumOverride<"true" | "false">;
  project_max_collaborators_and_pending_invites?: NumericLimitRule;
  course_max_students_and_pending_invites?: NumericLimitRule;
  acp_max_queued_per_account?: NumericLimitRule;
  acp_max_queued_per_thread?: NumericLimitRule;
  acp_max_created_5h_per_account?: NumericLimitRule;
  acp_max_created_7d_per_account?: NumericLimitRule;
  acp_max_running_per_account?: NumericLimitRule;
  acp_max_running_per_project?: NumericLimitRule;
  acp_max_active_automations_per_project?: NumericLimitRule;
  blob_account_total_bytes?: NumericLimitRule;
  blob_account_count?: NumericLimitRule;
  blob_project_total_bytes?: NumericLimitRule;
  blob_project_count?: NumericLimitRule;
  rootfs_count?: NumericLimitRule;
  rootfs_total_storage_gb?: NumericLimitRule;
  rootfs_max_storage_gb?: NumericLimitRule;
}

export interface DedicatedHostPolicyOverrides {
  funding_mode?: EnumOverride<
    "account-prepaid" | "account-postpaid" | "site-funded"
  >;
}

export interface AccountEntitlementOverride {
  account_id: string;
  enabled: boolean;
  features?: AccountFeatureOverrides;
  project_defaults?: ProjectDefaultOverrides;
  ai_limits?: AiLimitOverrides;
  usage_limits?: AccountUsageLimitOverrides;
  dedicated_hosts?: DedicatedHostPolicyOverrides;
  reason?: string | null;
  expires_at?: Date | string | null;
  updated_by: string;
  updated_at: Date | string;
}

export interface AccountEntitlementOverrideEvent {
  id: string;
  account_id: string;
  action: "set" | "clear" | "expire" | "disable";
  old_value?: AccountEntitlementOverride | null;
  new_value?: AccountEntitlementOverride | null;
  reason: string;
  actor_account_id: string;
  created_at: Date | string;
}

export interface MembershipResolution {
  class: MembershipClass;
  source: "subscription" | "admin" | "grant" | "free";
  entitlements: MembershipEntitlements;
  effective_limits?: MembershipEffectiveLimits;
  starts?: Date;
  subscription_id?: number;
  subscription_status?: "active" | "canceled";
  subscription_cost?: number;
  subscription_interval?: "month" | "year";
  grant_id?: string;
  grant_source?: string;
  grant_package_id?: string;
  grant_purchase_id?: number;
  pool_name?: string;
  pool_description?: string | null;
  site_license_id?: string;
  site_license_name?: string;
  organization_name?: string;
  team_license_id?: string;
  team_license_status?: TeamLicenseStatus;
  team_license_period_end?: Date | string;
  team_license_warning?: TeamLicenseWarning;
  expires?: Date;
}

export interface MembershipCandidate {
  class: MembershipClass;
  source: "subscription" | "admin" | "grant";
  priority: number;
  entitlements: MembershipEntitlements;
  effective_limits?: MembershipEffectiveLimits;
  starts?: Date;
  subscription_id?: number;
  subscription_status?: "active" | "canceled";
  subscription_cost?: number;
  subscription_interval?: "month" | "year";
  grant_id?: string;
  grant_source?: string;
  grant_package_id?: string;
  grant_purchase_id?: number;
  pool_name?: string;
  pool_description?: string | null;
  site_license_id?: string;
  site_license_name?: string;
  organization_name?: string;
  team_license_id?: string;
  team_license_status?: TeamLicenseStatus;
  team_license_period_end?: Date | string;
  team_license_warning?: TeamLicenseWarning;
  expires?: Date;
}

export interface MembershipAdminOverrideSummary {
  expires_at?: Date | string | null;
  effects?: string[];
  updated_at: Date | string;
}

export interface MembershipDetails {
  selected: MembershipResolution;
  candidates: MembershipCandidate[];
  usage_status?: MembershipUsageStatus;
  admin_override?: MembershipAdminOverrideSummary;
}

export interface MembershipPackageQuote {
  package_id?: string;
  kind: MembershipPackageKind;
  membership_class: MembershipClass;
  seat_count: number;
  seat_price: number;
  total_price: number;
  starts_at?: Date;
  expires_at?: Date;
  interval?: "month" | "year";
  metadata?: Record<string, unknown> | null;
}

export interface MembershipPackageAssignment {
  id: string;
  package_id: string;
  account_id?: string | null;
  email_address?: string | null;
  account_email_address?: string | null;
  assigned_by_account_id?: string | null;
  assigned_at?: Date;
  revoked_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  grant_id?: string | null;
  grant_source?: string | null;
  grant_expires_at?: Date | string | null;
  grant_purchase_id?: number | null;
}

export interface ClaimableMembershipPackage {
  package_id: string;
  assignment_id?: string;
  kind: MembershipPackageKind;
  membership_class: MembershipClass;
  owner_account_id: string;
  starts_at?: Date;
  expires_at?: Date | null;
  available_seat_count: number;
  matched_email_address: string;
  reason: "email-assignment" | "domain-match";
  requires_approval?: boolean;
  site_license_id?: string;
  site_license_name?: string | null;
  organization_name?: string | null;
  pool_name?: string;
  pool_description?: string;
  verification_policy?: SiteLicenseVerificationPolicy;
  exclusive_group?: string;
  pending_request_id?: string;
  pending_request_state?: SiteLicensePoolRequestState;
  seat_status?: "claimable" | "claimed" | "pending";
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  requires_terms_acceptance?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface MembershipPackageRecord {
  id: string;
  owner_account_id: string;
  kind: MembershipPackageKind;
  membership_class: MembershipClass;
  seat_count: number;
  purchase_id?: number | null;
  starts_at?: Date;
  expires_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export interface MembershipPackageDetails extends MembershipPackageRecord {
  active_assignment_count: number;
  available_seat_count: number;
  assignments: MembershipPackageAssignment[];
}

export type TeamLicenseStatus = "active" | "past_due" | "canceled";

export interface TeamLicenseWarning {
  type: "past_due";
  team_license_id: string;
  expired_at: Date | string;
  message: string;
}

export interface TeamLicenseRecord {
  id: string;
  owner_account_id: string;
  status: TeamLicenseStatus;
  current_period_start: Date | string;
  current_period_end: Date | string;
  latest_purchase_id?: number | null;
  payment?: Record<string, unknown> | null;
  last_renewal_attempt_at?: Date | string | null;
  last_renewal_notice_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
}

export interface TeamLicenseSeatLine {
  id: string;
  team_license_id: string;
  owner_account_id: string;
  membership_class: MembershipClass;
  package_id?: string | null;
  seat_count: number;
  annual_price_per_seat: number;
  metadata?: Record<string, unknown> | null;
  created?: Date | string;
  updated?: Date | string;
  package?: MembershipPackageDetails;
}

export interface TeamLicenseOverview extends TeamLicenseRecord {
  seat_lines: TeamLicenseSeatLine[];
  packages: MembershipPackageDetails[];
}

export interface TeamLicenseQuoteLineItem {
  description: string;
  amount: number;
}

export interface TeamLicenseQuote {
  team_license_id?: string;
  current_period_start: Date | string;
  current_period_end: Date | string;
  target_seats: Record<string, number>;
  current_seats: Record<string, number>;
  assigned_seats: Record<string, number>;
  added_seats: Record<string, number>;
  line_items: TeamLicenseQuoteLineItem[];
  total_price: number;
  interval: "year";
}

export type SiteLicenseManagerRole = "manager" | "viewer";
export type SiteLicenseVerificationPolicy =
  | "email-domain"
  | "sso-affiliation"
  | "manager-approval"
  | "external-claim";
export type SiteLicensePoolRequestState =
  | "pending"
  | "approved"
  | "rejected"
  | "canceled"
  | "expired";

export interface SiteLicensePoolConfig {
  pool_name: string;
  pool_description?: string | null;
  membership_class: MembershipClass;
  seat_count: number;
  requires_approval: boolean;
  verification_policy: SiteLicenseVerificationPolicy;
  exclusive_group?: string | null;
  affiliation_reverification_days?: number | null;
  affiliation_reverification_grace_days?: number | null;
  allowed_domains?: string[];
  metadata?: Record<string, unknown> | null;
}

export interface SiteLicenseRecord {
  id: string;
  name: string;
  organization_name: string;
  bay_id: string;
  owner_account_id?: string | null;
  allowed_domains: string[];
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | null;
  expires_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export interface SiteLicenseManager {
  id: string;
  site_license_id: string;
  account_id: string;
  role: SiteLicenseManagerRole;
  created_by_account_id?: string | null;
  revoked_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export type SiteLicenseViewerRole = "admin" | "manager" | "viewer";

export interface SiteLicensePoolSummary extends MembershipPackageDetails {
  pool_name: string;
  pool_description?: string | null;
  requires_approval: boolean;
  verification_policy: SiteLicenseVerificationPolicy;
  exclusive_group: string;
  affiliation_reverification_days?: number | null;
  affiliation_reverification_grace_days?: number | null;
  pending_request_count: number;
}

export interface SiteLicensePoolRequest {
  id: string;
  site_license_id: string;
  package_id: string;
  account_id: string;
  matched_email_address: string;
  canonical_identity: string;
  requested_membership_class: MembershipClass;
  state: SiteLicensePoolRequestState;
  requester_note?: string | null;
  reviewer_account_id?: string | null;
  review_note?: string | null;
  requested_at?: Date;
  reviewed_at?: Date | null;
  expires_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export type SiteLicenseAuditAction =
  | "site-license-provisioned"
  | "manager-added"
  | "manager-updated"
  | "manager-removed"
  | "site-license-updated"
  | "pool-created"
  | "pool-updated"
  | "pool-archived"
  | "pool-request-created"
  | "pool-request-canceled"
  | "pool-request-approved"
  | "pool-request-rejected"
  | "external-claim-consumed"
  | "external-claim-granted"
  | "external-claim-side-effect-failed"
  | "seat-manually-assigned"
  | "seat-released-by-user"
  | "seat-released-for-upgrade"
  | "seat-affiliation-reverified"
  | "seat-released-after-reverification-grace";

export interface SiteLicenseAuditEvent {
  id: string;
  site_license_id: string;
  action: SiteLicenseAuditAction;
  actor_account_id?: string | null;
  target_account_id?: string | null;
  package_id?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
}

export type SiteLicenseExternalClaimSigningAlgorithm = "EdDSA" | "ES256";

export type SiteLicenseExternalClaimConsumptionStatus =
  | "pending-side-effect"
  | "granted"
  | "failed-retryable"
  | "failed-terminal";

export interface SiteLicenseExternalClaimPool {
  id: string;
  slug?: string | null;
  site_license_id: string;
  package_id: string;
  name: string;
  issuer: string;
  audience: string;
  default_membership_class?: MembershipClass | null;
  allow_membership_class_override: boolean;
  default_membership_duration_days?: number | null;
  default_membership_expires_at?: Date | null;
  allow_membership_expires_at_override: boolean;
  min_membership_duration_days?: number | null;
  max_membership_duration_days?: number | null;
  max_membership_expires_at?: Date | null;
  default_rootfs_id?: string | null;
  max_claims?: number | null;
  max_claims_per_account?: number | null;
  starts_at?: Date | null;
  expires_at?: Date | null;
  disabled_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  created_by_account_id?: string | null;
  created?: Date;
  updated?: Date;
}

export interface SiteLicenseExternalClaimKey {
  id: string;
  pool_id: string;
  kid: string;
  alg: SiteLicenseExternalClaimSigningAlgorithm;
  public_key_jwk?: Record<string, unknown> | null;
  public_key_pem?: string | null;
  starts_at?: Date | null;
  expires_at?: Date | null;
  revoked_at?: Date | null;
  created_by_account_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created?: Date;
  updated?: Date;
}

export interface SiteLicenseExternalClaimConsumption {
  id: string;
  pool_id: string;
  site_license_id: string;
  package_id: string;
  jti: string;
  token_hash: string;
  issuer: string;
  kid?: string | null;
  account_id: string;
  status: SiteLicenseExternalClaimConsumptionStatus;
  side_effect_key: string;
  assignment_id?: string | null;
  membership_grant_id?: string | null;
  membership_class: MembershipClass;
  membership_expires_at?: Date | null;
  rootfs_id?: string | null;
  external_subject?: string | null;
  token_expires_at?: Date | null;
  error_code?: string | null;
  error_message?: string | null;
  retry_count: number;
  last_retry_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  consumed_at: Date;
  updated: Date;
}

export interface SiteLicenseAccountDetails {
  account_id: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
  email_address?: string;
}

export interface SiteLicenseOverview {
  site_license: SiteLicenseRecord;
  pools: SiteLicensePoolSummary[];
  managers: SiteLicenseManager[];
  pending_requests: SiteLicensePoolRequest[];
  viewer_role?: SiteLicenseViewerRole;
  recent_audit_events?: SiteLicenseAuditEvent[];
  account_details?: Record<string, SiteLicenseAccountDetails>;
}

export type SiteLicenseAffiliationReverificationState =
  | "current"
  | "pending_reverification"
  | "grace_expired";

export interface SiteLicenseAffiliationReverificationSeat {
  site_license_id: string;
  package_id: string;
  assignment_id: string;
  account_id: string;
  membership_class: MembershipClass;
  pool_name?: string | null;
  exclusive_group: string;
  verification_policy: SiteLicenseVerificationPolicy;
  matched_email_address?: string | null;
  affiliation_verified_at?: Date | null;
  reverification_due_at?: Date | null;
  reverification_grace_expires_at?: Date | null;
  reverification_days?: number | null;
  grace_days?: number | null;
  state: SiteLicenseAffiliationReverificationState;
}

export interface SiteLicenseAffiliationReverificationUserSeat extends SiteLicenseAffiliationReverificationSeat {
  site_license_name?: string | null;
  organization_name?: string | null;
  site_license_owner_account_id?: string | null;
  can_refresh_with_verified_email: boolean;
}

export interface SiteLicenseAffiliationReverificationUserStatus {
  seats: SiteLicenseAffiliationReverificationUserSeat[];
  pending_count: number;
  grace_expired_count: number;
  next_reverification_due_at?: Date | null;
  next_reverification_grace_expires_at?: Date | null;
}

export interface MembershipUsageStatus {
  collected_at: string;
  owned_project_count: number;
  sampled_project_count: number;
  unsampled_project_count: number;
  measurement_error_count?: number;
  total_storage_bytes: number;
  total_storage_soft_bytes?: number;
  total_storage_hard_bytes?: number;
  total_storage_soft_remaining_bytes?: number;
  total_storage_hard_remaining_bytes?: number;
  over_total_storage_soft?: boolean;
  over_total_storage_hard?: boolean;
  max_projects?: number;
  remaining_project_slots?: number;
  over_max_projects?: boolean;
  rootfs_count?: number;
  rootfs_count_limit?: number;
  rootfs_remaining_count?: number;
  over_rootfs_count?: boolean;
  rootfs_total_storage_bytes?: number;
  rootfs_total_storage_bytes_limit?: number;
  rootfs_total_storage_remaining_bytes?: number;
  over_rootfs_total_storage?: boolean;
  rootfs_max_storage_bytes_limit?: number;
  blob_count?: number;
  blob_count_limit?: number;
  blob_remaining_count?: number;
  over_blob_count?: boolean;
  blob_total_bytes?: number;
  blob_total_bytes_limit?: number;
  blob_total_remaining_bytes?: number;
  over_blob_total_storage?: boolean;
  blob_project_count_limit?: number;
  blob_project_total_bytes_limit?: number;
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  managed_egress_5h_remaining_bytes?: number;
  managed_egress_7d_remaining_bytes?: number;
  managed_egress_5h_starts_at?: Date;
  managed_egress_7d_starts_at?: Date;
  managed_egress_5h_reset_at?: Date;
  managed_egress_7d_reset_at?: Date;
  managed_egress_5h_reset_in?: string;
  managed_egress_7d_reset_in?: string;
  over_managed_egress_5h?: boolean;
  over_managed_egress_7d?: boolean;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
  managed_egress_recent_events?: ManagedEgressEventSummary[];
  managed_cpu_5h_seconds?: number;
  managed_cpu_7d_seconds?: number;
  managed_cpu_5h_remaining_seconds?: number;
  managed_cpu_7d_remaining_seconds?: number;
  managed_cpu_5h_starts_at?: Date;
  managed_cpu_7d_starts_at?: Date;
  managed_cpu_5h_reset_at?: Date;
  managed_cpu_7d_reset_at?: Date;
  managed_cpu_5h_reset_in?: string;
  managed_cpu_7d_reset_in?: string;
  over_managed_cpu_5h?: boolean;
  over_managed_cpu_7d?: boolean;
  managed_cpu_recent_events?: ManagedCpuEventSummary[];
}

export interface ManagedEgressEventSummary {
  account_id?: string;
  project_id?: string | null;
  project_title?: string | null;
  category: string;
  bytes: number;
  occurred_at: string;
  metadata?: Record<string, unknown> | null;
}

export type ManagedEgressHistoryBucketSize = "5m" | "1h" | "1d";

export interface ManagedEgressHistoryPoint {
  start: string;
  end: string;
  bytes: number;
  categories_bytes: Record<string, number>;
}

export interface ManagedEgressProjectSummary {
  project_id: string | null;
  project_title?: string | null;
  bytes: number;
}

export interface ManagedEgressAccountSummary {
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  bytes: number;
  active_abuse_annotations?: AbuseReviewAnnotation[];
}

export interface ManagedEgressAdminProjectSummary {
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  project_id: string | null;
  project_title?: string | null;
  bytes: number;
  active_abuse_annotations?: AbuseReviewAnnotation[];
}

export interface ManagedEgressHistory {
  account_id: string;
  project_id?: string | null;
  start: string;
  end: string;
  bucket: ManagedEgressHistoryBucketSize;
  total_bytes: number;
  categories_bytes: Record<string, number>;
  points: ManagedEgressHistoryPoint[];
  top_projects: ManagedEgressProjectSummary[];
  recent_events: ManagedEgressEventSummary[];
}

export interface ManagedEgressHistoryQuery {
  account_id?: string;
  user_account_id?: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_project_limit?: number;
}

export interface ManagedEgressAdminOverview {
  start: string;
  end: string;
  total_bytes: number;
  categories_bytes: Record<string, number>;
  top_accounts: ManagedEgressAccountSummary[];
  top_projects: ManagedEgressAdminProjectSummary[];
  recent_events: ManagedEgressEventSummary[];
}

export interface ManagedEgressAdminHistory {
  start: string;
  end: string;
  bucket: ManagedEgressHistoryBucketSize;
  total_bytes: number;
  categories_bytes: Record<string, number>;
  points: ManagedEgressHistoryPoint[];
  top_accounts: ManagedEgressAccountSummary[];
  top_projects: ManagedEgressAdminProjectSummary[];
  recent_events: ManagedEgressEventSummary[];
}

export interface ManagedEgressAdminOverviewQuery {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}

export interface ManagedCpuEventSummary {
  account_id?: string;
  project_id?: string | null;
  project_title?: string | null;
  host_id?: string | null;
  cpu_seconds: number;
  sample_started_at?: string | null;
  sample_ended_at: string;
  source?: string | null;
  cpu_accounting_scope?:
    | "shared_managed"
    | "site_funded_dedicated"
    | "account_funded_dedicated"
    | "local_or_self_host"
    | "unknown"
    | null;
  counts_toward_managed_cpu_budget?: boolean | null;
  host_funding_mode_snapshot?:
    | "account-prepaid"
    | "account-postpaid"
    | "site-funded"
    | null;
  host_tier_snapshot?: number | null;
  host_kind_snapshot?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ManagedCpuAccountSummary {
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  cpu_seconds: number;
  active_abuse_annotations?: AbuseReviewAnnotation[];
}

export interface ManagedCpuAdminProjectSummary {
  account_id: string;
  email_address?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  project_id: string | null;
  project_title?: string | null;
  host_id?: string | null;
  cpu_seconds: number;
  active_abuse_annotations?: AbuseReviewAnnotation[];
}

export type AbuseReviewCategory =
  | "cpu"
  | "egress"
  | "storage"
  | "signup"
  | "payment"
  | "general";

export type AbuseReviewDisposition =
  | "legitimate"
  | "suspicious"
  | "abusive"
  | "needs_followup"
  | "false_positive";

export type AbuseReviewPriorityAdjustment =
  | "suppress"
  | "lower"
  | "normal"
  | "raise"
  | "urgent";

export interface AbuseReviewAnnotation {
  id: string;
  account_id: string;
  project_id?: string | null;
  category: AbuseReviewCategory;
  disposition: AbuseReviewDisposition;
  priority_adjustment: AbuseReviewPriorityAdjustment;
  reason: string;
  evidence?: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  expires_at?: string | null;
  revoked_by?: string | null;
  revoked_at?: string | null;
  revoked_reason?: string | null;
}

export type ManagedCpuHistoryBucketSize = ManagedEgressHistoryBucketSize;

export interface ManagedCpuHistoryPoint {
  start: string;
  end: string;
  cpu_seconds: number;
}

export interface ManagedCpuAdminOverview {
  start: string;
  end: string;
  total_cpu_seconds: number;
  top_accounts: ManagedCpuAccountSummary[];
  top_projects: ManagedCpuAdminProjectSummary[];
  recent_events: ManagedCpuEventSummary[];
}

export interface ManagedCpuAdminHistory {
  start: string;
  end: string;
  bucket: ManagedCpuHistoryBucketSize;
  total_cpu_seconds: number;
  points: ManagedCpuHistoryPoint[];
  top_accounts: ManagedCpuAccountSummary[];
  top_projects: ManagedCpuAdminProjectSummary[];
  recent_events: ManagedCpuEventSummary[];
}

export interface ManagedCpuAdminOverviewQuery {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}

export interface ManagedCpuAdminHistoryQuery {
  account_id?: string;
  user_account_id?: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedCpuHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}

export interface CreateAbuseReviewAnnotationQuery {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  user_account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  disposition?: AbuseReviewDisposition;
  priority_adjustment?: AbuseReviewPriorityAdjustment;
  reason?: string;
  evidence?: Record<string, unknown> | null;
  expires_at?: string | Date | null;
}

export interface ListAbuseReviewAnnotationsQuery {
  account_id?: string;
  user_account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  active_only?: boolean;
  limit?: number;
}

export interface RevokeAbuseReviewAnnotationQuery {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  id?: string;
  revoked_reason?: string;
}

export type MembershipUsageWindowResetTarget = "5h" | "7d" | "all";

export interface AdminResetMembershipUsageWindowsQuery {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  window?: MembershipUsageWindowResetTarget;
  reason?: string;
}

export interface AccountUsageWindowEpoch {
  scope: "membership";
  window: "5h" | "7d";
  epoch: number;
}

export interface AdminResetMembershipUsageWindowsResult {
  windows: AccountUsageWindowEpoch[];
}

export interface ManagedEgressAdminHistoryQuery {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}

export interface AIUsageWindowStatus {
  window: "5h" | "7d";
  used: number;
  limit?: number;
  remaining?: number;
  starts_at?: Date;
  resets_at?: Date;
  reset_at?: Date;
  reset_in?: string;
}

export interface AIUsageStatus {
  units_per_dollar: number;
  windows: AIUsageWindowStatus[];
}

export type AccountUsageWindow = "5h" | "7d" | "point";
export type AccountUsageMeterSeverity = "ok" | "near" | "over" | "unknown";
export type AccountUsageMeterCategory =
  | "ai"
  | "compute"
  | "network"
  | "storage"
  | "projects"
  | "collaboration"
  | "codex"
  | "rootfs"
  | "blob"
  | "spend";
export type AccountUsageMeterUnit =
  | "units"
  | "bytes"
  | "seconds"
  | "count"
  | "usd";

export interface AccountUsageMeter {
  id: string;
  category: AccountUsageMeterCategory;
  window: AccountUsageWindow;
  label: string;
  help: string;
  unit: AccountUsageMeterUnit;
  used?: number;
  limit?: number;
  remaining?: number;
  ratio?: number;
  percent?: number;
  severity: AccountUsageMeterSeverity;
  starts_at?: Date | string;
  resets_at?: Date | string;
  reset_at?: Date | string;
  reset_in?: string;
  action_when_over?: string;
  upgrade_relevant: boolean;
  source?:
    | "membership_usage_status"
    | "ai_usage_status"
    | "dedicated_host_policy_snapshot";
}

export interface AccountUsageSummaryPressure {
  percent: number;
  severity: AccountUsageMeterSeverity;
  limiting_meter_id?: string;
  limiting_meter_label?: string;
  starts_at?: Date | string;
  resets_at?: Date | string;
  reset_at?: Date | string;
  reset_in?: string;
}

export interface AccountUsageOverview {
  collected_at: string;
  membership_label?: string;
  membership_title?: string;
  summary: {
    pressure_5h?: AccountUsageSummaryPressure;
    pressure_7d?: AccountUsageSummaryPressure;
    storage?: AccountUsageSummaryPressure;
    live_capacity?: AccountUsageSummaryPressure;
  };
  meters: AccountUsageMeter[];
  recent_events: {
    managed_egress?: ManagedEgressEventSummary[];
    managed_cpu?: ManagedCpuEventSummary[];
  };
  measurement_warnings: string[];
}

export interface Purchases {
  getBalance: (opts?: { account_id?: string }) => Promise<MoneyValue>;
  getMinBalance: (opts?: { account_id?: string }) => Promise<MoneyValue>;
  getMembership: (opts?: {
    account_id?: string;
  }) => Promise<MembershipResolution>;
  getMembershipDetails: (opts?: {
    account_id?: string;
    user_account_id?: string;
    refresh_usage_status?: boolean;
  }) => Promise<MembershipDetails>;
  getMembershipPackageQuote: (opts?: {
    account_id?: string;
    package_id?: string;
    kind?: MembershipPackageKind;
    membership_class?: MembershipClass;
    seat_count?: number;
    interval?: "month" | "year";
    course_project_id?: string;
    starts_at?: Date | string;
    expires_at?: Date | string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<MembershipPackageQuote>;
  purchaseMembershipPackage: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
    kind?: MembershipPackageKind;
    membership_class?: MembershipClass;
    seat_count?: number;
    interval?: "month" | "year";
    course_project_id?: string;
    starts_at?: Date | string;
    expires_at?: Date | string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<{ package_id: string; purchase_id: number }>;
  purchaseMembershipPackages: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    products?: {
      type: "membership-package";
      package_id?: string;
      kind: MembershipPackageKind;
      membership_class: MembershipClass;
      seat_count: number;
      interval?: "month" | "year";
      course_project_id?: string;
      starts_at?: Date | string;
      expires_at?: Date | string;
      metadata?: Record<string, unknown> | null;
    }[];
  }) => Promise<{ package_id: string; purchase_id: number }[]>;
  getTeamLicense: (opts?: {
    account_id?: string;
  }) => Promise<TeamLicenseOverview | null>;
  getTeamLicenseQuote: (opts?: {
    account_id?: string;
    target_seats?: Record<string, number>;
  }) => Promise<TeamLicenseQuote>;
  purchaseTeamLicenseChange: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    target_seats?: Record<string, number>;
  }) => Promise<TeamLicenseOverview>;
  updateMembershipPackage: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
    owner_account_id?: string;
    site_license_id?: string;
    pool_name?: string;
    seat_count?: number;
    pool_description?: string | null;
    requires_approval?: boolean;
    affiliation_reverification_days?: number | null;
    affiliation_reverification_grace_days?: number | null;
    expires_at?: Date | string | null;
    allowed_domains?: string[];
  }) => Promise<MembershipPackageDetails>;
  getMembershipPackages: (opts?: {
    account_id?: string;
    user_account_id?: string;
  }) => Promise<MembershipPackageDetails[]>;
  assignMembershipPackageSeat: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
    target_account_id?: string;
    target_email_address?: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<MembershipPackageAssignment>;
  revokeMembershipPackageSeat: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
    target_account_id?: string;
    target_email_address?: string;
  }) => Promise<{ revoked: boolean }>;
  assignSiteLicensePoolSeat: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
    target_account_id?: string;
    grant_expires_at?: Date | string | null;
  }) => Promise<MembershipPackageAssignment>;
  getClaimableMembershipPackages: (opts?: {
    account_id?: string;
    include_claimed_site_license_pools?: boolean;
  }) => Promise<ClaimableMembershipPackage[]>;
  claimMembershipPackageSeat: (opts?: {
    account_id?: string;
    package_id?: string;
    accepted_terms?: boolean;
  }) => Promise<MembershipPackageAssignment>;
  adminProvisionSiteLicense: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    owner_account_id?: string;
    name?: string;
    organization_name?: string;
    allowed_domains?: string[];
    pools?: SiteLicensePoolConfig[];
    custom_terms_url?: string | null;
    custom_policy_url?: string | null;
    terms_version_label?: string | null;
    renewal_policy?: string | null;
    overage_policy?: string | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<SiteLicenseOverview>;
  listSiteLicenseOverviews: (opts?: {
    account_id?: string;
    admin?: boolean;
  }) => Promise<SiteLicenseOverview[]>;
  getSiteLicenseOverview: (opts?: {
    account_id?: string;
    owner_account_id?: string;
    site_license_id?: string;
  }) => Promise<SiteLicenseOverview>;
  updateSiteLicense: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    site_license_id?: string;
    name?: string;
    organization_name?: string;
    allowed_domains?: string[];
    custom_terms_url?: string | null;
    custom_policy_url?: string | null;
    terms_version_label?: string | null;
    renewal_policy?: string | null;
    overage_policy?: string | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
  }) => Promise<SiteLicenseOverview>;
  addSiteLicensePool: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    site_license_id?: string;
    pool?: SiteLicensePoolConfig;
  }) => Promise<SiteLicenseOverview>;
  createSiteLicenseExternalClaimPool: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    site_license_id?: string;
    package_id?: string;
    name?: string;
    issuer?: string;
    slug?: string | null;
    audience?: string;
    default_membership_class?: MembershipClass | null;
    allow_membership_class_override?: boolean;
    default_membership_duration_days?: number | null;
    default_membership_expires_at?: Date | string | null;
    allow_membership_expires_at_override?: boolean;
    min_membership_duration_days?: number | null;
    max_membership_duration_days?: number | null;
    max_membership_expires_at?: Date | string | null;
    default_rootfs_id?: string | null;
    max_claims?: number | null;
    max_claims_per_account?: number | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    disabled_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<SiteLicenseExternalClaimPool>;
  addSiteLicenseExternalClaimKey: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    pool_id?: string;
    kid?: string;
    alg?: SiteLicenseExternalClaimSigningAlgorithm;
    public_key_jwk?: Record<string, unknown> | null;
    public_key_pem?: string | null;
    starts_at?: Date | string | null;
    expires_at?: Date | string | null;
    revoked_at?: Date | string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<SiteLicenseExternalClaimKey>;
  listSiteLicenseExternalClaimPools: (opts?: {
    account_id?: string;
    site_license_id?: string;
    package_id?: string;
    pool_id?: string;
    limit?: number;
  }) => Promise<SiteLicenseExternalClaimPool[]>;
  disableSiteLicenseExternalClaimPool: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    pool_id?: string;
    disabled_at?: Date | string | null;
  }) => Promise<SiteLicenseExternalClaimPool>;
  listSiteLicenseExternalClaimKeys: (opts?: {
    account_id?: string;
    pool_id?: string;
    kid?: string;
    limit?: number;
  }) => Promise<SiteLicenseExternalClaimKey[]>;
  revokeSiteLicenseExternalClaimKey: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    pool_id?: string;
    kid?: string;
    revoked_at?: Date | string | null;
  }) => Promise<SiteLicenseExternalClaimKey>;
  listSiteLicenseExternalClaimConsumptions: (opts?: {
    account_id?: string;
    pool_id?: string;
    site_license_id?: string;
    target_account_id?: string;
    status?: SiteLicenseExternalClaimConsumptionStatus;
    limit?: number;
  }) => Promise<SiteLicenseExternalClaimConsumption[]>;
  consumeSiteLicenseExternalClaimToken: (opts?: {
    account_id?: string;
    token?: string;
  }) => Promise<SiteLicenseExternalClaimConsumption>;
  archiveSiteLicensePool: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    package_id?: string;
  }) => Promise<SiteLicenseOverview>;
  setSiteLicenseManager: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    site_license_id?: string;
    target_account_id?: string;
    role?: SiteLicenseManagerRole;
  }) => Promise<SiteLicenseOverview>;
  removeSiteLicenseManager: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    site_license_id?: string;
    target_account_id?: string;
  }) => Promise<SiteLicenseOverview>;
  requestSiteLicensePool: (opts?: {
    account_id?: string;
    owner_account_id?: string;
    package_id?: string;
    requester_note?: string | null;
    accepted_terms?: boolean;
  }) => Promise<SiteLicensePoolRequest>;
  cancelSiteLicensePoolRequest: (opts?: {
    account_id?: string;
    request_id?: string;
  }) => Promise<SiteLicensePoolRequest>;
  releaseSiteLicensePoolSeat: (opts?: {
    account_id?: string;
    package_id?: string;
  }) => Promise<{ revoked: boolean }>;
  reviewSiteLicensePoolRequest: (opts?: {
    account_id?: string;
    browser_id?: string;
    session_hash?: string | null;
    owner_account_id?: string;
    request_id?: string;
    action?: "approve" | "reject";
    review_note?: string | null;
  }) => Promise<SiteLicensePoolRequest>;
  getSiteLicenseAffiliationReverificationStatus: (opts?: {
    account_id?: string;
  }) => Promise<SiteLicenseAffiliationReverificationUserStatus>;
  refreshSiteLicenseAffiliationVerification: (opts?: {
    account_id?: string;
    site_license_id?: string;
  }) => Promise<SiteLicenseAffiliationReverificationSeat[]>;
  getAIUsage: (opts?: { account_id?: string }) => Promise<AIUsageStatus>;
  getAccountUsageOverview: (opts?: {
    account_id?: string;
    user_account_id?: string;
  }) => Promise<AccountUsageOverview>;
  getManagedEgressHistory: (
    opts?: ManagedEgressHistoryQuery,
  ) => Promise<ManagedEgressHistory>;
  getManagedEgressAdminOverview: (
    opts?: ManagedEgressAdminOverviewQuery,
  ) => Promise<ManagedEgressAdminOverview>;
  getManagedEgressAdminHistory: (
    opts?: ManagedEgressAdminHistoryQuery,
  ) => Promise<ManagedEgressAdminHistory>;
  getManagedCpuAdminOverview: (
    opts?: ManagedCpuAdminOverviewQuery,
  ) => Promise<ManagedCpuAdminOverview>;
  getManagedCpuAdminHistory: (
    opts?: ManagedCpuAdminHistoryQuery,
  ) => Promise<ManagedCpuAdminHistory>;
  createAbuseReviewAnnotation: (
    opts?: CreateAbuseReviewAnnotationQuery,
  ) => Promise<AbuseReviewAnnotation>;
  listAbuseReviewAnnotations: (
    opts?: ListAbuseReviewAnnotationsQuery,
  ) => Promise<AbuseReviewAnnotation[]>;
  revokeAbuseReviewAnnotation: (
    opts?: RevokeAbuseReviewAnnotationQuery,
  ) => Promise<AbuseReviewAnnotation>;
  adminResetMembershipUsageWindows: (
    opts?: AdminResetMembershipUsageWindowsQuery,
  ) => Promise<AdminResetMembershipUsageWindowsResult>;
}

export const purchases = {
  getBalance: authFirst,
  getMinBalance: authFirst,
  getMembership: authFirst,
  getMembershipDetails: authFirst,
  getMembershipPackageQuote: authFirst,
  purchaseMembershipPackage: authFirst,
  purchaseMembershipPackages: authFirst,
  getTeamLicense: authFirst,
  getTeamLicenseQuote: authFirst,
  purchaseTeamLicenseChange: authFirst,
  updateMembershipPackage: authFirst,
  getMembershipPackages: authFirst,
  assignMembershipPackageSeat: authFirst,
  revokeMembershipPackageSeat: authFirst,
  assignSiteLicensePoolSeat: authFirst,
  getClaimableMembershipPackages: authFirst,
  claimMembershipPackageSeat: authFirst,
  adminProvisionSiteLicense: authFirst,
  listSiteLicenseOverviews: authFirst,
  getSiteLicenseOverview: authFirst,
  updateSiteLicense: authFirst,
  addSiteLicensePool: authFirst,
  createSiteLicenseExternalClaimPool: authFirst,
  addSiteLicenseExternalClaimKey: authFirst,
  listSiteLicenseExternalClaimPools: authFirst,
  disableSiteLicenseExternalClaimPool: authFirst,
  listSiteLicenseExternalClaimKeys: authFirst,
  revokeSiteLicenseExternalClaimKey: authFirst,
  listSiteLicenseExternalClaimConsumptions: authFirst,
  consumeSiteLicenseExternalClaimToken: authFirst,
  archiveSiteLicensePool: authFirst,
  setSiteLicenseManager: authFirst,
  removeSiteLicenseManager: authFirst,
  requestSiteLicensePool: authFirst,
  cancelSiteLicensePoolRequest: authFirst,
  releaseSiteLicensePoolSeat: authFirst,
  reviewSiteLicensePoolRequest: authFirst,
  getSiteLicenseAffiliationReverificationStatus: authFirst,
  refreshSiteLicenseAffiliationVerification: authFirst,
  getAIUsage: authFirst,
  getAccountUsageOverview: authFirst,
  getManagedEgressHistory: authFirst,
  getManagedEgressAdminOverview: authFirst,
  getManagedEgressAdminHistory: authFirst,
  getManagedCpuAdminOverview: authFirst,
  getManagedCpuAdminHistory: authFirst,
  createAbuseReviewAnnotation: authFirst,
  listAbuseReviewAnnotations: authFirst,
  revokeAbuseReviewAnnotation: authFirst,
  adminResetMembershipUsageWindows: authFirst,
};
