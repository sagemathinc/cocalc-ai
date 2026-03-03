#!/usr/bin/env node
"use strict";

/*
Resolve a reproducible local CoCalc dev environment for CLI/browser automation.

Usage:
  node scripts/dev/dev-env.js lite [--json] [--no-start] [--with-browser] [--shell]
  node scripts/dev/dev-env.js hub  [--json] [--no-start] [--with-browser] [--shell]

Default output is shell exports suitable for:
  eval "$(pnpm dev:env:lite)"
*/

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const LITE_DAEMON = path.join(ROOT, "scripts", "dev", "lite-daemon.sh");
const HUB_DAEMON = path.join(ROOT, "scripts", "dev", "hub-daemon.sh");
const LOCAL_PROJECT_ID = "00000000-1000-4000-8000-000000000000";

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.error(
    `Usage: dev-env.js <lite|hub> [--json] [--start|--no-start] [--with-browser] [--shell]`,
  );
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function parseKeyValueLines(text) {
  const out = {};
  for (const raw of `${text ?? ""}`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1);
    out[key] = val;
  }
  return out;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.pathname = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return `${url ?? ""}`.trim().replace(/\/+$/, "");
  }
}

function loadJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function getAuthConfig() {
  const cfgPath =
    `${process.env.COCALC_CLI_CONFIG ?? ""}`.trim() ||
    path.join(
      `${process.env.XDG_CONFIG_HOME ?? ""}`.trim() || path.join(os.homedir(), ".config"),
      "cocalc",
      "config.json",
    );
  const cfg = loadJsonIfExists(cfgPath);
  if (!cfg || typeof cfg !== "object") {
    return { path: cfgPath, current: undefined, profiles: {} };
  }
  return {
    path: cfgPath,
    current: `${cfg.current_profile ?? ""}`.trim() || undefined,
    profiles: cfg.profiles && typeof cfg.profiles === "object" ? cfg.profiles : {},
  };
}

function chooseProfileForApi(profiles, current, targetApi) {
  const names = Object.keys(profiles || {});
  if (!names.length) return undefined;
  const normTarget = normalizeUrl(targetApi);
  const explicitProfile = `${process.env.COCALC_PROFILE ?? ""}`.trim();
  if (explicitProfile && profiles[explicitProfile]) return profiles[explicitProfile];

  if (current && profiles[current]) {
    const curApi = normalizeUrl(profiles[current].api || "");
    if (!normTarget || !curApi || curApi === normTarget) return profiles[current];
  }
  for (const name of names) {
    const p = profiles[name] || {};
    if (normalizeUrl(p.api || "") === normTarget) return p;
  }
  if (current && profiles[current]) return profiles[current];
  return profiles[names[0]];
}

function daemonStatus(mode) {
  const script = mode === "lite" ? LITE_DAEMON : HUB_DAEMON;
  const res = run("bash", [script, "status"]);
  const out = `${res.stdout ?? ""}`;
  const firstLine = out.split(/\r?\n/)[0]?.trim() || "";
  const running = firstLine.startsWith("running");
  return { running, statusText: out, stderr: `${res.stderr ?? ""}` };
}

function ensureDaemon(mode, autoStart) {
  const script = mode === "lite" ? LITE_DAEMON : HUB_DAEMON;
  const before = daemonStatus(mode);
  let started = false;
  if (!before.running && autoStart) {
    const start = run("bash", [script, "start"], { stdio: ["ignore", "pipe", "pipe"] });
    if (start.status !== 0) {
      throw new Error(
        `${mode} daemon failed to start:\n${start.stdout ?? ""}\n${start.stderr ?? ""}`.trim(),
      );
    }
    started = true;
  }
  const after = daemonStatus(mode);
  return { started, running: after.running, statusText: after.statusText };
}

function getLiteEnvValues() {
  const envOut = run("bash", [LITE_DAEMON, "env"]);
  if (envOut.status !== 0) {
    throw new Error(`failed to read lite daemon env:\n${envOut.stderr ?? ""}`.trim());
  }
  const vars = parseKeyValueLines(envOut.stdout);
  const connPath = vars.LITE_CONNECTION_INFO || path.join(ROOT, ".local", "lite-daemon", "connection-info.json");
  const conn = loadJsonIfExists(connPath) || {};
  const url =
    `${conn.url ?? ""}`.trim() ||
    (() => {
      const protocol = `${conn.protocol ?? "http"}`.trim() || "http";
      const host = `${conn.host ?? "localhost"}`.trim() || "localhost";
      const port = Number(conn.port);
      if (Number.isFinite(port) && port > 0) return `${protocol}://${host}:${port}`;
      return "";
    })();
  return {
    daemonVars: vars,
    connectionPath: connPath,
    connectionInfo: conn,
    apiUrl: normalizeUrl(url),
  };
}

