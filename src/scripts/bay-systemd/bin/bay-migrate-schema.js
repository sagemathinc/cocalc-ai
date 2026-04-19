#!/usr/bin/env node

const path = require("node:path");

function resolveBundleRoot() {
  return path.resolve(__dirname, "..");
}

function requireFromBundle(bundleRoot, relativePath) {
  return require(path.join(bundleRoot, relativePath));
}

function setDefault(name, value) {
  if (!process.env[name] && value) {
    process.env[name] = value;
  }
}

async function main() {
  const bundleRoot = resolveBundleRoot();

  setDefault("COCALC_ROOT", bundleRoot);
  setDefault("COCALC_PRODUCT", "launchpad");
  setDefault("DATA", process.env.COCALC_BAY_ROOT);
  setDefault("COCALC_DATA_DIR", process.env.COCALC_BAY_ROOT);
  setDefault("LOGS", process.env.COCALC_BAY_LOG_DIR);
  setDefault("PORT", "0");

  const { callback2 } = requireFromBundle(
    bundleRoot,
    "packages/util/dist/async-utils.js",
  );
  const initDatabaseModule = requireFromBundle(
    bundleRoot,
    "packages/hub/dist/servers/database.js",
  );
  const initDatabase =
    initDatabaseModule.default ?? initDatabaseModule.init ?? initDatabaseModule;
  const { getDatabase } = initDatabaseModule;
  const { load_server_settings_from_env } = requireFromBundle(
    bundleRoot,
    "packages/database/dist/settings/server-settings.js",
  );
  const { initialOnPremSetup } = requireFromBundle(
    bundleRoot,
    "packages/server/dist/initial-onprem-setup.js",
  );
  const { isLaunchpadProduct } = requireFromBundle(
    bundleRoot,
    "packages/server/dist/launchpad/mode.js",
  );

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
