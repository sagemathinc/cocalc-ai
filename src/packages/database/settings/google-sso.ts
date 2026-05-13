/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PassportStrategyDB } from "@cocalc/database/settings/auth-sso-types";
import type { AllSiteSettingsCached } from "@cocalc/util/db-schema/types";

import { getServerSettings } from "./server-settings";

export const GOOGLE_SSO_STRATEGY = "google";

export const GOOGLE_SSO_SIGNUP_MODES = [
  "disabled",
  "registration_token_required",
  "public_allowed",
] as const;

export type GoogleSsoSignupMode = (typeof GOOGLE_SSO_SIGNUP_MODES)[number];

export interface GoogleSsoSettingsState {
  enabled: boolean;
  configured: boolean;
  clientID: string;
  clientSecret: string;
  allowedDomains: string[];
  signupMode: GoogleSsoSignupMode;
  strategy?: PassportStrategyDB;
}

export function normalizeGoogleSsoSignupMode(
  value: unknown,
): GoogleSsoSignupMode {
  return GOOGLE_SSO_SIGNUP_MODES.includes(value as GoogleSsoSignupMode)
    ? (value as GoogleSsoSignupMode)
    : "registration_token_required";
}

export function normalizeGoogleSsoDomains(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeGoogleSsoDomains);
  }
  return `${value ?? ""}`
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

export function googleSsoStateFromSettings(
  settings: Pick<
    AllSiteSettingsCached,
    | "google_sso_enabled"
    | "google_sso_client_id"
    | "google_sso_client_secret"
    | "google_sso_allowed_domains"
    | "google_sso_signup_mode"
  >,
): GoogleSsoSettingsState {
  const enabled = settings.google_sso_enabled === true;
  const clientID = `${settings.google_sso_client_id ?? ""}`.trim();
  const clientSecret = `${settings.google_sso_client_secret ?? ""}`.trim();
  const allowedDomains = normalizeGoogleSsoDomains(
    settings.google_sso_allowed_domains,
  );
  const signupMode = normalizeGoogleSsoSignupMode(
    settings.google_sso_signup_mode,
  );
  const configured = enabled && clientID.length > 0 && clientSecret.length > 0;
  const base = {
    enabled,
    configured,
    clientID,
    clientSecret,
    allowedDomains,
    signupMode,
  };

  if (!configured) {
    return base;
  }

  return {
    ...base,
    strategy: {
      strategy: GOOGLE_SSO_STRATEGY,
      conf: {
        type: "oidc",
        clientID,
        clientSecret,
      },
      info: {
        public: true,
        display: "Google",
        icon: "google",
        allowed_domains: allowedDomains,
        exclusive_domains: allowedDomains,
        account_creation: signupMode,
      },
    },
  };
}

export async function getGoogleSsoSettingsState(): Promise<GoogleSsoSettingsState> {
  return googleSsoStateFromSettings(await getServerSettings());
}
