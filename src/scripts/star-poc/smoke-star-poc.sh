#!/usr/bin/env bash
set -euo pipefail

STAR_API="${STAR_API:-http://127.0.0.1:9100}"
SRC_ROOT="${SRC_ROOT:-${HOME}/cocalc-ai/src}"
STATE_DIR="${STAR_SMOKE_STATE:-/tmp/cocalc-star-smoke}"
BOOTSTRAP_RESULT="${STAR_BOOTSTRAP_RESULT:-/var/lib/cocalc/star/bootstrap-result.json}"
STAR_SMOKE_ROOTFS_IMAGE="${STAR_SMOKE_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"

log() {
  printf '[star-smoke] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

json_field() {
  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const value = process.argv[2].split(".").reduce((x, k) => x?.[k], data);
if (value == null) process.exit(1);
process.stdout.write(String(value));
' "$1" "$2"
}

cookie_header_from_headers() {
  node -e '
const fs = require("fs");
const headers = fs.readFileSync(process.argv[1], "utf8");
const cookies = [];
for (const line of headers.split(/\r?\n/)) {
  const match = /^set-cookie:\s*([^=]+=[^;]*)/i.exec(line);
  if (match) cookies.push(match[1]);
}
if (cookies.length === 0) {
  throw new Error(`no Set-Cookie headers in ${process.argv[1]}`);
}
process.stdout.write(cookies.join("; "));
' "$1"
}

require_file() {
  [ -f "$1" ] || die "missing file: $1"
}

source_node_env() {
  if [ -s "${HOME}/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "${HOME}/.nvm/nvm.sh"
    nvm use 26 >/dev/null
  fi
  command -v node >/dev/null 2>&1 || die "node is required"
  command -v jq >/dev/null 2>&1 || die "jq is required"
}

wait_for_api() {
  log "waiting for ${STAR_API}"
  for _ in $(seq 1 60); do
    if curl -fsS "${STAR_API}/customize" >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done
  die "API did not become healthy: ${STAR_API}"
}

ensure_account() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"

  local email_file="${STATE_DIR}/email"
  local password_file="${STATE_DIR}/password"
  if [ ! -f "$email_file" ]; then
    printf 'star-smoke-%s@example.invalid\n' "$(date -u +%Y%m%d%H%M%S)" >"$email_file"
    chmod 600 "$email_file"
  fi
  if [ ! -f "$password_file" ]; then
    openssl rand -base64 32 >"$password_file"
    chmod 600 "$password_file"
  fi

  local email password
  email="$(tr -d '\n' <"$email_file")"
  password="$(tr -d '\n' <"$password_file")"

  if [ ! -f "${STATE_DIR}/signed-up" ]; then
    require_file "$BOOTSTRAP_RESULT"
    local bootstrap_url token body status
    bootstrap_url="$(json_field "$BOOTSTRAP_RESULT" bootstrap_url || true)"
    [ -n "$bootstrap_url" ] || die "bootstrap URL is already consumed and no smoke account state exists"
    token="$(
      node -e 'process.stdout.write(new URL(process.argv[1]).searchParams.get("registrationToken") ?? "")' \
        "$bootstrap_url"
    )"
    [ -n "$token" ] || die "bootstrap URL did not contain token"
    body="$(
      jq -nc \
        --arg email "$email" \
        --arg password "$password" \
        --arg token "$token" \
        '{email:$email,password:$password,firstName:"Star",lastName:"Smoke",terms:true,registrationToken:$token}'
    )"
    log "creating smoke admin account"
    status="$(
      curl -sS -o "${STATE_DIR}/signup.json" -w '%{http_code}' \
        -H 'content-type: application/json' \
        -d "$body" \
        "${STAR_API}/api/v2/auth/sign-up"
    )"
    if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
      jq . "${STATE_DIR}/signup.json" >&2 || true
      die "sign-up failed with HTTP $status"
    fi
    touch "${STATE_DIR}/signed-up"
  fi

  local body status
  body="$(jq -nc --arg email "$email" --arg password "$password" '{email:$email,password:$password}')"
  status="$(
    curl -sS -D "${STATE_DIR}/signin.headers" -o "${STATE_DIR}/signin.json" -w '%{http_code}' \
      -H 'content-type: application/json' \
      -d "$body" \
      "${STAR_API}/api/v2/auth/sign-in"
  )"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    jq . "${STATE_DIR}/signin.json" >&2 || true
    die "sign-in failed with HTTP $status"
  fi
  cookie_header_from_headers "${STATE_DIR}/signin.headers" >"${STATE_DIR}/cookie-header"
  chmod 600 "${STATE_DIR}/cookie-header"
}

cocalc_cli() {
  local cookie_header
  cookie_header="$(cat "${STATE_DIR}/cookie-header")"
  (
    cd "$SRC_ROOT"
    node packages/cli/dist/bin/cocalc.js \
      --api "$STAR_API" \
      --cookie "$cookie_header" \
      --output json \
      "$@"
  )
}

main() {
  source_node_env
  wait_for_api
  ensure_account

  log "creating project"
  cocalc_cli project create \
    --rootfs-image "$STAR_SMOKE_ROOTFS_IMAGE" \
    "Star Smoke $(date -u +%Y%m%dT%H%M%SZ)" \
    >"${STATE_DIR}/project-create.json"
  local project_id
  project_id="$(json_field "${STATE_DIR}/project-create.json" data.project_id)"

  log "starting project ${project_id}"
  cocalc_cli --timeout 10m --rpc-timeout 2m project start -w "$project_id" --wait >"${STATE_DIR}/project-start.json"

  log "listing project files"
  cocalc_cli --timeout 2m --rpc-timeout 1m project file list -w "$project_id" / >"${STATE_DIR}/project-file-list.json"

  log "executing command in project"
  cocalc_cli --timeout 2m --rpc-timeout 1m project exec -w "$project_id" -- \
    bash -lc 'pwd && whoami && command -v jupyter && command -v latexmk && echo star-ok' \
    >"${STATE_DIR}/project-exec.json"
  local exit_code
  exit_code="$(json_field "${STATE_DIR}/project-exec.json" data.exit_code)"
  [ "$exit_code" = "0" ] || die "project exec failed with exit_code=${exit_code}"

  log "checking ssh-info"
  cocalc_cli --timeout 2m --rpc-timeout 1m project ssh-info -w "$project_id" >"${STATE_DIR}/project-ssh-info.json"

  jq -n \
    --arg api "$STAR_API" \
    --arg project_id "$project_id" \
    --slurpfile exec "${STATE_DIR}/project-exec.json" \
    --slurpfile ssh "${STATE_DIR}/project-ssh-info.json" \
    '{
      ok: true,
      api: $api,
      project_id: $project_id,
      exec_stdout: ($exec[0].data.stdout // null),
      ssh_server: ($ssh[0].data.ssh_server // null)
    }'
}

main "$@"
