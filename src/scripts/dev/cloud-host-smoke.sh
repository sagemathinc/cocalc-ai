#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HUB_DAEMON="$SCRIPT_DIR/hub-daemon.sh"
CONFIG_FILE="${COCALC_HUB_DAEMON_CONFIG:-$SRC_DIR/.local/hub-daemon.env}"

if [ ! -x "$HUB_DAEMON" ]; then
  echo "missing executable: $HUB_DAEMON" >&2
  exit 1
fi

SMOKE_REQUIRE_EXISTING_CONFIG="${SMOKE_REQUIRE_EXISTING_CONFIG:-0}"
if [ ! -f "$CONFIG_FILE" ]; then
  "$HUB_DAEMON" init
  if [ "$SMOKE_REQUIRE_EXISTING_CONFIG" = "1" ]; then
    echo "edit config first: $CONFIG_FILE" >&2
    exit 1
  fi
  echo "using generated config: $CONFIG_FILE"
fi

# shellcheck source=/dev/null
source "$CONFIG_FILE"

SMOKE_BUILD_BUNDLES="${SMOKE_BUILD_BUNDLES:-1}"
SMOKE_BUILD_SERVER="${SMOKE_BUILD_SERVER:-1}"
SMOKE_BUILD_HUB="${SMOKE_BUILD_HUB:-1}"
SMOKE_BUILD_CLI="${SMOKE_BUILD_CLI:-1}"
SMOKE_RESTART_HUB="${SMOKE_RESTART_HUB:-1}"
SMOKE_HUB_READY_TIMEOUT_SEC="${SMOKE_HUB_READY_TIMEOUT_SEC:-30}"
SMOKE_HUB_READY_INTERVAL_SEC="${SMOKE_HUB_READY_INTERVAL_SEC:-1}"

SMOKE_CLOUD_PROVIDERS="${SMOKE_CLOUD_PROVIDERS:-gcp}"
SMOKE_CLOUD_EXECUTION_MODE="${SMOKE_CLOUD_EXECUTION_MODE:-cli}"
SMOKE_CLOUD_CLEANUP_SUCCESS="${SMOKE_CLOUD_CLEANUP_SUCCESS:-1}"
SMOKE_CLOUD_CLEANUP_FAILURE="${SMOKE_CLOUD_CLEANUP_FAILURE:-1}"
SMOKE_CLOUD_VERIFY_BACKUP="${SMOKE_CLOUD_VERIFY_BACKUP:-1}"
SMOKE_CLOUD_VERIFY_TERMINAL="${SMOKE_CLOUD_VERIFY_TERMINAL:-1}"
SMOKE_CLOUD_VERIFY_PROXY="${SMOKE_CLOUD_VERIFY_PROXY:-1}"
SMOKE_CLOUD_VERIFY_PROVIDER_STATUS="${SMOKE_CLOUD_VERIFY_PROVIDER_STATUS:-0}"
SMOKE_CLOUD_PRINT_DEBUG_HINTS="${SMOKE_CLOUD_PRINT_DEBUG_HINTS:-1}"
SMOKE_CLOUD_CONTINUE_ON_FAILURE="${SMOKE_CLOUD_CONTINUE_ON_FAILURE:-0}"
SMOKE_CLOUD_BACKUP_PREFLIGHT="${SMOKE_CLOUD_BACKUP_PREFLIGHT:-1}"
SMOKE_CLOUD_ACCOUNT_ID="${SMOKE_CLOUD_ACCOUNT_ID:-}"
SMOKE_CLOUD_PRESET="${SMOKE_CLOUD_PRESET:-}"
SMOKE_CLOUD_PROXY_PORT="${SMOKE_CLOUD_PROXY_PORT:-}"

if [ "$SMOKE_BUILD_BUNDLES" = "1" ]; then
  echo "building local project-host and project bundles..."
  pnpm --dir "$SRC_DIR/packages/project-host" build:bundle
  pnpm --dir "$SRC_DIR/packages/project" build:bundle
  if [ ! -f "$SRC_DIR/packages/project/build/tools-linux-x64.tar.xz" ] \
    && [ ! -f "$SRC_DIR/packages/project/build/tools-linux-amd64.tar.xz" ]; then
    echo "building full project tools bundle (required for project ssh/dropbear)..."
    pnpm --dir "$SRC_DIR/packages/project" build:tools
  fi
fi

if [ "$SMOKE_BUILD_SERVER" = "1" ]; then
  echo "building server package..."
  pnpm --dir "$SRC_DIR/packages/server" build
fi

if [ "$SMOKE_BUILD_HUB" = "1" ]; then
  echo "building hub package..."
  pnpm --dir "$SRC_DIR/packages/hub" build
fi

if [ "$SMOKE_BUILD_CLI" = "1" ]; then
  echo "building cli package..."
  pnpm --dir "$SRC_DIR/packages/cli" build
