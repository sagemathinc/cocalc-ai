/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { COURSE_COMPUTE_RETENTION_HOURS } from "@cocalc/util/compute-funding";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import type {
  CourseFundingPoolChangeDraft,
  CourseFundingPoolChangePreview,
} from "@cocalc/conat/hub/api/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { assertCourseAccess } from "./course-access";
import { assertSponsorshipAdmission } from "./rollout";
import { previewCourseFundingPoolChangeInTransaction } from "./pool-changes";
import {
  getVmPersonalFundingApprovalHandler,
  validatePersonalVmApprovalReview,
} from "./approval-personal";
import { resolveTransferApprovalReview } from "./approval-transfer";
import type {
  CreditTransferApprovalTerms,
  CreditTransferApprovalReview,
} from "./approval-transfer";
import type {
  PersonalVmApprovalTerms,
  PersonalVmApprovalReview,
} from "./approval-personal";

export type CourseFundingApprovalTerms =
  | CourseFundingDraft
  | CourseFundingPoolChangeDraft
  | PersonalVmApprovalTerms
  | CreditTransferApprovalTerms;

export interface FundingApprovalIdentity {
  account_id: string;
  name: string;
  email: string;
  home_bay_id: string;
}
export interface FundingApprovalReview {
  payer: FundingApprovalIdentity;
  recipients: FundingApprovalIdentity[];
  storage_retention_hours: number;
  pool_change?: CourseFundingPoolChangePreview;
  personal_vm_fallback?: PersonalVmApprovalReview;
  credit_transfer?: CreditTransferApprovalReview;
}

export async function resolveCourseFundingReview(
  payer: string,
  terms: CourseFundingApprovalTerms,
): Promise<FundingApprovalReview> {
  const transfer =
    "kind" in terms && terms.kind === "creditTransfer"
      ? await resolveTransferApprovalReview(payer, terms)
      : undefined;
  const personal =
    "kind" in terms && terms.kind === "personalVMfallback"
      ? validatePersonalVmApprovalReview(
          payer,
          terms,
          await getVmPersonalFundingApprovalHandler().resolveReview({
            payer_account_id: payer,
            terms,
          }),
        )
      : undefined;
  const poolChange =
    "action" in terms
      ? await withFundingAccountTransaction(payer, (db) =>
          previewCourseFundingPoolChangeInTransaction(db, {
            payer_account_id: payer,
            terms,
          }),
        )
      : undefined;
  if (
    !("kind" in terms) &&
    (!poolChange || poolChange.requires_course_access)
  ) {
    await assertCourseAccess(payer, terms.course_project_id);
    await assertSponsorshipAdmission();
  }
  const recipientIds =
    "kind" in terms && terms.kind === "creditTransfer"
      ? [terms.recipient.account_id]
      : personal
        ? []
        : poolChange
          ? poolChange.pool.grants.map((g) => g.beneficiary_account_id)
          : (terms as CourseFundingDraft).recipients.map(
              (r) => r.beneficiary_account_id,
            );
  const ids = [...new Set([payer, ...recipientIds])];
  const accounts = new Map(
    (await getClusterAccountsByIds(ids)).map((a) => [a.account_id, a]),
  );
  const identity = (id: string): FundingApprovalIdentity => {
    const account = accounts.get(id);
    if (account?.banned) throw new Error("A funding account is unavailable");
    const name =
      account?.display_name?.trim() ||
      [account?.first_name, account?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
    const email = account?.email_address?.trim();
    // Do not let a missing directory identity turn into approving opaque UUIDs.
    if (!email || !account?.home_bay_id)
      throw new Error("A funding account has no resolvable email identity");
    return {
      account_id: id,
      name: name || email,
      email,
      home_bay_id: account.home_bay_id,
    };
  };
  return {
    payer: identity(payer),
    recipients: recipientIds.map(identity),
    storage_retention_hours: COURSE_COMPUTE_RETENTION_HOURS,
    ...(poolChange ? { pool_change: poolChange } : {}),
    ...(personal ? { personal_vm_fallback: personal } : {}),
    ...(transfer ? { credit_transfer: transfer } : {}),
  };
}
