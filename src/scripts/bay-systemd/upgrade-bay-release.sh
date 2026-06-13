#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SRC_ROOT}/.." && pwd)"

REMOTE=""
BUNDLE_PATH=""
HOST_SOFTWARE_BUNDLE_PATH=""
BUILD_BUNDLE=0
BUILD_HOST_SOFTWARE_BUNDLE=0
STATIC_ONLY=0
RESTART_HUB_WORKERS=0
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
REMOTE_HOST_SOFTWARE_BUNDLE=""
REMOTE_SCRIPT_DIR=""
TEMP_COOKIE_FILE=""
TEMP_COOKIE_HASH_B64=""
CREATED_TEMP_COOKIE=0
TEMP_COOKIE_TTL="2 hours"

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
  --bundle <tarball>          local cocalc-bay-runtime-linux-x64.tar.xz, or
                              cocalc-bay-static-linux-*.tar.xz with --static-only
    or
  --build-bundle              build the bundle before upgrading
  --host-software-bundle <tarball>
                              local cocalc-project-host-software-linux-*.tar.xz
                              staged into current/runtime/packages before host upgrade
  --build-host-software-bundle
                              build the project-host software bundle before host upgrade
  --static-only               deploy only frontend/static assets by creating a
                              new release from the current VM release and
                              flipping the current release symlink without
                              restarting hub workers
  --restart-hub-workers       with --static-only, restart hub workers one at a
                              time after flipping the current release symlink

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
      --host-software-bundle)
        HOST_SOFTWARE_BUNDLE_PATH="$2"; shift 2 ;;
      --build-bundle)
        BUILD_BUNDLE=1; shift ;;
      --build-host-software-bundle)
        BUILD_HOST_SOFTWARE_BUNDLE=1; shift ;;
      --static-only)
        STATIC_ONLY=1; shift ;;
      --restart-hub-workers)
        RESTART_HUB_WORKERS=1; shift ;;
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
  if [[ "$BUILD_HOST_SOFTWARE_BUNDLE" -eq 1 && -n "$HOST_SOFTWARE_BUNDLE_PATH" ]]; then
    die "use either --host-software-bundle or --build-host-software-bundle, not both"
  fi
  if [[ "$BUILD_BUNDLE" -eq 0 && -z "$BUNDLE_PATH" ]]; then
    die "specify --bundle or --build-bundle"
  fi
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    SKIP_HOST_UPGRADE=1
  fi
  if [[ "$SKIP_HOST_UPGRADE" -eq 0 ]]; then
    if [[ -z "$COOKIE_HEADER" && -z "$ADMIN_ACCOUNT_ID" && -z "$ADMIN_EMAIL" ]]; then
      die "host upgrade needs --cookie, --admin-account-id, --admin-email, or --skip-host-upgrade"
    fi
    if [[ "$BUILD_BUNDLE" -eq 1 && -z "$HOST_SOFTWARE_BUNDLE_PATH" ]]; then
      BUILD_HOST_SOFTWARE_BUNDLE=1
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
  local name_glob
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    log "Build bay static/frontend bundle"
    (cd "$REPO_ROOT" && pnpm -C src/packages --filter @cocalc/rocket run build:bay-static-bundle)
    name_glob='cocalc-bay-static-linux-*.tar.xz'
  else
    log "Build bay runtime bundle"
    (cd "$REPO_ROOT" && pnpm -C src/packages --filter @cocalc/rocket run build:bay-bundle)
    name_glob='cocalc-bay-runtime-linux-*.tar.xz'
  fi
  BUNDLE_PATH="$(
    find "${SRC_ROOT}/packages/rocket/build" \
      -name "$name_glob" \
      -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | awk 'NR==1 {print $2}'
  )"
  [[ -n "$BUNDLE_PATH" && -f "$BUNDLE_PATH" ]] || die "bundle build did not produce ${name_glob}"
}

