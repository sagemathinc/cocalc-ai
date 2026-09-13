/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { VolumePersonalFundingTerms } from "@cocalc/util/compute-volume-personal-funding";
import {
  fundingAmount,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";

export type PersonalVolumeApprovalTerms = VolumePersonalFundingTerms & {
  kind: "personalVolumeFunding";
};

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
}

export function normalizePersonalVolumeApprovalTerms(
  input: PersonalVolumeApprovalTerms,
): PersonalVolumeApprovalTerms {
  if (
    input.kind !== "personalVolumeFunding" ||
    !["prepaid", "postpaid"].includes(input.lane)
  )
    throw Error("Invalid personal storage funding terms.");
  return {
    kind: "personalVolumeFunding",
    volume_id: fundingId(input.volume_id, "Volume"),
    expected_funding_version: fundingId(
      input.expected_funding_version,
      "Volume funding version",
    ),
    lane: input.lane,
    cap_usd: fundingAmount(input.cap_usd, { positive: true, cents: true }),
    ends_at: fundingDate(input.ends_at),
  };
}

export function validatePersonalVolumeApprovalReview(
  payer: string,
  terms: VolumePersonalFundingTerms,
  review: PersonalVolumeApprovalReview,
): PersonalVolumeApprovalReview {
  if (
    review.owner_account_id !== payer ||
    review.volume_id !== terms.volume_id ||
    review.funding_epoch !== terms.expected_funding_version ||
    !review.volume_name?.trim() ||
    !review.owning_bay_id?.trim() ||
    !Number.isSafeInteger(review.resource_generation) ||
    review.resource_generation < 1 ||
    !Number.isSafeInteger(review.attachment_generation) ||
    review.attachment_generation < 0 ||
    !Number.isSafeInteger(review.size_gb) ||
    review.size_gb < 1
  )
    throw Error("Personal storage identity or funding changed.");
  fundingAmount(review.hourly_usd, { positive: true });
  fundingAmount(review.protected_storage_usd);
  fundingDate(review.storage_delete_at);
  return review;
}
