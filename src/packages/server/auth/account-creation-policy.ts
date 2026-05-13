/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type AccountCreationAuthMethod = "password" | "google_oidc" | "saml";

export type AccountCreationPolicyDecision =
  | {
      type: "allow_create";
      trusted_account: boolean;
    }
  | {
      type: "deny_existing_account";
    }
  | {
      type: "deny_registration_token_required";
    }
  | {
      type: "deny_signup_disabled";
      domain?: string;
    }
  | {
      type: "deny_email_unverified";
    }
  | {
      type: "deny_use_sso";
      domain: string;
    };

export interface AccountCreationPolicyInput {
  auth_method: AccountCreationAuthMethod;
  email?: string;
  email_verified?: boolean;
  requires_registration_token?: boolean;
  registration_token_validated?: boolean;
  domain_sso_validated?: boolean;
  existing_account?: boolean;
  sso_required_domain?: string;
  signup_disabled_domain?: string;
}

function normalizedDomain(domain?: string): string | undefined {
  const value = `${domain ?? ""}`.trim().toLowerCase();
  return value || undefined;
}

export function evaluateAccountCreationPolicy({
  auth_method,
  email_verified = false,
  requires_registration_token = false,
  registration_token_validated = false,
  domain_sso_validated = false,
  existing_account = false,
  sso_required_domain,
  signup_disabled_domain,
}: AccountCreationPolicyInput): AccountCreationPolicyDecision {
  const disabledDomain = normalizedDomain(signup_disabled_domain);
  if (disabledDomain) {
    return {
      type: "deny_signup_disabled",
      domain: disabledDomain,
    };
  }

  const requiredDomain = normalizedDomain(sso_required_domain);
  if (auth_method === "password" && requiredDomain) {
    return {
      type: "deny_use_sso",
      domain: requiredDomain,
    };
  }

  if (
    requires_registration_token &&
    !registration_token_validated &&
    !domain_sso_validated
  ) {
    return { type: "deny_registration_token_required" };
  }

  if (existing_account) {
    return { type: "deny_existing_account" };
  }

  if (auth_method !== "password" && !email_verified) {
    return { type: "deny_email_unverified" };
  }

  return {
    type: "allow_create",
    trusted_account:
      email_verified || registration_token_validated || domain_sso_validated,
  };
}
