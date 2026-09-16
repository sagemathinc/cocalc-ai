/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { VmPersonalFundingConsent } from "./compute-vm-funding";

export interface VolumePersonalFundingTerms {
  volume_id: string;
  expected_funding_version: string;
  lane: "prepaid" | "postpaid";
  cap_usd: string;
  ends_at: string;
}

export interface VolumePersonalFundingPreview {
  terms: VolumePersonalFundingTerms;
  volume_name: string;
  size_gb: number;
  hourly_usd: string;
  protected_storage_usd: string;
  storage_delete_at: string;
  available_usd: string;
  as_of: string;
}

export interface VolumePersonalFundingConsent extends Omit<
  VmPersonalFundingConsent,
  "terms"
> {
  terms: VolumePersonalFundingTerms;
}

export interface VolumePersonalFundingApi {
  previewVolumePersonalFunding(opts: {
    terms: VolumePersonalFundingTerms;
  }): Promise<VolumePersonalFundingPreview>;
  proposeVolumePersonalFunding(opts: {
    operation_id: string;
    terms: VolumePersonalFundingTerms;
  }): Promise<VolumePersonalFundingConsent>;
  getVolumePersonalFunding(opts: {
    volume_id: string;
  }): Promise<VolumePersonalFundingConsent | null>;
  switchVolumePersonalFunding(opts: {
    volume_id: string;
    consent_id: string;
    expected_version: number;
    operation_id: string;
  }): Promise<VolumePersonalFundingConsent>;
  clearVolumePersonalFunding(opts: {
    volume_id: string;
    consent_id: string;
    expected_version: number;
    operation_id: string;
  }): Promise<VolumePersonalFundingConsent>;
}
