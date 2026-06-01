#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SRC_ROOT}/.." && pwd)"

REMOTE=""
BUNDLE_PATH=""
BUILD_BUNDLE=0
API_URL=""
PUBLIC_URL=""
BAY_ID="bay-0"
BAY_USER="cocalc-bay"
WORKER_COUNT=2
RETAIN_RELEASES=3
REMOTE_PSQL="/usr/lib/postgresql/16/bin/psql"
REMOTE_PGHOST="/mnt/cocalc/bays/bay-0/run/postgres"
REMOTE_PGPORT="5432"
REMOTE_PGUSER="cocalc-bay"
REMOTE_PGDATABASE="cocalc-bay"
ADMIN_ACCOUNT_ID=""
ADMIN_EMAIL=""
COOKIE_HEADER=""
SKIP_HOST_UPGRADE=0
KEEP_REMOTE_ARTIFACTS=0
CLEANUP_LOCAL_BUNDLE=0
REPORT_DIR=""
CLI_PATH="${SRC_ROOT}/packages/cli/dist/bin/cocalc.js"

REMOTE_WORK_DIR=""
REMOTE_BUNDLE=""
REMOTE_SCRIPT_DIR=""
TEMP_COOKIE_FILE=""
TEMP_COOKIE_HASH_B64=""
CREATED_TEMP_COOKIE=0

