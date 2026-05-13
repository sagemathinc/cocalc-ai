/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isValidSsoProviderID,
  normalizeSsoProvider,
  normalizeSsoProviderDomains,
  ssoProviderToPassportStrategy,
  ssoProviderToStrategy,
} from "./sso-providers";

describe("SSO provider normalization", () => {
  it("accepts only route-safe provider ids", () => {
    expect(isValidSsoProviderID("cornell")).toBe(true);
    expect(isValidSsoProviderID("school.edu-1")).toBe(true);
    expect(isValidSsoProviderID("bad/name")).toBe(false);
    expect(isValidSsoProviderID("../bad")).toBe(false);
  });

  it("normalizes enabled SAML providers", () => {
    expect(
      normalizeSsoProvider({
        provider_id: "cornell",
        kind: "saml",
        display: "Cornell",
        enabled: null,
        public: false,
        config: { entryPoint: "https://idp.example/sso" },
      }),
    ).toMatchObject({
      provider_id: "cornell",
      kind: "saml",
      display: "Cornell",
      enabled: true,
      public: false,
    });
  });

  it("drops invalid provider rows", () => {
    expect(
      normalizeSsoProvider({ provider_id: "bad/name", kind: "saml" }),
    ).toBeUndefined();
    expect(
      normalizeSsoProvider({ provider_id: "ok", kind: "unknown" }),
    ).toBeUndefined();
  });

  it("normalizes comma-separated and array domains", () => {
    expect(
      normalizeSsoProviderDomains([" Example.edu,sub.School.edu ", ""]),
    ).toEqual(["example.edu", "sub.school.edu"]);
  });
});

describe("SSO provider conversions", () => {
  const provider = normalizeSsoProvider({
    provider_id: "cornell",
    kind: "saml",
    display: "Cornell",
    public: false,
    config: {
      icon: "https://example.edu/icon.svg",
      allowed_domains: "Example.edu",
      exclusive_domains: ["example.edu"],
      account_creation: "public_allowed",
      update_on_login: true,
    },
  })!;

  it("builds public strategy metadata", () => {
    expect(ssoProviderToStrategy(provider)).toEqual({
      name: "cornell",
      display: "Cornell",
      icon: "https://example.edu/icon.svg",
      backgroundColor: "",
      public: false,
      exclusiveDomains: ["example.edu"],
      doNotHide: false,
    });
  });

  it("builds PassportLogin-compatible runtime metadata", () => {
    expect(ssoProviderToPassportStrategy(provider)).toMatchObject({
      strategy: "cornell",
      conf: {
        type: "saml",
      },
      info: {
        public: false,
        display: "Cornell",
        allowed_domains: ["example.edu"],
        exclusive_domains: ["example.edu"],
        account_creation: "public_allowed",
        update_on_login: true,
      },
    });
  });
});
