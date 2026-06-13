/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  domainMatchesRules,
  extractEmailDomain,
  parseDomainRules,
} from "./accounts/signup-email-domain-policy";

export interface CourseDomainRestrictedMembershipTier {
  course_allowed_domains?: readonly string[] | null;
}

export function normalizeMembershipTierCourseAllowedDomains(
  value: unknown,
): string[] {
  return parseDomainRules(value).map((rule) =>
    rule.includeSubdomains ? `*.${rule.domain}` : rule.domain,
  );
}

export function membershipTierVisibleForVerifiedInstructorEmail({
  emailAddress,
  emailVerified,
  tier,
}: {
  emailAddress?: string | null;
  emailVerified?: boolean;
  tier: CourseDomainRestrictedMembershipTier;
}): boolean {
  const rules = parseDomainRules(tier.course_allowed_domains);
  if (rules.length === 0) {
    return true;
  }
  if (!emailVerified || !emailAddress) {
    return false;
  }
  return domainMatchesRules(extractEmailDomain(emailAddress), rules);
}
