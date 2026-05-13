/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isSupportedSSOStrategy } from "./get-sso-strategies";
import {
  googleSsoStateFromSettings,
  normalizeGoogleSsoDomains,
  normalizeGoogleSsoSignupMode,
} from "./google-sso";

describe("isSupportedSSOStrategy", () => {
  it("keeps Google as the only supported built-in public SSO provider", () => {
    expect(isSupportedSSOStrategy("google", true)).toBe(true);
    expect(isSupportedSSOStrategy("github", true)).toBe(false);
    expect(isSupportedSSOStrategy("facebook", true)).toBe(false);
    expect(isSupportedSSOStrategy("twitter", true)).toBe(false);
  });

  it("allows custom organization providers", () => {
    expect(isSupportedSSOStrategy("cornell", false)).toBe(true);
    expect(isSupportedSSOStrategy("cornell", true)).toBe(true);
  });
});

describe("googleSsoStateFromSettings", () => {
  it("does not configure Google SSO unless enabled with credentials", () => {
    expect(
      googleSsoStateFromSettings({
        google_sso_enabled: false,
        google_sso_client_id: "id",
        google_sso_client_secret: "secret",
      }).strategy,
    ).toBeUndefined();

    expect(
      googleSsoStateFromSettings({
        google_sso_enabled: true,
        google_sso_client_id: "id",
        google_sso_client_secret: "",
      }).strategy,
    ).toBeUndefined();
  });

  it("builds a Google strategy from admin settings", () => {
    const state = googleSsoStateFromSettings({
      google_sso_enabled: true,
      google_sso_client_id: " id ",
      google_sso_client_secret: " secret ",
      google_sso_allowed_domains: "Example.com, school.edu",
      google_sso_signup_mode: "public_allowed",
    });

    expect(state.strategy).toEqual({
      strategy: "google",
      conf: {
        type: "oauth2",
        clientID: "id",
        clientSecret: "secret",
      },
      info: {
        public: true,
        display: "Google",
        icon: "google",
        allowed_domains: ["example.com", "school.edu"],
        exclusive_domains: ["example.com", "school.edu"],
        account_creation: "public_allowed",
      },
    });
    expect(state.signupMode).toBe("public_allowed");
  });
});

describe("Google SSO settings normalization", () => {
  it("normalizes comma-separated domains", () => {
    expect(normalizeGoogleSsoDomains(" Example.com, ,Sub.School.edu ")).toEqual(
      ["example.com", "sub.school.edu"],
    );
  });

  it("defaults unknown signup modes to registration token required", () => {
    expect(normalizeGoogleSsoSignupMode("public_allowed")).toBe(
      "public_allowed",
    );
    expect(normalizeGoogleSsoSignupMode("invalid")).toBe(
      "registration_token_required",
    );
  });
});
