/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
Who may buy membership tiers marked "available for instructor purchase"
(educational offers). An account qualifies through one of its verified email
addresses:

1. the admin deny list (exact address or domain) always wins;
2. the admin allow list (exact address or domain) qualifies, which is also how
   support approves an individual educator by hand;
3. otherwise the address must be on a recognized academic domain.
*/

import {
  type DomainRule,
  domainMatchesRules,
  extractEmailDomain,
  parseDomainRules,
} from "./signup-email-domain-policy";

// These lists can contain individual email addresses, so they are never part
// of the public site customization data.
export const EDUCATOR_EMAIL_POLICY_SETTING_KEYS = new Set([
  "educator_email_allow_list",
  "educator_email_deny_list",
]);

export interface EducatorEmailRules {
  addresses: Set<string>;
  domains: DomainRule[];
}

export type EducatorEligibilityReason =
  | "allowed_address"
  | "allowed_domain"
  | "academic_domain"
  | "denied"
  | "abused_domain"
  | "not_academic"
  | "no_verified_email";

export interface EducatorEligibility {
  eligible: boolean;
  reason: EducatorEligibilityReason;
  /** The verified address that decided the result, if any. */
  email_address?: string;
}

export type AcademicDomainStatus = "academic" | "abused" | "not_academic";

/** Parse a comma/whitespace/newline list of addresses and domains. */
export function parseEducatorEmailRules(value: unknown): EducatorEmailRules {
  const raw =
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? value
      : `${typeof value === "string" ? value : ""}`.split(/[\s,;]+/);
  const addresses = new Set<string>();
  const domainEntries: string[] = [];
  for (const entry of raw) {
    const token = `${entry ?? ""}`.trim().toLowerCase();
    if (!token) continue;
    const at = token.indexOf("@");
    if (at > 0) {
      addresses.add(token);
    } else {
      domainEntries.push(token);
    }
  }
  return { addresses, domains: parseDomainRules(domainEntries) };
}

function matches(
  email: string,
  rules: EducatorEmailRules,
): "address" | "domain" | undefined {
  if (rules.addresses.has(email)) return "address";
  if (domainMatchesRules(extractEmailDomain(email), rules.domains)) {
    return "domain";
  }
  return undefined;
}

export function evaluateEducatorEligibility({
  verifiedEmails,
  allow,
  deny,
  academicStatus,
}: {
  verifiedEmails: readonly string[];
  allow: EducatorEmailRules;
  deny: EducatorEmailRules;
  academicStatus: (domain: string) => AcademicDomainStatus;
}): EducatorEligibility {
  const emails = Array.from(
    new Set(
      verifiedEmails
        .map((email) => `${email ?? ""}`.trim().toLowerCase())
        .filter((email) => email.includes("@")),
    ),
  );
  if (emails.length === 0) {
    return { eligible: false, reason: "no_verified_email" };
  }
  let fallback: EducatorEligibility | undefined;
  for (const email of emails) {
    if (matches(email, deny)) {
      fallback ??= { eligible: false, reason: "denied", email_address: email };
      continue;
    }
    const allowed = matches(email, allow);
    if (allowed) {
      return {
        eligible: true,
        reason: allowed === "address" ? "allowed_address" : "allowed_domain",
        email_address: email,
      };
    }
    const status = academicStatus(extractEmailDomain(email));
    if (status === "academic") {
      return {
        eligible: true,
        reason: "academic_domain",
        email_address: email,
      };
    }
    if (status === "abused") {
      fallback ??= {
        eligible: false,
        reason: "abused_domain",
        email_address: email,
      };
    }
  }
  return (
    fallback ?? {
      eligible: false,
      reason: "not_academic",
      email_address: emails[0],
    }
  );
}