usage() {
  cat <<'EOF'
Usage: upgrade-bay-release.sh --remote <ssh-target> --api <url> (--bundle <tarball> | --build-bundle) [options]

Upgrade a one-VM systemd bay from a packaged Rocket bay runtime bundle, then
optionally upgrade all online project hosts through the site's CLI API.

This is an operational wrapper around the proven manual lifecycle:
  1. copy bay-systemd scaffold and runtime tarball to the VM
  2. stage a versioned release with bay-bootstrap-release.sh
  3. restart bay services and run bay-health
  4. run cocalc host upgrade --all-online --wait
  5. verify project_hosts software/rollout state
  6. remove temporary auth/session and upload artifacts

Required:
  --remote <ssh-target>       SSH target, e.g. ubuntu@10.206.15.209
  --api <url>                 public API URL, e.g. https://delta.cocalc.ai
  --bundle <tarball>          local cocalc-bay-runtime-linux-x64.tar.xz
    or
  --build-bundle              build the bundle before upgrading

Auth for project-host upgrade:
  --cookie <header>           existing Cookie header for CLI auth
    or
  --admin-account-id <uuid>   create a short-lived remember_me session
    or
  --admin-email <email>       resolve account_id on the bay, then create session

Options:
  --public-url <url>          public bay URL for release env (default: --api)
  --bay-id <id>               bay id (default: bay-0)
  --bay-user <user>           bay service/db user (default: cocalc-bay)
  --worker-count <n>          hub worker count (default: 2)
  --retain-releases <n>       release retention passed to bootstrap (default: 3)
  --remote-psql <path>        remote psql path (default: /usr/lib/postgresql/16/bin/psql)
  --remote-pghost <path>      remote Postgres socket dir
  --remote-pgport <n>         remote Postgres port (default: 5432)
  --remote-pguser <user>      remote Postgres user (default: cocalc-bay)
  --remote-pgdatabase <db>    remote Postgres database (default: cocalc-bay)
  --cli <path>                local cocalc CLI path
  --report-dir <dir>          write JSON/text reports here
  --skip-host-upgrade         only upgrade bay services
  --keep-remote-artifacts     leave uploaded /tmp artifacts on the VM
  --cleanup-local-bundle      remove the local bundle after upload
  -h, --help                  show help
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

q() {
  printf "%q" "$1"
}

remote_exec() {
  ssh "$REMOTE" "$@"
}

remote_psql() {
  local flags="$1"
  shift || true
  ssh "$REMOTE" \
    "sudo runuser -u $(q "$BAY_USER") -- env PGHOST=$(q "$REMOTE_PGHOST") PGPORT=$(q "$REMOTE_PGPORT") PGUSER=$(q "$REMOTE_PGUSER") PGDATABASE=$(q "$REMOTE_PGDATABASE") $(q "$REMOTE_PSQL") ${flags}"
}

sql_escape_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

cleanup() {
  local status=$?
  if [[ "$CREATED_TEMP_COOKIE" -eq 1 && -n "$TEMP_COOKIE_HASH_B64" && -n "$REMOTE" ]]; then
    remote_psql "-v ON_ERROR_STOP=1 -q" <<SQL >/dev/null 2>&1 || true
DELETE FROM remember_me
 WHERE hash = convert_from(decode('${TEMP_COOKIE_HASH_B64}', 'base64'), 'UTF8')::CHAR(127);
SQL
  fi
  if [[ -n "$TEMP_COOKIE_FILE" ]]; then
    rm -f "$TEMP_COOKIE_FILE"
  fi
  if [[ "$KEEP_REMOTE_ARTIFACTS" -eq 0 && -n "$REMOTE_WORK_DIR" && -n "$REMOTE" ]]; then
    remote_exec "sudo rm -rf $(q "$REMOTE_WORK_DIR")" >/dev/null 2>&1 || true
  fi
  if [[ "$CLEANUP_LOCAL_BUNDLE" -eq 1 && -n "$BUNDLE_PATH" ]]; then
    rm -f "$BUNDLE_PATH"
  fi
  exit "$status"
}
trap cleanup EXIT

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --remote)
        REMOTE="$2"; shift 2 ;;
      --bundle)
        BUNDLE_PATH="$2"; shift 2 ;;
      --build-bundle)
        BUILD_BUNDLE=1; shift ;;
      --api)
        API_URL="$2"; shift 2 ;;
      --public-url)
        PUBLIC_URL="$2"; shift 2 ;;
      --bay-id)
        BAY_ID="$2"; shift 2 ;;
      --bay-user)
        BAY_USER="$2"; shift 2 ;;
      --worker-count)
        WORKER_COUNT="$2"; shift 2 ;;
      --retain-releases)
        RETAIN_RELEASES="$2"; shift 2 ;;
      --remote-psql)
        REMOTE_PSQL="$2"; shift 2 ;;
      --remote-pghost)
        REMOTE_PGHOST="$2"; shift 2 ;;
      --remote-pgport)
        REMOTE_PGPORT="$2"; shift 2 ;;
      --remote-pguser)
        REMOTE_PGUSER="$2"; shift 2 ;;
      --remote-pgdatabase)
        REMOTE_PGDATABASE="$2"; shift 2 ;;
      --admin-account-id)
        ADMIN_ACCOUNT_ID="$2"; shift 2 ;;
      --admin-email)
        ADMIN_EMAIL="$2"; shift 2 ;;
      --cookie)
        COOKIE_HEADER="$2"; shift 2 ;;
      --cli)
        CLI_PATH="$2"; shift 2 ;;
      --report-dir)
        REPORT_DIR="$2"; shift 2 ;;
      --skip-host-upgrade)
        SKIP_HOST_UPGRADE=1; shift ;;
      --keep-remote-artifacts)
        KEEP_REMOTE_ARTIFACTS=1; shift ;;
      --cleanup-local-bundle)
        CLEANUP_LOCAL_BUNDLE=1; shift ;;
      -h|--help)
        usage; exit 0 ;;
      *)
        die "unknown argument: $1" ;;
    esac
  done
}

validate_args() {
  [[ -n "$REMOTE" ]] || die "--remote is required"
  [[ -n "$API_URL" ]] || die "--api is required"
  if [[ "$BUILD_BUNDLE" -eq 1 && -n "$BUNDLE_PATH" ]]; then
    die "use either --bundle or --build-bundle, not both"
  fi
  if [[ "$BUILD_BUNDLE" -eq 0 && -z "$BUNDLE_PATH" ]]; then
    die "specify --bundle or --build-bundle"
  fi
  if [[ "$SKIP_HOST_UPGRADE" -eq 0 ]]; then
    if [[ -z "$COOKIE_HEADER" && -z "$ADMIN_ACCOUNT_ID" && -z "$ADMIN_EMAIL" ]]; then
      die "host upgrade needs --cookie, --admin-account-id, --admin-email, or --skip-host-upgrade"
    fi
  fi
  if [[ -z "$PUBLIC_URL" ]]; then
    PUBLIC_URL="$API_URL"
  fi
  if [[ -z "$REPORT_DIR" ]]; then
    REPORT_DIR="${REPO_ROOT}/tmp/bay-upgrade-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
}

