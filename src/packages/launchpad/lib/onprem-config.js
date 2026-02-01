const { existsSync } = require("fs");
const { join } = require("path");
const { resolveOnPremHost } = require("@cocalc/server/onprem");

function parsePort(value) {
  if (value == null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function resolveDataDir() {
  if (process.env.COCALC_DATA_DIR) {
    return process.env.COCALC_DATA_DIR;
  }
  if (process.env.DATA) {
    return process.env.DATA;
  }
  const home = process.env.HOME ?? process.cwd();
  const legacy = join(home, ".local", "share", "cocalc-launchpad");
  if (existsSync(legacy)) {
    return legacy;
  }
  return join(home, ".local", "share", "cocalc", "launchpad");
}

function findArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1) {
    return process.argv[idx + 1];
  }
  const prefixed = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (prefixed) {
    return prefixed.slice(flag.length + 1);
  }
  return undefined;
}

function applyLaunchpadDefaults() {
  process.env.COCALC_DB ??= "pglite";
  process.env.COCALC_DISABLE_NEXT ??= "1";
  process.env.COCALC_PRODUCT ??= "launchpad";

  const dataDir = resolveDataDir();
  process.env.DATA ??= dataDir;
  process.env.COCALC_DATA_DIR ??= process.env.DATA;
  process.env.COCALC_PGLITE_DATA_DIR ??= join(process.env.DATA, "pglite");

  const basePort =
    parsePort(process.env.COCALC_BASE_PORT) ??
    parsePort(process.env.COCALC_HTTP_PORT) ??
    parsePort(process.env.PORT) ??
    9001;

  process.env.COCALC_HTTP_PORT ??= String(basePort);
  process.env.PORT ??= process.env.COCALC_HTTP_PORT;
  process.env.COCALC_SSHD_PORT ??= String(basePort + 1);
}

module.exports = {
  applyLaunchpadDefaults,
  resolveLaunchpadHost: resolveOnPremHost,
  logLaunchpadConfig() {
    const summary = {
      host: resolveLaunchpadHost(),
      data_dir: process.env.COCALC_DATA_DIR ?? process.env.DATA,
      http_port: process.env.COCALC_HTTP_PORT,
      sshd_port: process.env.COCALC_SSHD_PORT,
    };
    console.log("launchpad config:", summary);
  },
};
