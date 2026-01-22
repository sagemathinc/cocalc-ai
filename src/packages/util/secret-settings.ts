/*
Helpers for identifying secret admin settings.

Secret settings are defined as those with `password: true` in the site settings
config. These should be treated as write-only in admin UI and encrypted at rest.
*/

import { site_settings_conf } from "./db-schema/site-defaults";
import { EXTRAS } from "./db-schema/site-settings-extras";

export const SECRET_SETTING_PREFIX = "enc:v1:";

export function isSecretSetting(name: string): boolean {
  const spec = (site_settings_conf as any)[name] ?? (EXTRAS as any)[name];
  return !!spec?.password;
}
