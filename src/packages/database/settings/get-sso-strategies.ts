/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { Strategy } from "@cocalc/util/types/sso";
import { ssoDispayedName } from "@cocalc/util/auth";

const CACHE_TTL_MS = process.env.NODE_ENV === "development" ? 3_000 : 15_000;
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

  const strategies = rows.map((row) => {
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
  cachedStrategies = {
    expires: Date.now() + CACHE_TTL_MS,
    value: strategies,
  };
  return strategies;
}

export const COLORS = {
  github: "#000000",
  facebook: "#428bca",
  google: "#dc4857",
  twitter: "#55acee",
} as const;