fi

if [ "$SMOKE_RESTART_HUB" = "1" ]; then
  "$HUB_DAEMON" restart
else
  "$HUB_DAEMON" start
fi
"$HUB_DAEMON" status

hub_base_url="http://127.0.0.1:${HUB_PORT}"
hub_ready_deadline=$(( $(date +%s) + SMOKE_HUB_READY_TIMEOUT_SEC ))
echo "cloud smoke: waiting for hub readiness at ${hub_base_url} (timeout ${SMOKE_HUB_READY_TIMEOUT_SEC}s)"
while true; do
  if HUB_BASE_URL="$hub_base_url" node -e '
    const u = new URL(process.env.HUB_BASE_URL);
    const http = require(u.protocol === "https:" ? "https" : "http");
    const req = http.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port, path: "/", method: "GET", timeout: 3000 },
      (res) => { res.resume(); process.exit(0); },
    );
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", () => process.exit(1));
    req.end();
  ' >/dev/null 2>&1; then
    break
  fi
  if [ "$(date +%s)" -ge "$hub_ready_deadline" ]; then
    echo "cloud smoke preflight: hub endpoint did not become reachable at ${hub_base_url}" >&2
    exit 1
  fi
  sleep "$SMOKE_HUB_READY_INTERVAL_SEC"
done

# Avoid leaking PG* from other repos/sessions into smoke-runner DB clients.
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
LOCAL_PG_ENV="${SMOKE_LOCAL_PG_ENV:-$SRC_DIR/data/app/postgres/local-postgres.env}"
if [ -f "$LOCAL_PG_ENV" ]; then
  # shellcheck source=/dev/null
  source "$LOCAL_PG_ENV"
else
  echo "missing local postgres env file: $LOCAL_PG_ENV" >&2
  exit 1
fi

if [ -z "${COCALC_HUB_PASSWORD:-}" ] && [ -n "${SECRETS:-}" ] && [ -f "$SECRETS/conat-password" ]; then
  export COCALC_HUB_PASSWORD="$SECRETS/conat-password"
fi

if [ -n "${COCALC_HUB_PASSWORD:-}" ]; then
  cli_ready_deadline=$(( $(date +%s) + SMOKE_HUB_READY_TIMEOUT_SEC ))
  echo "cloud smoke: waiting for CLI auth path against ${hub_base_url}"
  while true; do
    if node "$SRC_DIR/packages/cli/dist/bin/cocalc.js" \
      --json \
      --api "$hub_base_url" \
      --hub-password "$COCALC_HUB_PASSWORD" \
      --timeout 15s \
      ws list --limit 1 >/dev/null 2>&1; then
      break
    fi
    if [ "$(date +%s)" -ge "$cli_ready_deadline" ]; then
      echo "cloud smoke preflight: CLI could not authenticate to ${hub_base_url}; check HUB_PORT and hub password" >&2
      exit 1
    fi
    sleep "$SMOKE_HUB_READY_INTERVAL_SEC"
  done
fi

providers_raw="${SMOKE_CLOUD_PROVIDERS//,/ }"
providers_trimmed="$(echo "$providers_raw" | xargs)"
if [ -z "$providers_trimmed" ]; then
  echo "cloud smoke: no providers specified (set SMOKE_CLOUD_PROVIDERS)" >&2
  exit 1
fi
if [ "$providers_trimmed" = "all" ]; then
  providers_trimmed="gcp nebius hyperstack lambda"
fi

validate_provider() {
  case "$1" in
    gcp|nebius|hyperstack|lambda) ;;
    *)
      echo "cloud smoke: unsupported provider '$1' (expected gcp, nebius, hyperstack, lambda)" >&2
      exit 1
      ;;
  esac
}

