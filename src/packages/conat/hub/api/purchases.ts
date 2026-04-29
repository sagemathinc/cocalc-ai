import { authFirst } from "./util";
import type { MoneyValue } from "@cocalc/util/money";
export type MembershipClass = string;

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
}

export interface MembershipEffectiveLimits extends MembershipUsageLimits {}

export interface MembershipEntitlements {
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: MembershipUsageLimits;
}

export interface MembershipResolution {
  class: MembershipClass;
  source: "subscription" | "admin" | "free";
  entitlements: MembershipEntitlements;
  effective_limits?: MembershipEffectiveLimits;
  subscription_id?: number;
  expires?: Date;
}

export interface MembershipCandidate {
  class: MembershipClass;
  source: "subscription" | "admin";
  priority: number;
  entitlements: MembershipEntitlements;
  effective_limits?: MembershipEffectiveLimits;
  subscription_id?: number;
  expires?: Date;
}

export interface MembershipDetails {
  selected: MembershipResolution;
  candidates: MembershipCandidate[];
  usage_status?: MembershipUsageStatus;
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
  }) => Promise<MembershipDetails>;
  getAIUsage: (opts?: { account_id?: string }) => Promise<AIUsageStatus>;
  getManagedEgressHistory: (
    opts?: ManagedEgressHistoryQuery,
  ) => Promise<ManagedEgressHistory>;
}

export const purchases = {
  getBalance: authFirst,
  getMinBalance: authFirst,
  getMembership: authFirst,
  getMembershipDetails: authFirst,
  getAIUsage: authFirst,
  getManagedEgressHistory: authFirst,
};
