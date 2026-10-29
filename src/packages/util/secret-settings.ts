/*
Helpers for identifying secret admin settings.

Secret settings are defined as those with `password: true` in the site settings
config. These should be treated as write-only in admin UI and encrypted at rest.
*/

import { site_settings_conf } from "./db-schema/site-defaults";
import { EXTRAS } from "./db-schema/site-settings-extras";

export const SECRET_SETTING_PREFIX = "enc:v1:";

// Secret settings whose definitions were removed while their stored rows may
// remain. They stay secret, so the stored value is still decrypted, migrated
// and re-encrypted by master-key rotation, until a deploy deletes the rows
// and verifies it; then drop the name here.
export const RETIRED_SECRET_SETTINGS: ReadonlySet<string> = new Set([
  // GitHub public-share proxy token (removed 2026-10).
  "github_token",
]);

export function isSecretSetting(name: string): boolean {
  if (RETIRED_SECRET_SETTINGS.has(name)) return true;
  const spec = (site_settings_conf as any)[name] ?? (EXTRAS as any)[name];
  return !!spec?.password;
}
