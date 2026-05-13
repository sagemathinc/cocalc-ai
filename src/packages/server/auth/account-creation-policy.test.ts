/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { evaluateAccountCreationPolicy } from "./account-creation-policy";

describe("account creation policy", () => {
  it("blocks password signup for SSO-required domains", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "password",
        sso_required_domain: "Cornell.edu",
      }),
    ).toEqual({
      type: "deny_use_sso",
      domain: "cornell.edu",
    });
  });

  it("requires a validated registration token when token-gated signup is enabled", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "password",
        requires_registration_token: true,
      }),
    ).toEqual({ type: "deny_registration_token_required" });
  });

  it("does not allow signup to authenticate an existing account", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "password",
        requires_registration_token: true,
        registration_token_validated: true,
        existing_account: true,
      }),
    ).toEqual({ type: "deny_existing_account" });
  });

  it("requires verified email for SSO account creation", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "google_oidc",
        email_verified: false,
      }),
    ).toEqual({ type: "deny_email_unverified" });
  });

  it("treats registration-token signup as a trusted account-creation signal", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "password",
        requires_registration_token: true,
        registration_token_validated: true,
        email_verified: false,
      }),
    ).toEqual({
      type: "allow_create",
      trusted_account: true,
    });
  });

  it("allows public password signup but does not mark it trusted without verified email", () => {
    expect(
      evaluateAccountCreationPolicy({
        auth_method: "password",
        requires_registration_token: false,
        email_verified: false,
      }),
    ).toEqual({
      type: "allow_create",
      trusted_account: false,
    });
  });
});
