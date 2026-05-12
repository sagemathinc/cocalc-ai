/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { PostgreSQL } from "@cocalc/database/postgres/types";
import { PassportStrategyDB } from "@cocalc/database/settings/auth-sso-types";
import getServerSettings from "./servers/server-settings";

export async function requires_registration_token(
  _db: PostgreSQL,
): Promise<boolean> {
  const settings = await getServerSettings();
  if (settings.all.public_signup_without_registration_token) {
    return false;
  }
  // Registration tokens are required by default. If there are no active tokens,
  // signup is intentionally blocked instead of silently becoming public.
  return true;
}

export async function get_passports(
  db: PostgreSQL,
): Promise<PassportStrategyDB[]> {
  return await db.get_all_passport_settings_cached();
}
