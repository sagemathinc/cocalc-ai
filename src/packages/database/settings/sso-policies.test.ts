/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  applyDomainPoliciesToPassports,
  applyDomainPoliciesToStrategyList,
  mostSpecificSsoDomainPolicyForEmail,
  normalizeSsoDomain,
  normalizeSsoDomainPolicy,
  passwordSignupBlockedBySsoPolicy,
} from "./sso-policies";

describe("SSO domain policy normalization", () => {
  it("normalizes domains and defaults invalid enum values safely", () => {
    expect(normalizeSsoDomain("@Sub.Example.EDU ")).toBe("sub.example.edu");
    expect(
      normalizeSsoDomainPolicy({
        domain: "@Example.edu",
        provider_id: "google",
        mode: "bad",
        signup_mode: "bad",
      }),
    ).toEqual({
      domain: "example.edu",
      provider_id: "google",
      mode: "sso_required",
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "inherit",
      notes: undefined,
    });
  });
});

describe("SSO domain policy application", () => {
  const policies = [
    {
      domain: "example.edu",
      provider_id: "google",
      mode: "sso_required" as const,
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "inherit" as const,
    },
    {
      domain: "password.example.edu",
      provider_id: "google",
      mode: "password_allowed" as const,
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "inherit" as const,
    },
    {
      domain: "disabled.example.edu",
      provider_id: "google",
      mode: "sso_required" as const,
      enabled: false,
      require_cocalc_2fa: false,
      signup_mode: "inherit" as const,
    },
  ];

  it("adds enabled required domains to public strategy discovery", () => {
    expect(
      applyDomainPoliciesToStrategyList(
        [
          {
            name: "google",
            display: "Google",
            backgroundColor: "",
            public: true,
            exclusiveDomains: ["existing.edu"],
            doNotHide: false,
          },
        ],
        policies,
      )[0].exclusiveDomains,
    ).toEqual(["example.edu", "existing.edu"]);
  });

  it("adds enabled required domains to runtime passport metadata", () => {
    const passports = {
      google: {
        strategy: "google",
        conf: { type: "oidc" as const },
        info: {
          exclusive_domains: ["existing.edu"],
          allowed_domains: ["existing.edu"],
        },
      },
    };
    applyDomainPoliciesToPassports(passports, policies);
    expect(passports.google.info?.exclusive_domains).toEqual([
      "example.edu",
      "existing.edu",
    ]);
    expect(passports.google.info?.allowed_domains).toEqual([
      "example.edu",
      "existing.edu",
    ]);
  });

  it("finds the most specific enabled policy for an email", () => {
    expect(
      mostSpecificSsoDomainPolicyForEmail(
        [
          {
            domain: "example.edu",
            provider_id: "google",
            mode: "sso_required",
            enabled: true,
            require_cocalc_2fa: false,
            signup_mode: "inherit",
          },
          {
            domain: "dept.example.edu",
            provider_id: "dept",
            mode: "sso_signup_only",
            enabled: true,
            require_cocalc_2fa: true,
            signup_mode: "disabled",
          },
        ],
        "ada@sub.dept.example.edu",
      )?.provider_id,
    ).toBe("dept");
  });

  it("knows which domain modes block password signup", () => {
    expect(
      passwordSignupBlockedBySsoPolicy({
        domain: "example.edu",
        provider_id: "google",
        mode: "sso_signup_only",
        enabled: true,
        require_cocalc_2fa: false,
        signup_mode: "inherit",
      }),
    ).toBe(true);
    expect(
      passwordSignupBlockedBySsoPolicy({
        domain: "example.edu",
        provider_id: "google",
        mode: "password_allowed",
        enabled: true,
        require_cocalc_2fa: false,
        signup_mode: "inherit",
      }),
    ).toBe(false);
  });
});
