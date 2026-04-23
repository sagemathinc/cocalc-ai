#!/usr/bin/env node

/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

function setDefault(name, value) {
  if (!process.env[name] && value) {
    process.env[name] = value;
  }
}

async function main() {
  setDefault("COCALC_ROOT", process.env.COCALC_BAY_CURRENT_LINK);
  setDefault("COCALC_PRODUCT", "launchpad");
  setDefault("DATA", process.env.COCALC_BAY_ROOT);
  setDefault("COCALC_DATA_DIR", process.env.COCALC_BAY_ROOT);
  setDefault("LOGS", process.env.COCALC_BAY_LOG_DIR);
  setDefault("PORT", "0");

  const { callback2 } = require("../../util/dist/async-utils.js");
  const initDatabaseModule = require("../../hub/dist/servers/database.js");
  const initDatabase =
    initDatabaseModule.default ?? initDatabaseModule.init ?? initDatabaseModule;
  const { getDatabase } = initDatabaseModule;
  const {
    load_server_settings_from_env,
  } = require("../../database/dist/settings/server-settings.js");
  const {
    initialOnPremSetup,
  } = require("../../server/dist/initial-onprem-setup.js");
  const { isLaunchpadProduct } = require("../../server/dist/launchpad/mode.js");

  initDatabase();
  const db = getDatabase();

  try {
    await callback2(db.connect.bind(db));
    await load_server_settings_from_env(db);
    await db.update_schema();

    if (
      isLaunchpadProduct() &&
      `${process.env.COCALC_BAY_SKIP_INITIAL_ONPREM_SETUP ?? ""}`.trim() !== "1"
    ) {
      await initialOnPremSetup(db);
    }

    console.log("bay schema migration completed");
  } finally {
    try {
      db.close?.();
    } catch {}
  }
}

main().catch((err) => {
  console.error("bay schema migration failed:", err);
  process.exit(1);
});
