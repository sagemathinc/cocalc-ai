/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { Strategy } from "@cocalc/util/types/sso";
import { PRIMARY_SSO } from "@cocalc/util/types/passport-types";
import { ssoDispayedName } from "@cocalc/util/auth";
import { GOOGLE_SSO_STRATEGY, getGoogleSsoSettingsState } from "./google-sso";

const CACHE_TTL_MS = process.env.NODE_ENV === "development" ? 3_000 : 15_000;
const SUPPORTED_PUBLIC_SSO = ["google"] as const;
const DELETED_PUBLIC_SSO = ["facebook", "github", "twitter"] as const;
let cachedStrategies:
  | {
      expires: number;
      value: Strategy[];
    }
  | undefined;

/** Returns an array of public info about strategies.
 * Cached a bit so safe to call a lot.
 */
export default async function getStrategies(): Promise<Strategy[]> {
  if (cachedStrategies && cachedStrategies.expires > Date.now()) {
    return cachedStrategies.value;
  }
  const googleSso = await getGoogleSsoSettingsState();
  const pool = getPool();
  // entries in "conf" were used before the "info" col existed. this is only for backwards compatibility.
  const { rows } = await pool.query(`
    SELECT strategy,
           COALESCE(info -> 'icon',              conf -> 'icon')              as icon,
           COALESCE(info -> 'display',           conf -> 'display')           as display,
           COALESCE(info -> 'public',            conf -> 'public')            as public,
           COALESCE(info -> 'exclusive_domains', conf -> 'exclusive_domains') as exclusive_domains,
           COALESCE(info -> 'do_not_hide',      'false'::JSONB)               as do_not_hide

    FROM passport_settings
    WHERE strategy != 'site_conf'
      AND COALESCE(info ->> 'disabled', conf ->> 'disabled', 'false') != 'true'`);

  const strategies = rows
    .filter((row) => row.strategy !== GOOGLE_SSO_STRATEGY)
    .filter((row) => isSupportedSSOStrategy(row.strategy, row.public))
    .map((row) => {
      const display = ssoDispayedName({
        display: row.display,
        name: row.strategy,
      });

      return {
        name: row.strategy,
        display,
        icon: row.icon, // don't use row.strategy as a fallback icon, since that icon likely does not exist
        backgroundColor: COLORS[row.strategy] ?? "",
        public: row.public ?? true,
        exclusiveDomains: row.exclusive_domains ?? [],
        doNotHide: row.do_not_hide ?? false,
      };
    });
  if (googleSso.strategy != null) {
    strategies.push({
      name: GOOGLE_SSO_STRATEGY,
      display: "Google",
      icon: "google",
      backgroundColor: COLORS.google,
      public: true,
      exclusiveDomains: googleSso.allowedDomains,
      doNotHide: false,
    });
  }
  cachedStrategies = {
    expires: Date.now() + CACHE_TTL_MS,
    value: strategies,
  };
  return strategies;
}

export const COLORS = {
  google: "#dc4857",
} as const;

export function isSupportedSSOStrategy(
  name: string,
  _publicStrategy: boolean | null | undefined,
): boolean {
  if (SUPPORTED_PUBLIC_SSO.includes(name as any)) {
    return true;
  }
  if (
    PRIMARY_SSO.includes(name as any) ||
    DELETED_PUBLIC_SSO.includes(name as any)
  ) {
    return false;
  }
  return true;
}