build_host_software_bundle() {
  log "Build project-host software bundle"
  (cd "$REPO_ROOT" && pnpm -C src/packages --filter @cocalc/rocket run build:project-host-software-bundle)
  HOST_SOFTWARE_BUNDLE_PATH="$(
    find "${SRC_ROOT}/packages/rocket/build" \
      -name 'cocalc-project-host-software-linux-*.tar.xz' \
      -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | awk 'NR==1 {print $2}'
  )"
  [[ -n "$HOST_SOFTWARE_BUNDLE_PATH" && -f "$HOST_SOFTWARE_BUNDLE_PATH" ]] || die "project-host software build did not produce cocalc-project-host-software-linux-*.tar.xz"
}

stage_release() {
  [[ -f "$BUNDLE_PATH" ]] || die "bundle not found: $BUNDLE_PATH"
  mkdir -p "$REPORT_DIR"
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    cp "${SRC_ROOT}/packages/rocket/build/bay-static/bay-static-manifest.json" \
      "${REPORT_DIR}/bay-static-manifest.json" 2>/dev/null || true
  else
    cp "${SRC_ROOT}/packages/rocket/build/bay-runtime/bay-runtime-manifest.json" \
      "${REPORT_DIR}/bay-runtime-manifest.json" 2>/dev/null || true
  fi

  REMOTE_WORK_DIR="/tmp/cocalc-bay-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  REMOTE_BUNDLE="${REMOTE_WORK_DIR}/$(basename "$BUNDLE_PATH")"
  REMOTE_SCRIPT_DIR="${REMOTE_WORK_DIR}/bay-systemd"

  log "Upload bay scaffold and bundle to ${REMOTE}:${REMOTE_WORK_DIR}"
  remote_exec "sudo rm -rf $(q "$REMOTE_WORK_DIR") && mkdir -p $(q "$REMOTE_WORK_DIR")"
  scp -r "$SCRIPT_DIR" "$REMOTE:${REMOTE_SCRIPT_DIR}"
  scp "$BUNDLE_PATH" "$REMOTE:${REMOTE_BUNDLE}"

  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    log "Stage bay static/frontend release"
    remote_exec "sudo $(q "${REMOTE_SCRIPT_DIR}/bay-bootstrap-release.sh") --static-bundle $(q "$REMOTE_BUNDLE") --bay-id $(q "$BAY_ID") --worker-count $(q "$WORKER_COUNT") --public-url $(q "$PUBLIC_URL") --retain-releases $(q "$RETAIN_RELEASES")" \
      | tee "${REPORT_DIR}/stage-release.log"
  else
    log "Stage bay release"
    remote_exec "sudo $(q "${REMOTE_SCRIPT_DIR}/bay-bootstrap-release.sh") --bundle $(q "$REMOTE_BUNDLE") --bay-id $(q "$BAY_ID") --worker-count $(q "$WORKER_COUNT") --public-url $(q "$PUBLIC_URL") --force-overlay --retain-releases $(q "$RETAIN_RELEASES") --start" \
      | tee "${REPORT_DIR}/stage-release.log"
  fi
}

