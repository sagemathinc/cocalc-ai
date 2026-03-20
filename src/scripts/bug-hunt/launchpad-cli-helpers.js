#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_HUB_DAEMON_ENV = path.join(ROOT, ".local", "hub-daemon.env");
const DEFAULT_LOCAL_POSTGRES_ENV = path.join(
  ROOT,
  "data",
  "app",
  "postgres",
  "local-postgres.env",
);
const DEFAULT_CONAT_PASSWORD = path.join(
  ROOT,
  "data",
  "app",
  "postgres",
  "secrets",
  "conat-password",
);

function normalizeApiUrl(raw) {
  const value = `${raw ?? ""}`.trim();
  if (!value) {
    throw new Error("empty api url");
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/+$/, "");
  }
  return `http://${value.replace(/\/+$/, "")}`;
}

function readShellEnvFile(file) {
  if (!file || !fs.existsSync(file)) {
    return {};
  }
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length)
      : trimmed;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveApiUrl(options = {}) {
  if (`${options.apiUrl ?? ""}`.trim()) {
    return normalizeApiUrl(options.apiUrl);
  }
  const daemonEnv = readShellEnvFile(DEFAULT_HUB_DAEMON_ENV);
  if (`${daemonEnv.HUB_PORT ?? ""}`.trim()) {
    return `http://127.0.0.1:${`${daemonEnv.HUB_PORT}`.trim()}`;
  }
  const ambient =
    process.env.COCALC_API_URL ||
    process.env.SMOKE_API_URL ||
    process.env.BASE_URL;
  if (ambient) {
    return normalizeApiUrl(ambient);
  }
  return "http://127.0.0.1:9100";
}

function applyLocalPostgresEnv(envFile = DEFAULT_LOCAL_POSTGRES_ENV) {
  const values = readShellEnvFile(envFile);
  for (const key of [
    "DATA",
    "COCALC_DATA_DIR",
    "SECRETS",
    "COCALC_SECRET_SETTINGS_KEY_PATH",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
  ]) {
    if (`${values[key] ?? ""}`.trim()) {
      process.env[key] = `${values[key]}`.trim();
    }
  }
  return values;
}

function resolveHubPassword(explicit) {
  const trimmedExplicit = `${explicit ?? ""}`.trim();
  if (trimmedExplicit) return trimmedExplicit;
  const envValue = `${process.env.COCALC_HUB_PASSWORD ?? ""}`.trim();
  if (envValue) return envValue;
  const secretsDir = `${process.env.SECRETS ?? ""}`.trim();
  if (secretsDir) {
    const candidate = path.join(secretsDir, "conat-password");
    if (fs.existsSync(candidate)) return candidate;
  }
  if (fs.existsSync(DEFAULT_CONAT_PASSWORD)) {
    return DEFAULT_CONAT_PASSWORD;
  }
  return "";
}

function resolveCliPath(cliPath) {
  const explicit = `${cliPath ?? ""}`.trim();
  if (explicit) return explicit;
  const candidate = path.join(
    ROOT,
    "packages",
    "cli",
    "dist",
    "bin",
    "cocalc.js",
  );
  if (!fs.existsSync(candidate)) {
    throw new Error(
      "cli build output is missing; run 'cd src/packages/cli && pnpm tsc --build'",
    );
  }
  return candidate;
}

function parseJsonPayload(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : `${err}`;
    throw new Error(`failed to parse ${label}: ${detail}`);
  }
}

function runCliJson(
  {
    apiUrl,
    hubPassword,
    accountId,
    timeout = "15m",
    rpcTimeout = "",
    cliPath,
    cwd = ROOT,
    env = process.env,
  },
  args,
) {
  const fullArgs = [
    resolveCliPath(cliPath),
    "--json",
    "--api",
    resolveApiUrl({ apiUrl }),
    "--timeout",
    timeout,
  ];
  if (`${rpcTimeout ?? ""}`.trim()) {
    fullArgs.push("--rpc-timeout", `${rpcTimeout}`.trim());
  }
  const password = resolveHubPassword(hubPassword);
  if (password) {
    fullArgs.push("--hub-password", password);
  }
  if (`${accountId ?? ""}`.trim()) {
    fullArgs.push("--account-id", `${accountId}`.trim());
  }
  fullArgs.push(...args);
  const result = cp.spawnSync(process.execPath, fullArgs, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = `${result.stdout ?? ""}`.trim();
  const stderr = `${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    if (stderr.startsWith("{")) {
      const payload = parseJsonPayload(stderr, "cli stderr");
      throw new Error(payload.error?.message ?? stderr);
    }
    throw new Error(
      stderr || stdout || `cli exited with code ${result.status}`,
    );
  }
  const payload = parseJsonPayload(stdout, "cli stdout");
  if (payload.ok === false) {
    throw new Error(payload.error?.message ?? "cli command failed");
  }
  return payload.data;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createRunDir(root, now = Date.now()) {
  return path.join(root, new Date(now).toISOString().replace(/[:.]/g, "-"));
}

function writeTempFile(prefix, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const file = path.join(dir, "payload.txt");
  fs.writeFileSync(file, contents);
  return { dir, file };
}

module.exports = {
  ROOT,
  applyLocalPostgresEnv,
  createRunDir,
  readShellEnvFile,
  resolveApiUrl,
  resolveCliPath,
  resolveHubPassword,
  runCliJson,
  writeJson,
  writeTempFile,
};
