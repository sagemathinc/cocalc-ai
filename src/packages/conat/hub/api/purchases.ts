import { authFirst } from "./util";
import type { MoneyValue } from "@cocalc/util/money";
export type MembershipClass = string;
export type MembershipPackageKind = "course" | "team" | "domain" | "site";

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
  max_snapshots_per_project?: number;
  max_backups_per_project?: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  egress_policy?: MembershipEgressPolicy;
  dedicated_host_egress_policy?: DedicatedHostEgressPolicy;
  credit_spend_limit_5h_usd?: number;
  credit_spend_limit_7d_usd?: number;
  prepaid_host_usage_limit_5h_usd?: number;
  prepaid_host_usage_limit_7d_usd?: number;
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
  max_snapshots_per_project?: NumericLimitRule;
  max_backups_per_project?: NumericLimitRule;
  egress_5h_bytes?: NumericLimitRule;
  egress_7d_bytes?: NumericLimitRule;
  egress_policy?: EnumOverride<MembershipEgressPolicy>;
  dedicated_host_egress_policy?: EnumOverride<DedicatedHostEgressPolicy>;
  credit_spend_limit_5h_usd?: NumericLimitRule;
  credit_spend_limit_7d_usd?: NumericLimitRule;
  prepaid_host_usage_limit_5h_usd?: NumericLimitRule;
  prepaid_host_usage_limit_7d_usd?: NumericLimitRule;
}

export interface DedicatedHostPolicyOverrides {
  funding_mode?: EnumOverride<
    "account-prepaid" | "account-postpaid" | "site-funded"
  >;
  postpaid_unbilled_limit_usd?: NumericLimitRule;
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
  subscription_id?: number;
  grant_id?: string;
  grant_source?: string;
  grant_package_id?: string;
  grant_purchase_id?: number;
  expires?: Date;
}

export interface MembershipCandidate {
  class: MembershipClass;
  source: "subscription" | "admin" | "grant";
  priority: number;
  entitlements: MembershipEntitlements;
  effective_limits?: MembershipEffectiveLimits;
  subscription_id?: number;
  grant_id?: string;
  grant_source?: string;
  grant_package_id?: string;
  grant_purchase_id?: number;
  expires?: Date;
}

export interface MembershipDetails {
  selected: MembershipResolution;
  candidates: MembershipCandidate[];
  usage_status?: MembershipUsageStatus;
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
  assigned_by_account_id?: string | null;
  assigned_at?: Date;
  revoked_at?: Date | null;
  metadata?: Record<string, unknown> | null;
  grant_id?: string | null;
  grant_source?: string | null;
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
  managed_egress_5h_bytes?: number;
  managed_egress_7d_bytes?: number;
  managed_egress_5h_remaining_bytes?: number;
  managed_egress_7d_remaining_bytes?: number;
  managed_egress_5h_reset_at?: Date;
  managed_egress_7d_reset_at?: Date;
  managed_egress_5h_reset_in?: string;
  managed_egress_7d_reset_in?: string;
  over_managed_egress_5h?: boolean;
  over_managed_egress_7d?: boolean;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
  managed_egress_recent_events?: ManagedEgressEventSummary[];
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
  first_name?: string | null;
  last_name?: string | null;
  bytes: number;
}

export interface ManagedEgressAdminProjectSummary {
  account_id: string;
  email_address?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  project_id: string | null;
  project_title?: string | null;
  bytes: number;
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
  reset_at?: Date;
  reset_in?: string;
}

export interface AIUsageStatus {
  units_per_dollar: number;
  windows: AIUsageWindowStatus[];
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
  getMembershipPackages: (opts?: {
    account_id?: string;
    user_account_id?: string;
  }) => Promise<MembershipPackageDetails[]>;
  assignMembershipPackageSeat: (opts?: {
    account_id?: string;
    package_id?: string;
    target_account_id?: string;
    target_email_address?: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<MembershipPackageAssignment>;
  revokeMembershipPackageSeat: (opts?: {
    account_id?: string;
    package_id?: string;
    target_account_id?: string;
    target_email_address?: string;
  }) => Promise<{ revoked: boolean }>;
  getClaimableMembershipPackages: (opts?: {
    account_id?: string;
  }) => Promise<ClaimableMembershipPackage[]>;
  claimMembershipPackageSeat: (opts?: {
    account_id?: string;
    package_id?: string;
  }) => Promise<MembershipPackageAssignment>;
  getAIUsage: (opts?: { account_id?: string }) => Promise<AIUsageStatus>;
  getManagedEgressHistory: (
    opts?: ManagedEgressHistoryQuery,
  ) => Promise<ManagedEgressHistory>;
  getManagedEgressAdminOverview: (
    opts?: ManagedEgressAdminOverviewQuery,
  ) => Promise<ManagedEgressAdminOverview>;
  getManagedEgressAdminHistory: (
    opts?: ManagedEgressAdminHistoryQuery,
  ) => Promise<ManagedEgressAdminHistory>;
}

export const purchases = {
  getBalance: authFirst,
  getMinBalance: authFirst,
  getMembership: authFirst,
  getMembershipDetails: authFirst,
  getMembershipPackageQuote: authFirst,
  purchaseMembershipPackage: authFirst,
  getMembershipPackages: authFirst,
  assignMembershipPackageSeat: authFirst,
  revokeMembershipPackageSeat: authFirst,
  getClaimableMembershipPackages: authFirst,
  claimMembershipPackageSeat: authFirst,
  getAIUsage: authFirst,
  getManagedEgressHistory: authFirst,
  getManagedEgressAdminOverview: authFirst,
  getManagedEgressAdminHistory: authFirst,
};
