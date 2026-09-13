/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { PoolClient } from "@cocalc/database/pool";
import type { VmPersonalFundingTerms } from "@cocalc/util/compute-vm-funding";
import {
  fundingAmount,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";

export type PersonalVmApprovalTerms = VmPersonalFundingTerms & {
  kind: "personalVMfallback";
};

/** Resolved by the VM authority, never accepted from the browser proposal. */
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

export interface VmPersonalFundingApprovalHandler {
  resolveReview(opts: {
    payer_account_id: string;
    terms: VmPersonalFundingTerms;
  }): Promise<PersonalVmApprovalReview>;
  /** Recheck owner, generation, funding epoch, cap and deadlines under the core
   * locks. Create consent plus receipt/outbox using this transaction only. */
  apply(opts: {
    db: PoolClient;
    payer_account_id: string;
    operation_id: string;
    intent_id: string;
    terms: VmPersonalFundingTerms;
    review: PersonalVmApprovalReview;
  }): Promise<{ consent_id: string }>;
}

let handler: VmPersonalFundingApprovalHandler | undefined;

/** Call once per API/listener process during VM service initialization. */
export function registerVmPersonalFundingApprovalHandler(
  value: VmPersonalFundingApprovalHandler,
): () => void {
  if (handler)
    throw new Error("Personal VM approval handler already registered");
  handler = value;
  return () => {
    if (handler === value) handler = undefined;
  };
}

export function getVmPersonalFundingApprovalHandler(): VmPersonalFundingApprovalHandler {
  if (!handler)
    throw new Error("Trusted personal VM funding approval is not configured");
  return handler;
}

export function normalizePersonalVmApprovalTerms(
  input: PersonalVmApprovalTerms,
): PersonalVmApprovalTerms {
  if (
    input.kind !== "personalVMfallback" ||
    !["prepaid", "postpaid"].includes(input.lane) ||
    !["immediate", "fallback"].includes(input.activation) ||
    typeof input.expected_funding_version !== "string" ||
    !input.expected_funding_version.trim() ||
    input.expected_funding_version.length > 512 ||
    !Array.isArray(input.home_volume_ids) ||
    input.home_volume_ids.length > 100 ||
    !Array.isArray(input.fallback_reasons) ||
    input.fallback_reasons.length > 2 ||
    input.fallback_reasons.some(
      (r) => r !== "course_exhausted" && r !== "course_expired",
    ) ||
    (input.activation === "fallback"
      ? input.fallback_reasons.length === 0
      : input.fallback_reasons.length !== 0)
  ) {
    throw new Error("Invalid personal VM funding terms");
  }
  return {
    kind: "personalVMfallback",
    vm_id: fundingId(input.vm_id, "VM"),
    expected_funding_version: input.expected_funding_version,
    home_volume_ids: [
      ...new Set(
        input.home_volume_ids.map((id) => fundingId(id, "Home volume")),
      ),
    ].sort(),
    lane: input.lane,
    cap_usd: fundingAmount(input.cap_usd, { positive: true, cents: true }),
    ends_at: fundingDate(input.ends_at),
    activation: input.activation,
    fallback_reasons: [...new Set(input.fallback_reasons)].sort(),
  };
}

export function validatePersonalVmApprovalReview(
  payer: string,
  terms: PersonalVmApprovalTerms,
  review: PersonalVmApprovalReview,
): PersonalVmApprovalReview {
  if (
    review.vm_id !== terms.vm_id ||
    review.owner_account_id !== payer ||
    !review.vm_name?.trim() ||
    !review.owning_bay_id?.trim() ||
    !Number.isSafeInteger(review.resource_generation) ||
    review.resource_generation < 0 ||
    !review.funding_epoch?.trim() ||
    !Array.isArray(review.home_volumes) ||
    review.home_volumes.length !== terms.home_volume_ids.length ||
    new Set(review.home_volumes.map((v) => v.id)).size !==
      review.home_volumes.length ||
    review.home_volumes.some(
      (v) => !terms.home_volume_ids.includes(v.id) || !v.name?.trim(),
    )
  ) {
    throw new Error("Personal VM identity or funding binding unavailable");
  }
  fundingAmount(review.hourly_usd);
  fundingAmount(review.protected_storage_usd);
  fundingAmount(review.egress_cap_usd);
  fundingDate(review.storage_delete_at);
  review.home_volumes.forEach((v) => {
    if (
      v.funding_action != null &&
      !["switch", "preserve"].includes(v.funding_action)
    )
      throw new Error("Invalid home-volume funding action");
    if (v.funding_action === "preserve") {
      if (
        !["account-prepaid", "account-postpaid"].includes(v.funding_mode ?? "")
      )
        throw new Error("Independent personal storage funding unavailable");
      if (v.storage_delete_at != null) fundingDate(v.storage_delete_at);
    } else fundingDate(v.storage_delete_at!);
    fundingAmount(v.hourly_usd);
    if (v.funding_epoch != null || v.funding_action !== "preserve")
      fundingId(v.funding_epoch!, "Volume funding epoch");
    if (
      ((v.resource_generation != null || v.funding_action !== "preserve") &&
        (!Number.isSafeInteger(v.resource_generation) ||
          v.resource_generation! < 1)) ||
      !Number.isSafeInteger(v.attachment_generation) ||
      v.attachment_generation < 0 ||
      !Number.isSafeInteger(v.size_gb) ||
      v.size_gb < 1
    )
      throw new Error("Personal volume identity or size unavailable");
  });
  return review;
}
