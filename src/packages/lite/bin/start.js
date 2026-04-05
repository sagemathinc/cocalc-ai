#!/usr/bin/env node
const { dirname, join } = require("path");
const {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} = require("@cocalc/util/misc");

function defaultLiteDataDir() {
  const home = process.env.HOME ?? process.cwd();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "cocalc-lite");
  }
  return join(home, ".local", "share", "cocalc-lite");
}

(async () => {
  // Lite always uses one canonical local account/project identity.
  process.env.COCALC_PROJECT_ID = FALLBACK_PROJECT_UUID;
  process.env.COCALC_ACCOUNT_ID = FALLBACK_ACCOUNT_UUID;
  process.env.PORT ??= await require("@cocalc/backend/get-port").default();
  process.env.DATA ??= defaultLiteDataDir();
  process.env.COCALC_DATA_DIR ??= process.env.DATA;

  // put path to special node binaries:
  const { bin } = require("@cocalc/backend/data");
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;

  require("@cocalc/lite/main").main();
})();
