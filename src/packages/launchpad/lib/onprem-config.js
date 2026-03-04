const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join } = require("path");
const net = require("net");
const { resolveOnPremHost } = require("@cocalc/server/onprem");
const resolveLaunchpadHost = resolveOnPremHost;
const PORT_STATE_FILE = "launchpad-port.json";
const DEFAULT_BASE_PORT = 9001;

function fail(message, detail) {
  const err = new Error(`Launchpad port configuration error: ${message}`);
  if (detail != null) {
    err.detail = detail;
  }
  throw err;
}

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

function readStatePort(dataDir) {
  const path = join(dataDir, PORT_STATE_FILE);
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const port = parsePort(raw?.basePort);
    return port;
  } catch {
    return undefined;
  }
}

function writeStatePort(dataDir, basePort) {
  const path = join(dataDir, PORT_STATE_FILE);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          basePort,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // best-effort persistence only.
  }
}

function checkPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err) => {
      resolve({
        ok: false,
        code: err?.code,
        message: err?.message,
      });
    });
    server.once("listening", () => {
      server.close(() => resolve({ ok: true }));
    });
    server.listen(port, host);
  });
}

async function checkPortPairAvailable(basePort, sshdPort) {
  const [httpCheck, sshCheck] = await Promise.all([
    checkPortAvailable(basePort),
    checkPortAvailable(sshdPort),
  ]);
  return {
    httpCheck,
    sshCheck,
    ok: !!httpCheck.ok && !!sshCheck.ok,
  };
}

async function pickAvailableBasePort() {
  // Start from a random open port, then require the adjacent sshd port.
  for (let i = 0; i < 40; i++) {
    const candidate = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port =
          addr && typeof addr === "object" && Number.isFinite(addr.port)
            ? addr.port
            : undefined;
        server.close(() => resolve(port));
      });
    }).catch(() => undefined);
    const basePort = parsePort(candidate);
    if (!basePort) continue;
    const sshdPort = basePort + 1;
    const pair = await checkPortPairAvailable(basePort, sshdPort);
    if (pair.ok) return basePort;
  }
  // Final fallback: old fixed default if the random strategy somehow fails.
  return DEFAULT_BASE_PORT;
}

function getRawEnv(name) {
  const value = process.env[name];
  if (value == null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text;
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

async function applyLaunchpadDefaults() {
  process.env.COCALC_DB ??= "pglite";
  process.env.COCALC_DISABLE_NEXT ??= "1";
  process.env.COCALC_PRODUCT ??= "launchpad";

  const dataDir = resolveDataDir();
  process.env.DATA ??= dataDir;
  process.env.COCALC_DATA_DIR ??= process.env.DATA;
  process.env.COCALC_PGLITE_DATA_DIR ??= join(process.env.DATA, "pglite");

  const baseEnvRaw =
    getRawEnv("COCALC_BASE_PORT") ??
    getRawEnv("COCALC_HTTP_PORT") ??
    getRawEnv("PORT");
  const sshdEnvRaw = getRawEnv("COCALC_SSHD_PORT");

  let basePort;
  let source = "env";
  if (baseEnvRaw != null) {
    basePort = parsePort(baseEnvRaw);
    if (!basePort) {
      fail("invalid base port in env", {
        COCALC_BASE_PORT: process.env.COCALC_BASE_PORT,
        COCALC_HTTP_PORT: process.env.COCALC_HTTP_PORT,
        PORT: process.env.PORT,
      });
    }
  } else {
    const saved = readStatePort(dataDir);
    if (saved) {
      basePort = saved;
      source = "saved";
    } else {
      basePort = await pickAvailableBasePort();
      source = "auto";
      writeStatePort(dataDir, basePort);
    }
  }

  let sshdPort = parsePort(sshdEnvRaw);
  if (sshdEnvRaw != null && !sshdPort) {
    fail("invalid sshd port in env", {
      COCALC_SSHD_PORT: process.env.COCALC_SSHD_PORT,
    });
  }
  if (!sshdPort) {
    sshdPort = basePort + 1;
  }

  const pair = await checkPortPairAvailable(basePort, sshdPort);
  if (!pair.ok) {
    const mode = source === "auto" ? "auto-selected" : source;
    fail(
      `selected ports are unavailable (${mode})`,
      {
        basePort,
        sshdPort,
        http: pair.httpCheck,
        sshd: pair.sshCheck,
        hint:
          source === "saved"
            ? "Set COCALC_BASE_PORT/COCALC_HTTP_PORT/PORT to override saved port, or free the saved port."
            : "Set COCALC_BASE_PORT/COCALC_HTTP_PORT/PORT and COCALC_SSHD_PORT to free ports.",
      },
    );
  }

  process.env.COCALC_HTTP_PORT = String(basePort);
  process.env.PORT = process.env.COCALC_HTTP_PORT;
  process.env.COCALC_SSHD_PORT = String(sshdPort);
}

module.exports = {
  applyLaunchpadDefaults,
  resolveLaunchpadHost,
  logLaunchpadConfig() {
    const summary = {
      host: resolveOnPremHost(),
      data_dir: process.env.COCALC_DATA_DIR ?? process.env.DATA,
      http_port: process.env.COCALC_HTTP_PORT,
      sshd_port: process.env.COCALC_SSHD_PORT,
    };
    console.log("launchpad config:", summary);
  },
};