function getHubEnvValues() {
  const envOut = run("bash", [HUB_DAEMON, "env"]);
  if (envOut.status !== 0) {
    throw new Error(`failed to read hub daemon env:\n${envOut.stderr ?? ""}`.trim());
  }
  const vars = parseKeyValueLines(envOut.stdout);
  const hostRaw = `${vars.HUB_BIND_HOST ?? "localhost"}`.trim() || "localhost";
  const host = hostRaw === "0.0.0.0" ? "127.0.0.1" : hostRaw;
  const port = Number(vars.HUB_PORT || 9100);
  const protocol = "http";
  return {
    daemonVars: vars,
    apiUrl: normalizeUrl(`${protocol}://${host}:${port}`),
  };
}

function getBrowserId({ apiUrl, bearer, accountId }) {
  const args = ["--json", "--api", apiUrl];
  if (bearer) args.push("--bearer", bearer);
  if (accountId) args.push("--account-id", accountId);
  args.push("browser", "session", "list");
  const res = run("cocalc", args);
  if (res.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(res.stdout || "{}");
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    if (!data.length) return undefined;
    const active = data.filter((x) => x && x.stale !== true);
    const use = active.length ? active : data;
    use.sort((a, b) => {
      const aa = Date.parse(a?.updated_at || "") || 0;
      const bb = Date.parse(b?.updated_at || "") || 0;
      return bb - aa;
    });
    return `${use[0]?.browser_id ?? ""}`.trim() || undefined;
  } catch {
    return undefined;
  }
}

function shellEscape(val) {
  const s = `${val ?? ""}`;
  return `'${s.replace(/'/g, `'\"'\"'`)}'`;
}

function emitShell(exportsMap, meta) {
  console.log(`# CoCalc dev env (${meta.mode})`);
  if (meta.startedDaemon) {
    console.log(`# started ${meta.mode} daemon`);
  }
  if (!meta.running) {
    console.log(`# warning: ${meta.mode} daemon is currently stopped`);
    console.log(`# start it with: pnpm ${meta.mode}:daemon:start`);
  }
  for (const [k, v] of Object.entries(exportsMap)) {
    console.log(`export ${k}=${shellEscape(v)}`);
  }
  console.log(`# apply: eval \"$(pnpm -s dev:env:${meta.mode})\"`);
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode !== "lite" && mode !== "hub") {
    usageAndExit("missing mode");
  }

  const flags = new Set(args);
  const asJson = flags.has("--json");
  const shell = !asJson || flags.has("--shell");
  const defaultStart = mode === "lite";
  const autoStart = flags.has("--start") ? true : flags.has("--no-start") ? false : defaultStart;
  const withBrowser = flags.has("--with-browser");

  const daemon = ensureDaemon(mode, autoStart);
  if (mode === "lite" && !daemon.running) {
    throw new Error(`lite daemon is not running. Start it with: pnpm lite:daemon:start`);
  }
  const source = mode === "lite" ? getLiteEnvValues() : getHubEnvValues();
  const auth = getAuthConfig();
  const profile = chooseProfileForApi(auth.profiles, auth.current, source.apiUrl);

  const apiUrl = source.apiUrl || `${process.env.COCALC_API_URL ?? ""}`.trim();
  if (!apiUrl) {
    throw new Error(`unable to resolve COCALC_API_URL for ${mode}`);
  }

  const bearer =
    `${mode === "lite" ? source.connectionInfo?.agent_token ?? source.connectionInfo?.token ?? "" : ""}`.trim() ||
    `${profile?.bearer ?? ""}`.trim() ||
    `${process.env.COCALC_BEARER_TOKEN ?? ""}`.trim();

  const accountId =
    `${mode === "lite" ? source.connectionInfo?.account_id ?? "" : ""}`.trim() ||
    `${profile?.account_id ?? ""}`.trim() ||
    `${process.env.COCALC_ACCOUNT_ID ?? ""}`.trim();

  const projectId =
    `${process.env.COCALC_PROJECT_ID ?? ""}`.trim() || LOCAL_PROJECT_ID;

  let browserId =
    `${process.env.COCALC_BROWSER_ID ?? ""}`.trim() ||
    `${profile?.browser_id ?? ""}`.trim();
  if (withBrowser && !browserId) {
    browserId = getBrowserId({ apiUrl, bearer, accountId }) || "";
  }

  const exportsMap = {
    COCALC_API_URL: apiUrl,
    COCALC_BEARER_TOKEN: bearer,
    COCALC_ACCOUNT_ID: accountId,
    COCALC_PROJECT_ID: projectId,
    COCALC_BROWSER_ID: browserId,
    COCALC_DEV_ENV_MODE: mode,
  };
  if (mode === "lite" && source.connectionPath) {
    exportsMap.COCALC_LITE_CONNECTION_INFO = source.connectionPath;
  }

  const payload = {
    mode,
    started_daemon: daemon.started,
    daemon_running: daemon.running,
    api_url: apiUrl,
    has_bearer: !!bearer,
    has_account_id: !!accountId,
    project_id: projectId,
    browser_id: browserId || undefined,
    exports: exportsMap,
    auth_config_path: auth.path,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (shell) {
    emitShell(exportsMap, { mode, startedDaemon: daemon.started, running: daemon.running });
    return;
  }
  console.log(payload);
}

try {
  main();
} catch (err) {
  console.error(`dev-env error: ${err?.message ?? err}`);
  process.exit(1);
}
