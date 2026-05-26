/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  emailAllowedByPublicSignupPolicy,
  evaluateSignupEmailDomainPolicy,
  publicSignupEmailDomainPolicy,
} from "./signup-email-domain-policy";

describe("signup email domain policy", () => {
  it("allows all domains by default", () => {
    expect(
      evaluateSignupEmailDomainPolicy({
        email_address: "user@example.com",
        settings: {},
      }),
    ).toEqual({ allowed: true });
  });

  it("enforces allow-list mode and supports explicit subdomain rules", () => {
    const settings = {
      signup_email_domain_policy_mode: "allow_only",
      signup_email_domain_allow_list: "example.edu *.school.edu",
      signup_email_domain_show_allowed_domains: "yes",
    };

    expect(
      evaluateSignupEmailDomainPolicy({
        email_address: "ada@example.edu",
        settings,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateSignupEmailDomainPolicy({
        email_address: "ada@lab.school.edu",
        settings,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateSignupEmailDomainPolicy({
        email_address: "ada@other.edu",
        settings,
      }),
    ).toMatchObject({
      allowed: false,
      mode: "allow_only",
      publicDetailsAllowed: true,
    });
  });

  it("does not disclose deny-listed domains unless an admin configures a public message", () => {
    expect(
      publicSignupEmailDomainPolicy({
        signup_email_domain_policy_mode: "deny_list",
        signup_email_domain_deny_list: "darkweb.example",
      }),
    ).toEqual({ mode: "deny_list" });

    expect(
      evaluateSignupEmailDomainPolicy({
        email_address: "abuse@darkweb.example",
        settings: {
          signup_email_domain_policy_mode: "deny_list",
          signup_email_domain_deny_list: "darkweb.example",
        },
      }),
    ).toMatchObject({
      allowed: false,
      mode: "deny_list",
      publicDetailsAllowed: false,
    });
  });

  it("can validate visible allow-list policies in the browser", () => {
    const policy = publicSignupEmailDomainPolicy({
      signup_email_domain_policy_mode: "allow_only",
      signup_email_domain_allow_list: "gmail.com *.example.edu",
      signup_email_domain_show_allowed_domains: true,
    });

    expect(
      emailAllowedByPublicSignupPolicy({
        email_address: "user@gmail.com",
        policy,
      }),
    ).toBe(true);
    expect(
      emailAllowedByPublicSignupPolicy({
        email_address: "user@lab.example.edu",
        policy,
      }),
    ).toBe(true);
    expect(
      emailAllowedByPublicSignupPolicy({
        email_address: "user@yahoo.com",
        policy,
      }),
    ).toBe(false);
  });
});
