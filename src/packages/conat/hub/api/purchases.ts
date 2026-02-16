import { authFirst } from "./util";
import type { MoneyValue } from "@cocalc/util/money";
export type MembershipClass = string;

export interface MembershipEntitlements {
  project_defaults?: Record<string, unknown>;
  llm_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
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
  getMembership: (opts?: { account_id?: string }) => Promise<MembershipResolution>;
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
