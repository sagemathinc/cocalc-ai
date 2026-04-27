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
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  egress_policy?: MembershipEgressPolicy;
  dedicated_host_egress_policy?: DedicatedHostEgressPolicy;
}

export interface MembershipEntitlements {
  project_defaults?: Record<string, unknown>;
  llm_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: MembershipUsageLimits;
}

export interface MembershipResolution {
  class: MembershipClass;
  source: "subscription" | "admin" | "free";
  entitlements: MembershipEntitlements;
  subscription_id?: number;
  expires?: Date;
}

export interface MembershipCandidate {
  class: MembershipClass;
  source: "subscription" | "admin";
  priority: number;
  entitlements: MembershipEntitlements;
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
  over_managed_egress_5h?: boolean;
  over_managed_egress_7d?: boolean;
  managed_egress_categories_5h_bytes?: Record<string, number>;
  managed_egress_categories_7d_bytes?: Record<string, number>;
  managed_egress_recent_events?: ManagedEgressEventSummary[];
}

export interface ManagedEgressEventSummary {
  account_id?: string;
  project_id: string;
  project_title?: string;
  category: string;
  bytes: number;
  occurred_at: string;
  metadata?: Record<string, unknown> | null;
}

export interface LLMUsageWindowStatus {
  window: "5h" | "7d";
  used: number;
  limit?: number;
  remaining?: number;
  reset_at?: Date;
  reset_in?: string;
}

export interface LLMUsageStatus {
  units_per_dollar: number;
  windows: LLMUsageWindowStatus[];
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
  getLLMUsage: (opts?: { account_id?: string }) => Promise<LLMUsageStatus>;
}

export const purchases = {
  getBalance: authFirst,
  getMinBalance: authFirst,
  getMembership: authFirst,
  getMembershipDetails: authFirst,
  getLLMUsage: authFirst,
};
