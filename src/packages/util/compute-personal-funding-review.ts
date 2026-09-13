/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { VmPersonalFundingTerms } from "./compute-vm-funding";
import type { VolumePersonalFundingTerms } from "./compute-volume-personal-funding";
import type { ComputeVmFundingBinding } from "./compute-vm-funding";
import type { VmPersonalFallbackReason } from "./compute-vm-funding";

/** Private owning-bay evidence. Browser proposals cannot supply these values. */
export interface PersonalVmApprovalReview {
  vm_id: string;
  vm_name: string;
  owner_account_id: string;
  owning_bay_id: string;
  resource_generation: number;
  funding_epoch: string;
  hourly_usd: string;
  protected_storage_usd: string;
  egress_cap_usd: string;
  storage_delete_at: string;
  provider?: "gcp" | "nebius";
  stopped_hourly_usd?: string;
  stop_generation?: number;
  stop_at?: string;
  expires_at?: string;
  home_volumes: {
    id: string;
    name: string;
    funding_action?: "switch" | "preserve";
    funding_mode?: string;
    funding_epoch?: string;
    resource_generation?: number;
    attachment_generation: number;
    size_gb: number;
    hourly_usd: string;
    storage_delete_at?: string;
  }[];
}

export interface PersonalVolumeApprovalReview {
  volume_id: string;
  volume_name: string;
  owner_account_id: string;
  owning_bay_id: string;
  funding_epoch: string;
  resource_generation: number;
  attachment_generation: number;
  size_gb: number;
  hourly_usd: string;
  protected_storage_usd: string;
  storage_delete_at: string;
  provider?: "gcp" | "nebius";
}

export interface ApplyPersonalVolumeHandoffRequest {
  account_id: string;
  operation_id: string;
  consent_id: string;
  terms: VolumePersonalFundingTerms;
  review: PersonalVolumeApprovalReview;
  binding: ComputeVmFundingBinding;
  abort?: boolean;
}

export interface PersonalVolumeHandoffReceipt {
  operation_id: string;
  reservation_id: string;
  outcome: "committed" | "aborted";
  as_of: string;
}

export interface PersonalVmHandoffIdentity {
  account_id: string;
  operation_id: string;
  consent_id: string;
  terms: VmPersonalFundingTerms;
  review: PersonalVmApprovalReview;
}

export type PersonalVmHandoffRequest = PersonalVmHandoffIdentity &
  (
    | { phase: "prepare" | "abort" }
    | {
        phase: "commit";
        binding: ComputeVmFundingBinding;
        home_binding?: ComputeVmFundingBinding;
      }
  );

export type PersonalVmHandoffResult =
  | { state: "waiting" }
  | {
      state: "ready";
      stopped_at: string;
      stop_generation: number;
      reason?: VmPersonalFallbackReason;
      as_of: string;
    }
  | {
      state: "committed" | "aborted";
      as_of: string;
      reservation_ids: string[];
    };

export interface PersonalVmRemoteHandoff {
  identity: PersonalVmHandoffIdentity;
  state: "pending" | "committed" | "aborted";
  binding?: ComputeVmFundingBinding;
  home_binding?: ComputeVmFundingBinding;
  receipt?: PersonalVmHandoffResult;
}

export type PersonalResourceReviewRequest = { account_id: string } & (
  | { kind: "vm"; terms: VmPersonalFundingTerms }
  | { kind: "volume"; terms: VolumePersonalFundingTerms }
);

export type PersonalResourceReview =
  | { kind: "vm"; review: PersonalVmApprovalReview }
  | { kind: "volume"; review: PersonalVolumeApprovalReview };
