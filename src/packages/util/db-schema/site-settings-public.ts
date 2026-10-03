/*
Helpers for producing the public subset of site settings (used by /customize).
*/

import { site_settings_conf, type SiteSettingsKeys } from "./site-defaults";
import { to_bool } from "./site-defaults";
import {
  publicSignupEmailDomainPolicy,
  SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS,
} from "../accounts/signup-email-domain-policy";
import { hasStripeBillingConfiguration } from "../stripe/billing";
import { version as FRONTEND_VERSION } from "../smc-version";

export const PUBLIC_SITE_SETTINGS_KEYS = Object.freeze(
  Object.keys(site_settings_conf) as SiteSettingsKeys[],
);

const PUBLIC_SITE_SETTINGS_SET = new Set(PUBLIC_SITE_SETTINGS_KEYS);

type VersionSettings = {
  [key: string]: number;
};

function normalizeVersionValue(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : parseInt(String(value ?? "0"), 10);
  if (Number.isNaN(parsed) || parsed * 1000 >= Date.now()) {
    return 0;
  }
  return parsed;
}

export function isPublicSiteSettingKey(key: string): key is SiteSettingsKeys {
  return PUBLIC_SITE_SETTINGS_SET.has(key as SiteSettingsKeys);
}

// The required and recommended browser versions never exceed the version of
// the frontend this build serves (smc-version.js): otherwise even a browser
// that has just loaded the current frontend would be too old, and everyone
// would be disconnected (required) or told to reload forever (recommended).
export function buildPublicSiteSettings(
  all: Record<string, any>,
  frontendVersion: number = FRONTEND_VERSION,
): {
  configuration: Record<string, any>;
  version: VersionSettings;
} {
  const configuration: Record<string, any> = {};
  const version: VersionSettings = {};

  for (const key of PUBLIC_SITE_SETTINGS_KEYS) {
    if (SIGNUP_EMAIL_DOMAIN_POLICY_SETTING_KEYS.has(key)) {
      continue;
    }
    if (!(key in all)) {
      continue;
    }
    let value = all[key];
    if (key.startsWith("version_")) {
      value = normalizeVersionValue(value);
      version[key] = value;
    }
    configuration[key] = value;
  }

  const recommended =
    typeof configuration.version_recommended_browser === "number"
      ? configuration.version_recommended_browser
      : normalizeVersionValue(configuration.version_recommended_browser);
  const minBrowser =
    typeof configuration.version_min_browser === "number"
      ? configuration.version_min_browser
      : normalizeVersionValue(configuration.version_min_browser);

  const boundedRecommended = Math.min(recommended || 0, frontendVersion);
  const boundedBrowser = Math.min(minBrowser || 0, boundedRecommended);

  configuration.version_min_browser = boundedBrowser;
  version.version_min_browser = boundedBrowser;
  if (!Number.isNaN(recommended)) {
    configuration.version_recommended_browser = boundedRecommended;
    version.version_recommended_browser = boundedRecommended;
  }

  // Public pages need a derived flag that indicates whether Zendesk-backed
  // support flows are enabled without exposing any Zendesk secrets.
  configuration.zendesk = !!(
    all.zendesk_token &&
    all.zendesk_username &&
    all.zendesk_uri
  );

  // The browser only needs to know whether Stripe self-service is available;
  // never expose either Stripe key in the public customize payload.
  configuration.stripe_enabled = hasStripeBillingConfiguration(all);

  configuration.signup_email_domain_public_policy =
    publicSignupEmailDomainPolicy(all);

  // Expose only the coarse feature flag. Scanner image/cache settings remain
  // admin-only, but the browser needs this to hide scan affordances.
  configuration.rootfs_scan_enabled = to_bool(all.rootfs_scan_enabled);

  return { configuration, version };
}
