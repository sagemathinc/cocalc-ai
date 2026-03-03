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
const LOCAL_CLI_BIN = path.join(ROOT, "packages", "cli", "dist", "bin", "cocalc.js");
const LOCAL_CLI_BIN_DIR = path.join(ROOT, "packages", "cli", "node_modules", ".bin");
const LOCAL_PROJECT_ID = "00000000-1000-4000-8000-000000000000";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function firstNonEmptyLine(text) {
  for (const raw of `${text ?? ""}`.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return "";
}

function isValidUuid(value) {
  return UUID_RE.test(`${value ?? ""}`.trim());
}

function sqlLiteral(value) {
  return `'${`${value ?? ""}`.replace(/'/g, "''")}'`;
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

function parseHubStatusInfo(statusText) {
  const info = {};
  for (const raw of `${statusText ?? ""}`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    info[key] = value;
  }
  const pgHostRaw = `${info["postgres socket (pghost)"] ?? ""}`.trim();
  const pgHost =
    pgHostRaw && !/^not detected/i.test(pgHostRaw) ? pgHostRaw : undefined;
  const pgUserRaw = `${info["postgres user   (pguser)"] ?? ""}`.trim();
  const pgUser = pgUserRaw || undefined;
  const pgDataDirRaw = `${info["postgres data dir"] ?? ""}`.trim();
  const pgDataDir = pgDataDirRaw || undefined;
  return { pgHost, pgUser, pgDataDir };
}

function resolveHubPostgresConnection(statusInfo) {
  const fromStatus = {
    pgHost: `${statusInfo?.pgHost ?? ""}`.trim(),
    pgUser: `${statusInfo?.pgUser ?? ""}`.trim() || "smc",
    pgDatabase: "smc",
  };
  if (fromStatus.pgHost) return fromStatus;

  const localEnvCandidates = [];
  const pgDataDir = `${statusInfo?.pgDataDir ?? ""}`.trim();
  if (pgDataDir) {
    localEnvCandidates.push(path.join(path.dirname(pgDataDir), "local-postgres.env"));
  }
  localEnvCandidates.push(path.join(ROOT, "data", "app", "postgres", "local-postgres.env"));
  localEnvCandidates.push(path.join(ROOT, "data", "postgres", "local-postgres.env"));

  for (const file of localEnvCandidates) {
    if (!file || !fs.existsSync(file)) continue;
    const vars = parseKeyValueLines(fs.readFileSync(file, "utf8"));
    const pgHost = `${vars.PGHOST ?? ""}`.trim();
    const pgUser = `${vars.PGUSER ?? "smc"}`.trim() || "smc";
    const pgDatabase = `${vars.PGDATABASE ?? "smc"}`.trim() || "smc";
    if (pgHost) return { pgHost, pgUser, pgDatabase };
  }
  return undefined;
}

function runPsqlQuery(connection, sql) {
  if (!connection?.pgHost) return undefined;
  const env = {
    ...process.env,
    PGHOST: connection.pgHost,
    PGUSER: connection.pgUser || "smc",
    PGDATABASE: connection.pgDatabase || "smc",
  };
  const res = run(
    "psql",
    ["-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { env },
  );
  if (res.status !== 0) return undefined;
  return firstNonEmptyLine(res.stdout);
}

function resolveHubProjectAndAccount(statusInfo) {
  const connection = resolveHubPostgresConnection(statusInfo);
  if (!connection) return {};

  const latestProjectSql = `
WITH recent AS (
  SELECT
    p.project_id::text AS project_id,
    COALESCE(
      (
        SELECT e.key
        FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS e(key, value)
        WHERE COALESCE(e.value->>'group', '') = 'owner'
        LIMIT 1
      ),
      (
        SELECT e.key
        FROM jsonb_each(COALESCE(p.users, '{}'::jsonb)) AS e(key, value)
        LIMIT 1
      )
    ) AS account_id
  FROM projects p
  WHERE COALESCE(p.deleted, false) = false
  ORDER BY COALESCE(p.last_edited, p.created) DESC NULLS LAST
  LIMIT 1
)
SELECT project_id, account_id FROM recent;
`.trim();

  const line = runPsqlQuery(connection, latestProjectSql);
  if (line) {
    const [projectIdRaw, accountIdRaw] = line.split("|");
    const projectId = `${projectIdRaw ?? ""}`.trim();
    const accountId = `${accountIdRaw ?? ""}`.trim();
    if (isValidUuid(projectId) && isValidUuid(accountId)) {
      return { projectId, accountId };
    }
  }

  const accountLine = runPsqlQuery(
    connection,
    `SELECT account_id::text FROM accounts ORDER BY COALESCE(last_active, created) DESC NULLS LAST LIMIT 1;`,
  );
  const fallbackAccountId = `${accountLine ?? ""}`.trim();
  if (!isValidUuid(fallbackAccountId)) return {};

  const projectForAccountLine = runPsqlQuery(
    connection,
    `SELECT p.project_id::text
FROM projects p
WHERE COALESCE(p.deleted, false) = false
  AND COALESCE(p.users, '{}'::jsonb) ? ${sqlLiteral(fallbackAccountId)}
ORDER BY COALESCE(p.last_edited, p.created) DESC NULLS LAST
LIMIT 1;`,
  );
  const fallbackProjectId = `${projectForAccountLine ?? ""}`.trim();
  return {
    accountId: fallbackAccountId,
    projectId: isValidUuid(fallbackProjectId) ? fallbackProjectId : undefined,
  };
}

function resolveHubPassword(statusInfo) {
  const explicit = `${process.env.COCALC_HUB_PASSWORD ?? ""}`.trim();
  if (explicit) return explicit;

  const candidates = [];
  if (process.env.SECRETS?.trim()) {
    candidates.push(path.join(process.env.SECRETS.trim(), "conat-password"));
  }
  const pgDataDir = `${statusInfo?.pgDataDir ?? ""}`.trim();
  if (pgDataDir) {
    candidates.push(path.join(path.dirname(pgDataDir), "secrets", "conat-password"));
  }
  candidates.push(path.join(ROOT, "data", "app", "postgres", "secrets", "conat-password"));
  candidates.push(path.join(ROOT, "data", "secrets", "conat-password"));
  candidates.push(path.join(ROOT, "data.0", "secrets", "conat-password"));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function parseBrowserIdFromResult(stdout) {
  try {
    const parsed = JSON.parse(stdout || "{}");
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

function getBrowserId({ apiUrl, bearer, accountId, mode, hubPassword }) {
  const attempts = [];
  attempts.push({
    bearer: `${bearer ?? ""}`.trim(),
    accountId: `${accountId ?? ""}`.trim(),
  });
  // In lite mode, bearer tokens may be agent-scoped and invalid for account RPC.
  // Retry with no bearer to allow unauthenticated local dev routing.
  if (mode === "lite" && attempts[0].bearer) {
    attempts.push({ bearer: "", accountId: `${accountId ?? ""}`.trim() });
  }
  for (const attempt of attempts) {
    const args = ["--json", "--api", apiUrl];
    const env = { ...process.env };
    if (attempt.bearer) args.push("--bearer", attempt.bearer);
    if (!attempt.bearer) env.COCALC_BEARER_TOKEN = " ";
    if (attempt.accountId) args.push("--account-id", attempt.accountId);
    if (hubPassword) args.push("--hub-password", hubPassword);
    args.push("browser", "session", "list");
    const res = run("cocalc", args, { env });
    if (res.status !== 0) continue;
    const browserId = parseBrowserIdFromResult(res.stdout || "");
    if (browserId) return browserId;
  }
  return undefined;
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
  if (meta.prependPath && `${meta.prependPath}`.trim()) {
    console.log(`export PATH=${shellEscape(`${meta.prependPath}`.trim())}:"$PATH"`);
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
  const hubStatusInfo = mode === "hub" ? parseHubStatusInfo(daemon.statusText) : undefined;
  const hubDbContext = mode === "hub" ? resolveHubProjectAndAccount(hubStatusInfo) : {};
  const hubPassword = mode === "hub" ? resolveHubPassword(hubStatusInfo) : "";
  const auth = getAuthConfig();
  const profile = chooseProfileForApi(auth.profiles, auth.current, source.apiUrl);

  const apiUrl = source.apiUrl || `${process.env.COCALC_API_URL ?? ""}`.trim();
  if (!apiUrl) {
    throw new Error(`unable to resolve COCALC_API_URL for ${mode}`);
  }

  // For lite, only use daemon connection token (never agent_token, never profile/env bearer).
  // agent_token is ACP-scoped and can break account RPC auth.
  const liteConnectionBearer = `${mode === "lite" ? source.connectionInfo?.token ?? "" : ""}`.trim();
  const explicitBearer =
    mode === "hub" ? "" : `${process.env.COCALC_BEARER_TOKEN ?? ""}`.trim();
  const profileBearer = mode === "hub" ? "" : `${profile?.bearer ?? ""}`.trim();
  const bearer =
    mode === "lite" ? liteConnectionBearer : explicitBearer || profileBearer || "";

  // Export a whitespace sentinel when bearer is empty so downstream CLI
  // does not silently fall back to auth-profile bearer.
  const bearerExport = !bearer ? " " : bearer;

  const accountId =
    `${mode === "lite" ? source.connectionInfo?.account_id ?? "" : ""}`.trim() ||
    `${mode === "hub" ? hubDbContext.accountId ?? "" : ""}`.trim() ||
    `${process.env.COCALC_ACCOUNT_ID ?? ""}`.trim() ||
    `${profile?.account_id ?? ""}`.trim() ||
    "";

  const projectId =
    `${mode === "hub" ? hubDbContext.projectId ?? "" : ""}`.trim() ||
    `${process.env.COCALC_PROJECT_ID ?? ""}`.trim() ||
    LOCAL_PROJECT_ID;

  const envBrowserId = `${process.env.COCALC_BROWSER_ID ?? ""}`.trim();
  const profileBrowserId = `${profile?.browser_id ?? ""}`.trim();
  let browserId = envBrowserId || profileBrowserId;
  if (withBrowser) {
    const discoveredBrowserId = getBrowserId({
      apiUrl,
      bearer: bearerExport,
      accountId,
      mode,
      hubPassword,
    });
    // With --with-browser, prefer fresh discovery and avoid exporting stale ids.
    browserId = discoveredBrowserId || "";
  }

  const exportsMap = {
    COCALC_API_URL: apiUrl,
    COCALC_BEARER_TOKEN: bearerExport,
    COCALC_ACCOUNT_ID: accountId,
    COCALC_PROJECT_ID: projectId,
    COCALC_BROWSER_ID: browserId,
    COCALC_DEV_ENV_MODE: mode,
  };
  let prependPath = "";
  if (fs.existsSync(LOCAL_CLI_BIN) && fs.existsSync(LOCAL_CLI_BIN_DIR)) {
    prependPath = LOCAL_CLI_BIN_DIR;
    exportsMap.COCALC_CLI_BIN = LOCAL_CLI_BIN;
  }
  if (mode === "lite" && source.connectionPath) {
    exportsMap.COCALC_LITE_CONNECTION_INFO = source.connectionPath;
  }
  if (mode === "hub" && hubPassword) {
    exportsMap.COCALC_HUB_PASSWORD = hubPassword;
  }

  const payload = {
    mode,
    started_daemon: daemon.started,
    daemon_running: daemon.running,
    api_url: apiUrl,
    has_bearer: !!`${bearer}`.trim(),
    has_hub_password: !!`${hubPassword}`.trim(),
    has_account_id: !!accountId,
    project_id: projectId,
    browser_id: browserId || undefined,
    cli_bin: exportsMap.COCALC_CLI_BIN || undefined,
    path_prepend: prependPath || undefined,
    exports: exportsMap,
    auth_config_path: auth.path,
  };

  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (shell) {
    emitShell(exportsMap, {
      mode,
      startedDaemon: daemon.started,
      running: daemon.running,
      prependPath,
    });
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
