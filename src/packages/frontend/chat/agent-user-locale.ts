/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import {
  agentLocationEnabled,
  normalizeAgentUserLocale,
  OTHER_SETTINGS_AGENT_LOCATION_KEY,
  type AgentUserLocale,
} from "@cocalc/util/ai/agent-user-locale";

/** This browser's time zone and, unless the account turned it off, its
 * approximate location (city and region, from the network). */
export function browserAgentUserLocale(): AgentUserLocale | undefined {
  let time_zone: string | undefined;
  try {
    time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    time_zone = undefined;
  }
  const customize = redux.getStore("customize");
  const allowLocation = agentLocationEnabled(
    redux
      .getStore("account")
      ?.getIn(["other_settings", OTHER_SETTINGS_AGENT_LOCATION_KEY]),
  );
  return normalizeAgentUserLocale({
    time_zone: time_zone || customize?.get("cloudflare_timezone"),
    ...(allowLocation
      ? {
          city: customize?.get("cloudflare_city"),
          region: customize?.get("cloudflare_region"),
          country_code: customize?.get("country"),
        }
      : {}),
  });
}
