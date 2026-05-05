/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Synchronized table that tracks server settings.
*/

import { EventEmitter } from "events";
import { isEmpty } from "lodash";
import { EXTRAS as SERVER_SETTINGS_EXTRAS } from "@cocalc/util/db-schema/site-settings-extras";
import { buildPublicSiteSettings } from "@cocalc/util/db-schema/site-settings-public";
import { AllSiteSettings } from "@cocalc/util/db-schema/types";
import { site_settings_conf as SITE_SETTINGS_CONF } from "@cocalc/util/schema";
import getPool from "@cocalc/database/pool";
import {
  getServerSettings as loadServerSettingsSnapshot,
  resetServerSettingsCache,
} from "@cocalc/database/settings/server-settings";
import getLogger from "../logger";

const logger = getLogger("hub:server-settings");
const SERVER_SETTINGS_POLL_MS =
  process.env.NODE_ENV === "development" ? 3000 : 5000;

// Returns:
//   - all: a mutable javascript object that is a map from each server setting to its current value.
//                      This includes VERY private info (e.g., stripe private key)
//   - pub: similar, but only subset of public info that is needed for browser UI rendering.
//   - version
//   - table: the table, so you can watch for on change events...
// These get automatically updated when the database changes.

export interface ServerSettingsDynamic {
  all: AllSiteSettings;
  pub: object;
  version: {
    version_min_browser?: number;
    version_recommended_browser?: number;
  };
  table: EventEmitter;
}

let serverSettings: ServerSettingsDynamic | undefined = undefined;

async function readServerSettingsLastUpdate(): Promise<string | undefined> {
  const { rows } = await getPool().query(
    "SELECT value FROM server_settings WHERE name = $1",
    ["_last_update"],
  );
  return rows[0]?.value ?? undefined;
}

function applyServerSettingsSnapshot(
  target: ServerSettingsDynamic,
  snapshot: Record<string, unknown>,
): void {
  const { all, pub, version } = target;
  for (const key of Object.keys(all)) {
    delete all[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "_timestamp") {
      continue;
    }
    all[key] = value as any;
  }

  // set all default values
  for (const config of [SITE_SETTINGS_CONF, SERVER_SETTINGS_EXTRAS]) {
    for (const field in config) {
      if (all[field] == null) {
        const spec = config[field];
        const fallbackVal =
          spec?.to_val != null ? spec.to_val(spec.default, all) : spec.default;
        // we don't bother to set empty strings or empty arrays
        if (
          (typeof fallbackVal === "string" && fallbackVal === "") ||
          (Array.isArray(fallbackVal) && isEmpty(fallbackVal))
        ) {
          continue;
        }
        all[field] = fallbackVal;
      }
    }
  }

  // PRECAUTION: never make the required browser version bigger than version_recommended_browser. Very important
  // not to stupidly completely eliminate all cocalc users by a typo...
  const minBrowser = all.version_min_browser || 0;
  const recommendedBrowser = all.version_recommended_browser || 0;
  all.version_min_browser = Math.min(minBrowser, recommendedBrowser);

  const { configuration, version: nextVersion } = buildPublicSiteSettings(all);
  for (const key of Object.keys(pub)) {
    delete pub[key];
  }
  Object.assign(pub, configuration);
  for (const key of Object.keys(version)) {
    delete version[key];
  }
  Object.assign(version, nextVersion);
  for (const [key, value] of Object.entries(nextVersion)) {
    all[key] = value;
  }
}

function startServerSettingsPolling(target: ServerSettingsDynamic): void {
  let lastUpdateValue: string | undefined;
  let closed = false;

  const poll = async () => {
    try {
      const nextLastUpdate = await readServerSettingsLastUpdate();
      if (nextLastUpdate !== lastUpdateValue) {
        resetServerSettingsCache();
        const snapshot = await loadServerSettingsSnapshot();
        applyServerSettingsSnapshot(target, snapshot);
        if (lastUpdateValue !== undefined) {
          target.table.emit("change");
        }
        lastUpdateValue = nextLastUpdate;
      }
    } catch (err) {
      logger.warn("server settings refresh failed", { err: `${err}` });
    } finally {
      if (!closed) {
        const timer = setTimeout(() => void poll(), SERVER_SETTINGS_POLL_MS);
        timer.unref?.();
      }
    }
  };

  void poll();
  target.table.once("close", () => {
    closed = true;
  });
}

export default async function getServerSettings(): Promise<ServerSettingsDynamic> {
  if (serverSettings != null) {
    return serverSettings;
  }
  serverSettings = {
    all: {},
    pub: {},
    version: {},
    table: new EventEmitter(),
  };
  resetServerSettingsCache();
  applyServerSettingsSnapshot(
    serverSettings,
    await loadServerSettingsSnapshot(),
  );
  startServerSettingsPolling(serverSettings);
  return serverSettings;
}
