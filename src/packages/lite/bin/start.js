#!/usr/bin/env node
const { dirname, join } = require("path");

function defaultLiteDataDir() {
  const home = process.env.HOME ?? process.cwd();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "cocalc-lite");
  }
  return join(home, ".local", "share", "cocalc-lite");
}

(async () => {
  process.env.PORT ??= await require("@cocalc/backend/get-port").default();
  process.env.DATA ??= defaultLiteDataDir();
  process.env.COCALC_DATA_DIR ??= process.env.DATA;

  // put path to special node binaries:
  const { bin } = require("@cocalc/backend/data");
  process.env.PATH = `${bin}:${dirname(process.execPath)}:${process.env.PATH}`;

  require("@cocalc/lite/main").main();
})();
