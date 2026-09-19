/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  ComputeFundingGrantState,
  ComputeFundingLane,
  ComputeFundingPoolState,
  CourseFundingDraft,
  FundingBudget,
} from "@cocalc/util/compute-funding";
import { authFirstRequireAccount } from "./util";
import type {
  CourseVmRecommendations,
  CourseVmTemplate,
} from "@cocalc/util/course-vm-template";

export type { CourseFundingDraft } from "@cocalc/util/compute-funding";

// All money is decimal USD strings; all timestamps are ISO strings.
export interface CourseFundingRuntimeSummary {
  usage_as_of?: string;
  active_reservations?: number;
  // Latest trusted meter observation; omitted for stale/unknown runtime state.
  running_vms?: number;
  hourly_usd?: string;
  // Estimate at the observed rate, excluding new VMs and unmetered egress.
  // Estimated runtime headroom limit, capped by payer windows and source dates.
  // Excludes reserved egress/protected storage; absent when evidence is unknown.
  forecast_exhausts_at?: string;
}

export interface CourseFundingGrantSummary
  extends FundingBudget, CourseFundingRuntimeSummary {
  id: string;
  beneficiary_account_id: string;
  state: ComputeFundingGrantState;
  version?: number;
  starts_at?: string;
  ends_at?: string;
  // Omitted unless an authoritative runtime observation is available.
  running_vms?: number;
  hourly_usd?: string;
}

export interface CourseFundingPoolSummary extends FundingBudget {
  id: string;
  name?: string;
  state: ComputeFundingPoolState;
  lane: ComputeFundingLane;
  version?: number;
  allow_overcommit?: boolean;
  approval_limit_usd: string;
  approval_starts_at: string;
  approval_ends_at: string;
  // Separate approvals are exact rectangles; their amount/date axes must not
  // be combined. Missing on older hubs means use the legacy fields above.
  approval_rectangles?: Array<{
    amount_usd: string;
    starts_at: string;
    ends_at: string;
  }>;
  starts_at: string;
  ends_at: string;
  grants: CourseFundingGrantSummary[];
}

export interface CourseFundingSummary {
  as_of: string;
  pools: CourseFundingPoolSummary[];
  // Missing on old hubs means unavailable, never permission to create funding.
  sponsorship?: import("@cocalc/util/compute-funding-rollout").SponsorshipAvailability;
}

export interface CourseFundingOwnedPools extends Omit<
  CourseFundingSummary,
  "pools"
> {
  pools: (CourseFundingPoolSummary & CourseFundingCourseRequest)[];
}

export interface CourseFundingAllocationPreview {
  terms: CourseFundingDraft;
  available_backing_usd: string;
  recipients: Array<{
    beneficiary_account_id: string;
    display_name: string;
    email_address?: string;
  }>;
  as_of: string;
}

export interface CourseFundingAllocationStatus {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  approval_url?: string;
  pool_id?: string;
  expires_at?: string;
  completed_at?: string;
}

export interface CourseFundingSourceSummary
  extends FundingBudget, CourseFundingRuntimeSummary {
  pool_id: string;
  grant_id: string;
  payer_account_id: string;
  label: string;
  lane: ComputeFundingLane;
  starts_at: string;
  ends_at: string;
  state: ComputeFundingGrantState;
  pool_state: ComputeFundingPoolState;
  // Nonnegative minimum of pool and grant uncommitted remainders, not a guarantee.
  available_usd: string;
  // Snapshot eligibility only; resource admission rechecks actual priced backing.
  available_for_new_resources: boolean;
  // Project-owned recommendations, never payer authorization or an allowlist.
  recommended_vm_templates?: CourseVmTemplate[];
}

export interface CourseFundingSources {
  as_of: string;
  sources: CourseFundingSourceSummary[];
}

export interface CourseFundingCourseRequest {
  course_project_id: string;
  course_instance_id: string;
}