stage_host_software() {
  if [[ "$SKIP_HOST_UPGRADE" -ne 0 ]]; then
    log "Skip project host software staging"
    return 0
  fi
  if [[ -z "$HOST_SOFTWARE_BUNDLE_PATH" ]]; then
    log "Check project-host software artifacts embedded in current bay release"
    remote_exec "sudo bash -s" <<EOF | tee "${REPORT_DIR}/stage-host-software.log"
set -euo pipefail
current="\$(readlink -f /opt/cocalc/bay/current)"
if [[ -z "\$current" || ! -d "\$current" ]]; then
  echo "current bay release does not exist: /opt/cocalc/bay/current" >&2
  exit 1
fi
missing=0
for path in \
  "\$current/runtime/packages/project-host/build/bundle-linux.tar.xz" \
  "\$current/runtime/packages/project/build/bundle-linux.tar.xz" \
  "\$current/runtime/packages/server/cloud/bootstrap/bootstrap.py"; do
  if [[ ! -f "\$path" ]]; then
    echo "missing embedded project-host software artifact: \$path" >&2
    missing=1
  fi
done
if [[ "\$missing" -ne 0 ]]; then
  cat >&2 <<'MSG'
This bay runtime does not embed project-host software artifacts.
Provide --host-software-bundle <tarball> or use --build-host-software-bundle
before running a deploy that upgrades project hosts.
MSG
  exit 1
fi
echo "project_host_software_embedded=\$current/runtime/packages"
EOF
    return 0
  fi
  [[ -f "$HOST_SOFTWARE_BUNDLE_PATH" ]] || die "project-host software bundle not found: $HOST_SOFTWARE_BUNDLE_PATH"
  [[ -n "$REMOTE_WORK_DIR" ]] || die "remote work dir is not initialized"
  REMOTE_HOST_SOFTWARE_BUNDLE="${REMOTE_WORK_DIR}/$(basename "$HOST_SOFTWARE_BUNDLE_PATH")"

  log "Upload project-host software bundle"
  scp "$HOST_SOFTWARE_BUNDLE_PATH" "$REMOTE:${REMOTE_HOST_SOFTWARE_BUNDLE}"

  log "Stage project-host software into current bay release"
  remote_exec "sudo bash -s" <<EOF | tee "${REPORT_DIR}/stage-host-software.log"
set -euo pipefail
current="\$(readlink -f /opt/cocalc/bay/current)"
if [[ -z "\$current" || ! -d "\$current" ]]; then
  echo "current bay release does not exist: /opt/cocalc/bay/current" >&2
  exit 1
fi
extract="\$(mktemp -d /tmp/cocalc-host-software.XXXXXX)"
cleanup() {
  rm -rf "\$extract"
}
trap cleanup EXIT
tar -xf $(q "$REMOTE_HOST_SOFTWARE_BUNDLE") -C "\$extract" --strip-components=1
test -f "\$extract/runtime/packages/project-host/build/bundle-linux.tar.xz"
test -f "\$extract/runtime/packages/project/build/bundle-linux.tar.xz"
test -f "\$extract/runtime/packages/server/cloud/bootstrap/bootstrap.py"
rm -rf "\$current/runtime/packages"
mkdir -p "\$current/runtime"
rsync -a --delete "\$extract/runtime/packages/" "\$current/runtime/packages/"
if [[ -f "\$extract/project-host-software-manifest.json" ]]; then
  cp "\$extract/project-host-software-manifest.json" "\$current/project-host-software-manifest.json"
fi
chown -R $(q "$BAY_USER"):$(q "$BAY_USER") "\$current/runtime/packages" "\$current/project-host-software-manifest.json" 2>/dev/null || true
echo "project_host_software_staged=\$current/runtime/packages"
EOF
}