run_provider_smoke() {
  local provider="$1"
  echo "cloud smoke: running provider=${provider}"
  SMOKE_PROVIDER="$provider" \
  SMOKE_CLOUD_ACCOUNT_ID="$SMOKE_CLOUD_ACCOUNT_ID" \
  SMOKE_CLOUD_PRESET="$SMOKE_CLOUD_PRESET" \
  SMOKE_CLOUD_PROXY_PORT="$SMOKE_CLOUD_PROXY_PORT" \
  SMOKE_CLOUD_CLEANUP_SUCCESS="$SMOKE_CLOUD_CLEANUP_SUCCESS" \
  SMOKE_CLOUD_CLEANUP_FAILURE="$SMOKE_CLOUD_CLEANUP_FAILURE" \
  SMOKE_CLOUD_VERIFY_BACKUP="$SMOKE_CLOUD_VERIFY_BACKUP" \
  SMOKE_CLOUD_VERIFY_TERMINAL="$SMOKE_CLOUD_VERIFY_TERMINAL" \
  SMOKE_CLOUD_VERIFY_PROXY="$SMOKE_CLOUD_VERIFY_PROXY" \
  SMOKE_CLOUD_VERIFY_PROVIDER_STATUS="$SMOKE_CLOUD_VERIFY_PROVIDER_STATUS" \
  SMOKE_CLOUD_PRINT_DEBUG_HINTS="$SMOKE_CLOUD_PRINT_DEBUG_HINTS" \
  SMOKE_CLOUD_EXECUTION_MODE="$SMOKE_CLOUD_EXECUTION_MODE" \
  pnpm --dir "$SRC_DIR/packages/server" exec node - <<'NODE'
const { runProjectHostPersistenceSmokePreset } = require("./dist/cloud/smoke-runner/project-host");

function envOptional(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envBool(name, fallback) {
  const raw = envOptional(name);
  if (raw == null) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const provider = envOptional("SMOKE_PROVIDER");
if (!provider) {
  throw new Error("SMOKE_PROVIDER is required");
}

const execution_mode = envOptional("SMOKE_CLOUD_EXECUTION_MODE") ?? "cli";
if (execution_mode !== "cli" && execution_mode !== "direct") {
  throw new Error(`invalid SMOKE_CLOUD_EXECUTION_MODE='${execution_mode}'`);
}

const presetByProvider =
  envOptional(`SMOKE_CLOUD_PRESET_${provider.toUpperCase().replace(/-/g, "_")}`) ??
  envOptional("SMOKE_CLOUD_PRESET");

const proxyPortRaw = envOptional("SMOKE_CLOUD_PROXY_PORT");
const proxyPort = proxyPortRaw == null ? undefined : Number(proxyPortRaw);
if (proxyPortRaw != null && !Number.isFinite(proxyPort)) {
  throw new Error(`invalid SMOKE_CLOUD_PROXY_PORT='${proxyPortRaw}'`);
}

const opts = {
  account_id: envOptional("SMOKE_CLOUD_ACCOUNT_ID"),
  provider,
  preset: presetByProvider,
  cleanup_on_success: envBool("SMOKE_CLOUD_CLEANUP_SUCCESS", true),
  verify_backup: envBool("SMOKE_CLOUD_VERIFY_BACKUP", true),
  verify_terminal: envBool("SMOKE_CLOUD_VERIFY_TERMINAL", true),
  verify_proxy: envBool("SMOKE_CLOUD_VERIFY_PROXY", true),
  verify_provider_status: envBool("SMOKE_CLOUD_VERIFY_PROVIDER_STATUS", false),
  execution_mode,
  proxy_port: proxyPort,
  print_debug_hints: envBool("SMOKE_CLOUD_PRINT_DEBUG_HINTS", true),
  log: (event) => {
    const suffix = event?.message ? ` - ${event.message}` : "";
    console.log(`[smoke:${provider}] ${event.step} ${event.status}${suffix}`);
  },
};

async function runCliCleanup(label, args) {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const run = promisify(execFile);
  const nodePath = process.execPath;
  const cliPath = require("node:path").join(process.cwd(), "../cli/dist/bin/cocalc.js");
  const timeout = envOptional("SMOKE_CLOUD_CLI_CLEANUP_TIMEOUT") ?? "1200s";
  const rpcTimeout = envOptional("SMOKE_CLOUD_CLI_CLEANUP_RPC_TIMEOUT") ?? "300s";
  const full = [
    cliPath,
    "--json",
    "--no-daemon",
    "--api",
    process.env.BASE_URL || process.env.COCALC_API_URL || "http://127.0.0.1:9100",
    "--timeout",
    timeout,
    "--rpc-timeout",
    rpcTimeout,
    "--poll-ms",
    "1000ms",
  ];
  if (opts.account_id) {
    full.push("--account-id", opts.account_id);
  }
  const hubPassword = process.env.COCALC_HUB_PASSWORD;
  if (hubPassword && hubPassword.trim()) {
    full.push("--hub-password", hubPassword.trim());
  }
  full.push(...args);
  try {
    const { stdout, stderr } = await run(nodePath, full, {
      timeout: 20 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if ((stdout || "").trim()) console.log(`[smoke:${provider}] cleanup ${label}: ${stdout.trim()}`);
    if ((stderr || "").trim()) console.log(`[smoke:${provider}] cleanup ${label} stderr: ${stderr.trim()}`);
    return true;
  } catch (err) {
    const e = err || {};
    const msg = e.message || String(e);
    const stdout = (e.stdout || "").toString().trim();
    const stderr = (e.stderr || "").toString().trim();
    console.error(`[smoke:${provider}] cleanup ${label} failed: ${msg}`);
    if (stdout) console.error(`[smoke:${provider}] cleanup ${label} stdout: ${stdout}`);
    if (stderr) console.error(`[smoke:${provider}] cleanup ${label} stderr: ${stderr}`);
    return false;
  }
}

(async () => {
  console.log(`[smoke:${provider}] starting ${new Date().toISOString()}`);
  const result = await runProjectHostPersistenceSmokePreset(opts);
  console.log(`[smoke:${provider}] finished ok=${result.ok}`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && envBool("SMOKE_CLOUD_CLEANUP_FAILURE", true)) {
    if (result.project_id) {
      const hardDeleted = await runCliCleanup("workspace-delete-hard", [
        "workspace",
        "delete",
        "--workspace",
        result.project_id,
        "--hard",
        "--yes",
        "--wait",
      ]);
      if (!hardDeleted) {
        await runCliCleanup("workspace-delete-soft-fallback", [
          "workspace",
          "delete",
          "--workspace",
          result.project_id,
        ]);
      }
    }
    if (result.host_id) {
      await runCliCleanup("host-delete", [
        "host",
        "delete",
        result.host_id,
        "--skip-backups",
        "--wait",
      ]);
    }
  }
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  console.error(`[smoke:${provider}] fatal error`);
  console.error(err?.stack || String(err));
  process.exit(1);
});
NODE
}

run_backup_preflight() {
  if [ "$SMOKE_CLOUD_VERIFY_BACKUP" != "1" ] || [ "$SMOKE_CLOUD_BACKUP_PREFLIGHT" != "1" ]; then
    return 0
  fi
  echo "cloud smoke: backup preflight (R2 credentials/token)"
  SMOKE_API_URL="$hub_base_url" \
  pnpm --dir "$SRC_DIR/packages/server" exec node - <<'NODE'
const { execFileSync } = require("node:child_process");
const getPool = require("@cocalc/database/pool").default;
const { getServerSettings } = require("@cocalc/database/settings/server-settings");

function fail(msg) {
  console.error(`cloud smoke preflight: ${msg}`);
  process.exit(1);
}

(async () => {
  const settings = await getServerSettings();
  const accountId = `${settings.r2_account_id ?? ""}`.trim();
  const apiToken = `${settings.r2_api_token ?? ""}`.trim();
  const accessKey = `${settings.r2_access_key_id ?? ""}`.trim();
  const secretKey = `${settings.r2_secret_access_key ?? ""}`.trim();
  if (!accountId || !accessKey || !secretKey) {
    fail("missing R2 S3 credentials (r2_account_id / r2_access_key_id / r2_secret_access_key)");
  }
  if (!apiToken) {
    fail("missing R2 API token (r2_api_token); unable to ensure backup bucket setup");
  }

  const apiRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!apiRes.ok) {
    const body = await apiRes.text();
    fail(
      `R2 API token auth failed: status=${apiRes.status} account=${accountId} body=${body.slice(0, 220)}`,
    );
  }

  const { rows } = await getPool().query(
    "SELECT name, endpoint FROM buckets WHERE provider='r2' AND purpose='project-backups' ORDER BY created DESC LIMIT 1",
  );
  if (!rows[0]?.name) {
    console.log("cloud smoke preflight: no existing backup bucket row yet; token auth ok");
    return;
  }

  const bucketName = rows[0].name;
  const endpoint =
    `${rows[0].endpoint ?? ""}`.trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  try {
    execFileSync(
      "aws",
      [
        "--endpoint-url",
        endpoint,
        "s3api",
        "head-bucket",
        "--bucket",
        bucketName,
      ],
      {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: accessKey,
          AWS_SECRET_ACCESS_KEY: secretKey,
          AWS_DEFAULT_REGION: "us-east-1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    const stderr = (err?.stderr || "").toString().trim();
    const stdout = (err?.stdout || "").toString().trim();
    const details = (stderr || stdout || err?.message || String(err)).slice(0, 260);
    fail(
      `R2 S3 credentials auth failed for bucket '${bucketName}' endpoint='${endpoint}': ${details}`,
    );
  }
  console.log(
    `cloud smoke preflight: R2 auth ok (account=${accountId}, bucket=${bucketName})`,
  );
})().catch((err) => fail(err?.stack || String(err)));
NODE
}

run_backup_preflight

overall_status=0
for provider in $providers_trimmed; do
  validate_provider "$provider"
  if ! run_provider_smoke "$provider"; then
    overall_status=1
    if [ "$SMOKE_CLOUD_CONTINUE_ON_FAILURE" != "1" ]; then
      echo "cloud smoke: provider '${provider}' failed (stopping)" >&2
      exit 1
    fi
    echo "cloud smoke: provider '${provider}' failed (continuing)" >&2
  fi
done

if [ "$overall_status" -eq 0 ]; then
  echo "cloud smoke: all requested providers passed (${providers_trimmed})"
else
  echo "cloud smoke: one or more providers failed (${providers_trimmed})" >&2
fi

exit "$overall_status"