build_bundle() {
  log "Build bay runtime bundle"
  (cd "$REPO_ROOT" && pnpm -C src/packages --filter @cocalc/rocket run build:bay-bundle)
  BUNDLE_PATH="${SRC_ROOT}/packages/rocket/build/cocalc-bay-runtime-linux-x64.tar.xz"
}

stage_release() {
  [[ -f "$BUNDLE_PATH" ]] || die "bundle not found: $BUNDLE_PATH"
  mkdir -p "$REPORT_DIR"
  cp "${SRC_ROOT}/packages/rocket/build/bay-runtime/bay-runtime-manifest.json" \
    "${REPORT_DIR}/bay-runtime-manifest.json" 2>/dev/null || true

  REMOTE_WORK_DIR="/tmp/cocalc-bay-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  REMOTE_BUNDLE="${REMOTE_WORK_DIR}/cocalc-bay-runtime-linux-x64.tar.xz"
  REMOTE_SCRIPT_DIR="${REMOTE_WORK_DIR}/bay-systemd"

  log "Upload bay scaffold and bundle to ${REMOTE}:${REMOTE_WORK_DIR}"
  remote_exec "sudo rm -rf $(q "$REMOTE_WORK_DIR") && mkdir -p $(q "$REMOTE_WORK_DIR")"
  scp -r "$SCRIPT_DIR" "$REMOTE:${REMOTE_SCRIPT_DIR}"
  scp "$BUNDLE_PATH" "$REMOTE:${REMOTE_BUNDLE}"

  log "Stage bay release"
  remote_exec "sudo $(q "${REMOTE_SCRIPT_DIR}/bay-bootstrap-release.sh") --bundle $(q "$REMOTE_BUNDLE") --bay-id $(q "$BAY_ID") --worker-count $(q "$WORKER_COUNT") --public-url $(q "$PUBLIC_URL") --force-overlay --retain-releases $(q "$RETAIN_RELEASES") --start" \
    | tee "${REPORT_DIR}/stage-release.log"
}

restart_and_health_check() {
  log "Restart bay services and run health checks"
  remote_exec "sudo systemctl daemon-reload && sudo systemctl restart cocalc-bay-postgres.service cocalc-bay-migrations.service cocalc-bay-conat-router.service cocalc-bay-conat-persist.service cocalc-bay-hub@1.service cocalc-bay-hub@2.service && sudo /opt/cocalc/bay/current/bin/bay-status && sudo /opt/cocalc/bay/current/bin/bay-health" \
    | tee "${REPORT_DIR}/bay-health.txt"
}

resolve_admin_account_id() {
  if [[ -n "$ADMIN_ACCOUNT_ID" ]]; then
    return
  fi
  local email_sql
  email_sql="$(sql_escape_literal "$ADMIN_EMAIL")"
  ADMIN_ACCOUNT_ID="$(
    remote_psql "-Atq" <<SQL
SELECT account_id
  FROM accounts
 WHERE lower(email_address) = lower('${email_sql}')
 ORDER BY created DESC NULLS LAST
 LIMIT 1;
SQL
  )"
  [[ -n "$ADMIN_ACCOUNT_ID" ]] || die "no account found for --admin-email ${ADMIN_EMAIL}"
}

