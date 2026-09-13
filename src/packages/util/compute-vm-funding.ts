/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export interface CourseVmFundingSource {
  kind: "course";
  pool_id: string;
  grant_id: string;
  // Directory routing hint only. The payer-home pool is authoritative.
  payer_account_id?: string;
}

export type ComputeVmFundingSource =
  | CourseVmFundingSource
  | { kind: "personal"; consent_id: string };

export type VmPersonalFallbackReason = "course_exhausted" | "course_expired";

// Exact additional lifetime cap includes compute, egress and protected storage.
export interface VmPersonalFundingTerms {
  vm_id: string;
  expected_funding_version: string;
  home_volume_ids: string[];
  lane: "prepaid" | "postpaid";
  cap_usd: string;
  ends_at: string;
  activation: "immediate" | "fallback";
  fallback_reasons: VmPersonalFallbackReason[];
}

export interface VmPersonalFundingPreview {
  terms: VmPersonalFundingTerms;
  hourly_usd: string;
  protected_storage_usd: string;
  egress_cap_usd: string;
  available_usd: string;
  home_volumes?: {
    id: string;
    name: string;
    funding_action?: "switch" | "preserve";
    hourly_usd: string;
    storage_delete_at?: string;
  }[];
  as_of: string;
}

export interface VmPersonalFundingConsent {
  id: string;
  version: number;
  state:
    | "pending"
    | "approved"
    | "preparing"
    | "active"
    | "cancelled"
    | "expired"
    | "exhausted"
    | "rejected";
  terms: VmPersonalFundingTerms;
  spent_usd: string;
  committed_usd: string;
  remaining_usd: string;
  approval_url?: string;
  approval_expires_at?: string;
  activated_at?: string;
  as_of: string;
}

export interface VmPersonalFundingApi {
  previewVmPersonalFunding: (opts: {
    terms: VmPersonalFundingTerms;
  }) => Promise<VmPersonalFundingPreview>;
  proposeVmPersonalFunding: (opts: {
    operation_id: string;
    terms: VmPersonalFundingTerms;
  }) => Promise<VmPersonalFundingConsent>;
  getVmPersonalFunding: (opts: {
    vm_id: string;
  }) => Promise<VmPersonalFundingConsent | null>;
  clearVmPersonalFunding: (opts: {
    vm_id: string;
    consent_id: string;
    expected_version: number;
    operation_id: string;
  }) => Promise<VmPersonalFundingConsent>;
  switchVmPersonalFunding: (opts: {
    vm_id: string;
    consent_id: string;
    expected_version: number;
    expected_funding_version: string;
    operation_id: string;
  }) => Promise<VmPersonalFundingConsent>;
}

export interface ComputeVmFundingBinding {
  resource_kind?: "compute-vm" | "compute-volume";
  source: ComputeVmFundingSource;
  payer_account_id: string;
  payer_authority_epoch: string;
  reservation_id: string;
  funding_epoch: string;
  resource_id: string;
  resource_generation: number;
  owner_account_id: string;
  owning_bay_id: string;
  lane: "prepaid" | "postpaid";
  authorized_usd: string;
  protected_usd: string;
  egress_usd: string;
  authorized_until: string;
  stop_at: string;
  storage_delete_at: string;
}

// Internal bay-service contracts, never browser-supplied quotes or meter data.
export interface ReserveComputeVmFundingRequest {
  resource_kind?: "compute-vm" | "compute-volume";
  account_id: string;
  source: CourseVmFundingSource;
  resource_id: string;
  resource_generation: number;
  owner_account_id: string;
  owning_bay_id: string;
  funding_epoch: string;
  provider: "gcp" | "nebius";
  hourly_cost_usd: string;
  storage_hourly_cost_usd: string;
  pricing_snapshot: Record<string, unknown>;
  requested_until: string;
  /** User timers restrict service without reducing the minimum financial reserve. */
  requested_stop_at?: string;
  requested_delete_at?: string;
  previous_reservation_id?: string;
}

export interface CheckComputeVmFundingRequest {
  account_id: string;
  binding: ComputeVmFundingBinding;
  dispatch?: boolean;
  // Trusted owning-bay renewal request, capped by current payer windows.
  renew_until?: string;
}

export interface ComputeVmFallbackDecision {
  reason: VmPersonalFallbackReason | null;
  reservation_id: string;
  funding_epoch: string;
  resource_generation: number;
  as_of: string;
}

/** Trusted owning-bay recovery only; this lookup never authorizes new spend. */
export type LookupComputeVmFundingRequest = Pick<
  ReserveComputeVmFundingRequest,
  | "account_id"
  | "resource_kind"
  | "resource_id"
  | "resource_generation"
  | "owner_account_id"
  | "owning_bay_id"
  | "funding_epoch"
> & { source: ComputeVmFundingBinding["source"] };

export interface SettleComputeVmFundingRequest {
  account_id: string;
  binding: ComputeVmFundingBinding;
  // Persisted provider-generation observations; dispatch is not billable usage.
  running_started_at?: string | null;
  meter_as_of?: string;
  // Cumulative trusted meter for one run followed by stopped storage.
  running_until: string;
  stopped_until?: string;
  deleted?: boolean;
  public_egress_bytes?: number;
  egress_complete_through?: string;
  egress_finalized?: boolean;
  // A stopped resource's obligation was durably assumed by this successor.
  successor_reservation_id?: string;
  successor_binding?: ComputeVmFundingBinding;
  transferred_at?: string;
}

export interface ComputeVmFundingSettlement {
  charged_usd: string;
  authorized_usd: string;
  // Outstanding liability after charges and releases, not original authority.
  // Missing on older payer bays means unknown to the status projection.
  committed_usd?: string;
  overrun: boolean;
}

export interface ComputeVmFundingStatus {
  funding_version?: string;
  personal_consent?: VmPersonalFundingConsent;
  source: ComputeVmFundingSource;
  label: string;
  state: "pending" | "running" | "stopped" | "settling" | "closed";
  lane?: "prepaid" | "postpaid";
  committed_usd?: string;
  remaining_usd?: string;
  spent_usd: string;
  protected_storage_usd?: string;
  egress_cap_usd?: string;
  authorized_until?: string;
  stop_at?: string;
  storage_delete_at?: string;
  as_of: string;
}
