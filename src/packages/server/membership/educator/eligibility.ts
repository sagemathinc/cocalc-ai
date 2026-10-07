/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import type { PoolClient } from "@cocalc/database/pool";
import { getVerifiedSeatAccountEmails } from "@cocalc/server/membership/packages";
import {
  type EducatorEligibility,
  evaluateEducatorEligibility,
  parseEducatorEmailRules,
} from "@cocalc/util/accounts/educator-email-policy";

import { getAcademicDomainStatusFn } from "./academic-domains";

/** Whether an account may buy tiers marked "available for instructor purchase". */
export async function getEducatorEligibility({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<EducatorEligibility> {
  const [verifiedEmails, settings, academicStatus] = await Promise.all([
    getVerifiedSeatAccountEmails({ account_id, client }),
    getServerSettings(),
    getAcademicDomainStatusFn(),
  ]);
  return evaluateEducatorEligibility({
    verifiedEmails,
    allow: parseEducatorEmailRules(settings.educator_email_allow_list),
    deny: parseEducatorEmailRules(settings.educator_email_deny_list),
    academicStatus,
  });
}

export function educatorEligibilityMessage(
  eligibility: EducatorEligibility,
): string {
  switch (eligibility.reason) {
    case "no_verified_email":
      return "Verify your email address to buy educational memberships.";
    case "denied":
      return "This email address is not eligible for educational memberships.";
    case "abused_domain":
    case "not_academic":
      return "Educational memberships require a verified email address at a recognized academic institution. Contact support to request manual approval.";
    default:
      return "";
  }
}

export async function assertEducatorEligible({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<EducatorEligibility> {
  const eligibility = await getEducatorEligibility({ account_id, client });
  if (!eligibility.eligible) {
    throw Error(educatorEligibilityMessage(eligibility));
  }
  return eligibility;
}