create_temp_cookie() {
  [[ -z "$COOKIE_HEADER" ]] || return
  resolve_admin_account_id
  TEMP_COOKIE_FILE="$(mktemp)"
  log "Create short-lived CLI auth session for ${ADMIN_ACCOUNT_ID}"
  SRC_ROOT="$SRC_ROOT" ADMIN_ACCOUNT_ID="$ADMIN_ACCOUNT_ID" COOKIE_FILE="$TEMP_COOKIE_FILE" node <<'NODE'
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { createRequire } = require("module");

const srcRoot = process.env.SRC_ROOT;
const account_id = process.env.ADMIN_ACCOUNT_ID;
const cookieFile = process.env.COOKIE_FILE;
const requireFromBackend = createRequire(
  path.join(srcRoot, "packages/backend/package.json"),
);
const { generate } = requireFromBackend("password-hash");

const session_id = randomUUID();
const hash_session_id = generate(session_id, {
  algorithm: "sha512",
  saltLength: 32,
  iterations: 1000,
});
const parts = hash_session_id.split("$");
const value = [parts[0], parts[1], parts[2], session_id].join("$");
const hash = hash_session_id.slice(0, 127);
fs.writeFileSync(cookieFile, JSON.stringify({ account_id, value, hash }, null, 2));
NODE
  TEMP_COOKIE_HASH_B64="$(
    COOKIE_FILE="$TEMP_COOKIE_FILE" node <<'NODE'
const fs = require("fs");
const cookie = JSON.parse(fs.readFileSync(process.env.COOKIE_FILE, "utf8"));
process.stdout.write(Buffer.from(cookie.hash).toString("base64"));
NODE
  )"
  remote_psql "-v ON_ERROR_STOP=1 -q" <<SQL
INSERT INTO remember_me(hash, expire, account_id)
VALUES (
  convert_from(decode('${TEMP_COOKIE_HASH_B64}', 'base64'), 'UTF8')::TEXT,
  NOW() + INTERVAL '20 minutes',
  '${ADMIN_ACCOUNT_ID}'::UUID
);
SQL
  CREATED_TEMP_COOKIE=1
  local cookie_value
  cookie_value="$(
    COOKIE_FILE="$TEMP_COOKIE_FILE" node <<'NODE'
const fs = require("fs");
const cookie = JSON.parse(fs.readFileSync(process.env.COOKIE_FILE, "utf8"));
process.stdout.write(cookie.value);
NODE
  )"
  COOKIE_HEADER="remember_me=${cookie_value}"
}

upgrade_project_hosts() {
  if [[ "$SKIP_HOST_UPGRADE" -ne 0 ]]; then
    log "Skip project host upgrade"
    return 0
  fi
  [[ -x "$CLI_PATH" || -f "$CLI_PATH" ]] || die "cocalc CLI not found: $CLI_PATH"
  create_temp_cookie

  log "Upgrade all online project hosts and wait"
  "$CLI_PATH" \
    --api "$API_URL" \
    --disable-env-auth-defaults \
    --cookie "$COOKIE_HEADER" \
    host upgrade \
    --hub-source \
    --all-online \
    --artifact project-host project tools bootstrap-environment \
    --align-runtime-stack \
    --wait \
    --output json \
    | tee "${REPORT_DIR}/host-upgrade.json"
}

verify_project_hosts() {
  if [[ "$SKIP_HOST_UPGRADE" -ne 0 ]]; then
    log "Skip project host software verification"
    return 0
  fi
  log "Verify project host software state"
  remote_psql "-Atq" <<'SQL' | tee "${REPORT_DIR}/project-host-software.txt"
SELECT
  name || '|' ||
  COALESCE(version, '') || '|' ||
  COALESCE((metadata->'software')::text, '') || '|' ||
  COALESCE((metadata->'host_agent'->'project_host')::text, '')
FROM project_hosts
WHERE deleted IS NULL
ORDER BY name;
SQL
}

main() {
  parse_args "$@"
  validate_args
  require_cmd ssh
  require_cmd scp
  require_cmd node
  if [[ "$BUILD_BUNDLE" -eq 1 ]]; then
    require_cmd pnpm
  fi
  mkdir -p "$REPORT_DIR"

  if [[ "$BUILD_BUNDLE" -eq 1 ]]; then
    build_bundle
  fi

  log "Upgrade target"
  cat <<EOF | tee "${REPORT_DIR}/upgrade-target.txt"
remote=${REMOTE}
api=${API_URL}
public_url=${PUBLIC_URL}
bay_id=${BAY_ID}
bundle=${BUNDLE_PATH}
report_dir=${REPORT_DIR}
EOF

  stage_release
  restart_and_health_check
  upgrade_project_hosts
  verify_project_hosts

  log "Upgrade complete"
  echo "report_dir=${REPORT_DIR}"
}

main "$@"
