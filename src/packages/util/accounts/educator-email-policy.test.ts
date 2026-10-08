/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  type AcademicDomainStatus,
  EDUCATOR_EMAIL_POLICY_SETTING_KEYS,
  evaluateEducatorEligibility,
  parseEducatorEmailRules,
} from "./educator-email-policy";
import { buildPublicSiteSettings } from "../db-schema/site-settings-public";

const academic = (domain: string): AcademicDomainStatus =>
  domain.endsWith("ucla.edu")
    ? "academic"
    : domain === "alumni.example.edu"
      ? "abused"
      : "not_academic";

function evaluate(verifiedEmails: string[], allow = "", deny = "") {
  return evaluateEducatorEligibility({
    verifiedEmails,
    allow: parseEducatorEmailRules(allow),
    deny: parseEducatorEmailRules(deny),
    academicStatus: academic,
  });
}

describe("educator eligibility", () => {
  it("accepts verified addresses on academic domains", () => {
    expect(evaluate(["Prof@G.UCLA.edu"])).toEqual({
      eligible: true,
      reason: "academic_domain",
      email_address: "prof@g.ucla.edu",
    });
  });

  it("requires a verified email address", () => {
    expect(evaluate([])).toEqual({
      eligible: false,
      reason: "no_verified_email",
    });
  });

  it("rejects non-academic and abused domains", () => {
    expect(evaluate(["someone@gmail.com"])).toMatchObject({
      eligible: false,
      reason: "not_academic",
    });
    expect(evaluate(["grad@alumni.example.edu"])).toMatchObject({
      eligible: false,
      reason: "abused_domain",
    });
  });

  it("lets admins approve individual addresses and domains", () => {
    expect(evaluate(["teacher@gmail.com"], "teacher@gmail.com")).toMatchObject({
      eligible: true,
      reason: "allowed_address",
    });
    expect(
      evaluate(
        ["a@fh-example.de"],
        "other@x.org, *.fh-example.de fh-example.de",
      ),
    ).toMatchObject({ eligible: true, reason: "allowed_domain" });
  });

  it("gives the deny list precedence over academic and allowed rules", () => {
    expect(
      evaluate(["prof@ucla.edu"], "prof@ucla.edu", "ucla.edu"),
    ).toMatchObject({ eligible: false, reason: "denied" });
    expect(evaluate(["prof@ucla.edu"], "", "prof@ucla.edu")).toMatchObject({
      eligible: false,
      reason: "denied",
    });
  });

  it("denies the whole account if any verified address is denied", () => {
    expect(
      evaluate(["blocked@gmail.com", "prof@ucla.edu"], "", "blocked@gmail.com"),
    ).toMatchObject({
      eligible: false,
      reason: "denied",
      email_address: "blocked@gmail.com",
    });
    expect(
      evaluate(["prof@ucla.edu", "x@denied.org"], "x@denied.org", "denied.org"),
    ).toMatchObject({ eligible: false, reason: "denied" });
  });

  it("never exposes the allow and deny lists in public site settings", () => {
    const { configuration } = buildPublicSiteSettings({
      educator_email_allow_list: "secret-person@gmail.com",
      educator_email_deny_list: "blocked@example.edu",
      site_name: "Example",
    });
    for (const key of EDUCATOR_EMAIL_POLICY_SETTING_KEYS) {
      expect(configuration).not.toHaveProperty(key);
    }
    expect(configuration.site_name).toBe("Example");
  });
});
