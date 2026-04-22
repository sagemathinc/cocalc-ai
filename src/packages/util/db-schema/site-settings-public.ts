/*
Helpers for producing the public subset of site settings (used by /customize).
*/

import { site_settings_conf, type SiteSettingsKeys } from "./site-defaults";

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

export function buildPublicSiteSettings(all: Record<string, any>): {
  configuration: Record<string, any>;
  version: VersionSettings;
} {
  const configuration: Record<string, any> = {};
  const version: VersionSettings = {};

  for (const key of PUBLIC_SITE_SETTINGS_KEYS) {
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

  const boundedBrowser = Math.min(minBrowser || 0, recommended || 0);

  configuration.version_min_browser = boundedBrowser;
  version.version_min_browser = boundedBrowser;
  if (!Number.isNaN(recommended)) {
    version.version_recommended_browser = recommended;
  }

  // Public pages need a derived flag that indicates whether Zendesk-backed
  // support flows are enabled without exposing any Zendesk secrets.
  configuration.zendesk = !!(
    all.zendesk_token &&
    all.zendesk_username &&
    all.zendesk_uri
  );

  return { configuration, version };
}