restart_and_health_check() {
  if [[ "$STATIC_ONLY" -eq 1 ]]; then
    if [[ "$RESTART_HUB_WORKERS" -eq 0 ]]; then
      log "Run health checks without restarting hub workers"
      remote_exec "sudo /opt/cocalc/bay/current/bin/bay-status && sudo /opt/cocalc/bay/current/bin/bay-health" \
        | tee "${REPORT_DIR}/bay-health.txt"
      return 0
    fi
    local restart_command="sudo systemctl daemon-reload"
    local worker_id
    for worker_id in $(seq 1 "$WORKER_COUNT"); do
      restart_command+=" && sudo systemctl restart cocalc-bay-hub@${worker_id}.service"
      restart_command+=" && sudo /opt/cocalc/bay/current/bin/bay-worker-health ${worker_id}"
    done
    restart_command+=" && sudo /opt/cocalc/bay/current/bin/bay-status"
    restart_command+=" && sudo /opt/cocalc/bay/current/bin/bay-health"
    log "Restart hub workers one at a time and run health checks"
    remote_exec "$restart_command" \
      | tee "${REPORT_DIR}/bay-health.txt"
  else
    log "Restart bay services and run health checks"
    remote_exec "sudo systemctl daemon-reload && sudo systemctl restart cocalc-bay-postgres.service cocalc-bay-migrations.service cocalc-bay-conat-router.service cocalc-bay-conat-persist.service cocalc-bay-hub@1.service cocalc-bay-hub@2.service && sudo /opt/cocalc/bay/current/bin/bay-status && sudo /opt/cocalc/bay/current/bin/bay-health" \
      | tee "${REPORT_DIR}/bay-health.txt"
  fi
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
  if [[ -n "$COOKIE_HEADER" ]]; then
    return 0
  fi
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
  NOW() + INTERVAL '${TEMP_COOKIE_TTL}',
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

auth_refresh_command() {
  local cmd
  cmd="$(q "$CLI_PATH") --api $(q "$API_URL") auth login"
  if [[ -n "$ADMIN_EMAIL" ]]; then
    cmd+=" --email $(q "$ADMIN_EMAIL")"
  fi
  printf "%s" "$cmd"
}

print_cli_auth_failure() {
  local status="$1"
  local output="$2"
  cat >&2 <<EOF

========================================================================
ERROR: CLI authentication preflight failed for ${API_URL}
========================================================================

The bay release was not built or deployed. This check runs before the
expensive upgrade steps because the later project-host upgrade would fail
with the same credentials.

Probe:
  $(q "$CLI_PATH") --api $(q "$API_URL") --disable-env-auth-defaults --cookie '<redacted>' --output json host list --admin-view --limit 1

Exit status:
  ${status}

Output:
${output}

Suggested auth refresh:
  $(auth_refresh_command)

Then rerun this upgrade command. If you used --cookie, replace it with a
fresh remember_me cookie or use --admin-email/--admin-account-id so this
script can create a short-lived session directly on the bay.
========================================================================

EOF
}

preflight_cli_auth() {
  if [[ "$SKIP_HOST_UPGRADE" -ne 0 ]]; then
    log "Skip CLI auth preflight for project host upgrade"
    return 0
  fi
  [[ -x "$CLI_PATH" || -f "$CLI_PATH" ]] || die "cocalc CLI not found: $CLI_PATH"
  create_temp_cookie

  log "Preflight CLI auth for project host upgrade"
  local output
  local status
  set +e
  output="$(
    "$CLI_PATH" \
      --api "$API_URL" \
      --disable-env-auth-defaults \
      --cookie "$COOKIE_HEADER" \
      --output json \
      host list \
      --admin-view \
      --limit 1 \
      2>&1
  )"
  status=$?
  set -e
  printf "%s\n" "$output" >"${REPORT_DIR}/auth-preflight.json"
  if [[ "$status" -ne 0 ]] || grep -q '"ok"[[:space:]]*:[[:space:]]*false' <<<"$output"; then
    print_cli_auth_failure "$status" "$output"
    exit 1
  fi
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
  if [[ "$BUILD_HOST_SOFTWARE_BUNDLE" -eq 1 ]]; then
    require_cmd pnpm
  fi
  mkdir -p "$REPORT_DIR"
  preflight_cli_auth

  if [[ "$BUILD_BUNDLE" -eq 1 ]]; then
    build_bundle
  fi
  if [[ "$BUILD_HOST_SOFTWARE_BUNDLE" -eq 1 ]]; then
    build_host_software_bundle
  fi

  log "Upgrade target"
  cat <<EOF | tee "${REPORT_DIR}/upgrade-target.txt"
remote=${REMOTE}
api=${API_URL}
public_url=${PUBLIC_URL}
bay_id=${BAY_ID}
static_only=${STATIC_ONLY}
bundle=${BUNDLE_PATH}
host_software_bundle=${HOST_SOFTWARE_BUNDLE_PATH}
report_dir=${REPORT_DIR}
EOF

  stage_release
  stage_host_software
  restart_and_health_check
  upgrade_project_hosts
  verify_project_hosts

  log "Upgrade complete"
  echo "report_dir=${REPORT_DIR}"
}

main "$@"