export interface CourseFundingGrantChange {
  grant_id: string;
  expected_version: number;
  action: "revise" | "revoke";
  // Lifetime usable ceiling (authorized minus irreversible releases), not a delta.
  amount_usd?: string;
  starts_at?: string;
  ends_at?: string;
}

export interface CourseFundingPoolChangeDraft extends CourseFundingCourseRequest {
  pool_id: string;
  expected_version: number;
  action: "revise" | "close";
  amount_usd?: string;
  starts_at?: string;
  ends_at?: string;
  grants?: CourseFundingGrantChange[];
}

export interface CourseFundingPoolChangePreview {
  terms: CourseFundingPoolChangeDraft;
  pool: CourseFundingPoolSummary;
  // True only when the aggregate payer mandate grows. Grant reallocations,
  // reductions, and closure remain inside the already approved envelope.
  requires_financial_approval: boolean;
  // Computed from locked stored terms, never supplied by the caller.
  requires_course_access: boolean;
  // Present when additional backing is needed; closure must work after policy loss.
  available_backing_usd?: string;
  as_of: string;
}

export interface CourseFundingAudit {
  payer_account_id: string;
  bay_id: string;
  as_of: string;
  scope: string;
  backing: Array<{ lane: string; held_usd: string }>;
  findings: Array<{ code: string; resource_id: string; message: string }>;
  reservations: Array<{
    id: string;
    resource_id: string;
    resource_kind: string;
    resource_generation: number;
    pool_id: string | null;
    grant_id: string | null;
    state: string;
    authorized_usd: string;
    spent_usd: string;
    released_usd: string;
    protected_usd: string;
    authorized_until: string;
    updated_at: string;
  }>;
  truncated: boolean;
}

export interface ComputeFundingApi {
  getOwnedPools: () => Promise<CourseFundingOwnedPools>;
  audit: (opts: {
    payer_account_id: string;
    bay_id: string;
  }) => Promise<CourseFundingAudit>;
  getCourseVmRecommendations: (
    opts: CourseFundingCourseRequest,
  ) => Promise<CourseVmRecommendations>;
  setCourseVmRecommendations: (
    opts: CourseFundingCourseRequest & {
      templates: CourseVmTemplate[];
      expected_version: number;
    },
  ) => Promise<CourseVmRecommendations>;
  previewPoolChange: (opts: {
    terms: CourseFundingPoolChangeDraft;
  }) => Promise<CourseFundingPoolChangePreview>;
  proposePoolChange: (opts: {
    operation_id: string;
    terms: CourseFundingPoolChangeDraft;
  }) => Promise<CourseFundingAllocationStatus>;
  getCourseSummary: (
    opts: CourseFundingCourseRequest,
  ) => Promise<CourseFundingSummary>;
  listSources: (opts?: {
    include_inactive?: boolean;
  }) => Promise<CourseFundingSources>;
  previewAllocation: (opts: {
    terms: CourseFundingDraft;
  }) => Promise<CourseFundingAllocationPreview>;
  proposeAllocation: (opts: {
    operation_id: string;
    terms: CourseFundingDraft;
  }) => Promise<CourseFundingAllocationStatus>;
  getAllocationStatus: (opts: {
    intent_id: string;
  }) => Promise<CourseFundingAllocationStatus>;
}

export const computeFunding = {
  getOwnedPools: authFirstRequireAccount,
  audit: authFirstRequireAccount,
  getCourseVmRecommendations: authFirstRequireAccount,
  setCourseVmRecommendations: authFirstRequireAccount,
  previewPoolChange: authFirstRequireAccount,
  proposePoolChange: authFirstRequireAccount,
  getCourseSummary: authFirstRequireAccount,
  listSources: authFirstRequireAccount,
  previewAllocation: authFirstRequireAccount,
  proposeAllocation: authFirstRequireAccount,
  getAllocationStatus: authFirstRequireAccount,
};
