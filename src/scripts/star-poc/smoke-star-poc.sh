#!/usr/bin/env bash
set -euo pipefail

STAR_API="${STAR_API:-http://127.0.0.1:9100}"
SRC_ROOT="${SRC_ROOT:-${HOME}/cocalc-ai/src}"
STATE_DIR="${STAR_SMOKE_STATE:-/var/lib/cocalc/star/smoke}"
BOOTSTRAP_RESULT="${STAR_BOOTSTRAP_RESULT:-/var/lib/cocalc/star/bootstrap-result.json}"
STAR_SMOKE_ROOTFS_IMAGE="${STAR_SMOKE_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
SMOKE_NOTEBOOK_PATH="${STAR_SMOKE_NOTEBOOK_PATH:-star-smoke/smoke.ipynb}"
STAR_SMOKE_REUSE_PROJECT="${STAR_SMOKE_REUSE_PROJECT:-0}"
STAR_SMOKE_NOTEBOOK="${STAR_SMOKE_NOTEBOOK:-1}"
STAR_SMOKE_BROWSER="${STAR_SMOKE_BROWSER:-0}"
STAR_SMOKE_BROWSER_BASE_URL="${STAR_SMOKE_BROWSER_BASE_URL:-$STAR_API}"

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

reject_response_issues() {
  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data?.error || data?.issues) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}
' "$1"
}

require_json_field_equals() {
  local file="$1"
  local field="$2"
  local expected="$3"
  local actual
  actual="$(json_field "$file" "$field")"
  [ "$actual" = "$expected" ] || die "${field} in ${file} was '${actual}', expected '${expected}'"
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
  if [ -f "$email_file" ] && [ ! -s "$email_file" ]; then
    rm -f "$email_file" "${STATE_DIR}/signed-up" "${STATE_DIR}/cookie-header"
  fi
  if [ -f "$password_file" ] && [ ! -s "$password_file" ]; then
    rm -f "$password_file" "${STATE_DIR}/signed-up" "${STATE_DIR}/cookie-header"
  fi

  if [ ! -s "$email_file" ]; then
    printf 'star-smoke-%s@example.invalid\n' "$(date -u +%Y%m%d%H%M%S)" >"$email_file"
    chmod 600 "$email_file"
  fi
  if [ ! -s "$password_file" ]; then
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
    reject_response_issues "${STATE_DIR}/signup.json" || die "sign-up returned an API error"
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
  reject_response_issues "${STATE_DIR}/signin.json" || die "sign-in returned an API error"
  cookie_header_from_headers "${STATE_DIR}/signin.headers" >"${STATE_DIR}/cookie-header"
  chmod 600 "${STATE_DIR}/cookie-header"
}

cocalc_cli() {
  local cookie_header
  cookie_header="$(cat "${STATE_DIR}/cookie-header")"
  (
    cd "$SRC_ROOT"
    local cli_entry="packages/cli/dist/bin/cocalc.js"
    if [ -f packages/cli/build/bundle/index.js ]; then
      cli_entry="packages/cli/build/bundle/index.js"
    fi
    node "$cli_entry" \
      --api "$STAR_API" \
      --cookie "$cookie_header" \
      --output json \
      "$@"
  )
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_smoke_notebook() {
  local dest="${STATE_DIR}/smoke.ipynb"
  cat >"$dest" <<'EOF'
{
  "cells": [
    {
      "cell_type": "code",
      "execution_count": null,
      "metadata": {},
      "outputs": [],
      "source": [
        "import os, sys\n",
        "print('star-jupyter-ok', sys.version_info.major, os.path.isdir('/scratch'))"
      ]
    }
  ],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python"
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
EOF
  printf '%s\n' "$dest"
}

create_viewer_smoke_files() {
  local project_id="$1"
  log "creating PDF/JPEG viewer smoke files"
  cocalc_cli --timeout 3m --rpc-timeout 2m project exec -w "$project_id" -- \
    bash -lc 'set -euo pipefail
mkdir -p star-smoke
cat > star-smoke/viewer-test.tex <<'"'"'EOF'"'"'
\documentclass{article}
\title{Viewer Test}
\author{CoCalc Star}
\begin{document}
\maketitle
Hello PDF
\end{document}
EOF
latexmk -pdf -interaction=nonstopmode -outdir=star-smoke star-smoke/viewer-test.tex >/tmp/star-smoke-latexmk.log
cat <<'"'"'EOF'"'"' | base64 -d > star-smoke/viewer-test.jpg
/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z
EOF
test -s star-smoke/viewer-test.pdf
test -s star-smoke/viewer-test.jpg
ls -l star-smoke/viewer-test.pdf star-smoke/viewer-test.jpg' \
    >"${STATE_DIR}/viewer-files.json"
  require_json_field_equals "${STATE_DIR}/viewer-files.json" data.exit_code 0
}

run_browser_smoke() {
  local project_id="$1"
  local cookie_header
  cookie_header="$(cat "${STATE_DIR}/cookie-header")"
  log "running browser PDF/JPEG smoke"
  node "${SRC_ROOT}/scripts/star-poc/browser-smoke-star-poc.mjs" \
    --base-url "$STAR_SMOKE_BROWSER_BASE_URL" \
    --project-id "$project_id" \
    --cookie-header "$cookie_header" \
    >"${STATE_DIR}/browser-smoke.json"
}

main() {
  source_node_env
  wait_for_api
  ensure_account

  local project_id_file="${STATE_DIR}/project-id"
  local marker_file="${STATE_DIR}/project-marker"
  local marker
  if [ ! -s "$marker_file" ]; then
    printf 'star-marker-%s-%s\n' "$(date -u +%Y%m%d%H%M%S)" "$(openssl rand -hex 8)" >"$marker_file"
    chmod 600 "$marker_file"
  fi
  marker="$(tr -d '\n' <"$marker_file")"

  local project_id
  if [ "$STAR_SMOKE_REUSE_PROJECT" = "1" ] && [ -s "$project_id_file" ]; then
    project_id="$(tr -d '\n' <"$project_id_file")"
    log "reusing project ${project_id}"
    log "stopping reused project before validation"
    cocalc_cli --timeout 5m --rpc-timeout 1m project stop -w "$project_id" --wait >"${STATE_DIR}/project-stop.json"
  else
    log "creating project"
    cocalc_cli project create \
      --rootfs-image "$STAR_SMOKE_ROOTFS_IMAGE" \
      "Star Smoke $(date -u +%Y%m%dT%H%M%SZ)" \
      >"${STATE_DIR}/project-create.json"
    project_id="$(json_field "${STATE_DIR}/project-create.json" data.project_id)"
    printf '%s\n' "$project_id" >"$project_id_file"
    chmod 600 "$project_id_file"
  fi

  log "starting project ${project_id}"
  cocalc_cli --timeout 10m --rpc-timeout 2m project start -w "$project_id" --wait >"${STATE_DIR}/project-start.json"

  log "listing project files"
  cocalc_cli --timeout 2m --rpc-timeout 1m project file list -w "$project_id" / >"${STATE_DIR}/project-file-list.json"

  log "executing command in project"
  local quoted_marker
  quoted_marker="$(shell_quote "$marker")"
  cocalc_cli --timeout 2m --rpc-timeout 1m project exec -w "$project_id" -- \
    bash -lc 'set -e
marker='"${quoted_marker}"'
pwd
whoami
id
command -v jupyter
command -v latexmk
test -d /scratch
sudo -n id
mkdir -p star-smoke
if [ ! -f star-smoke/persistence.txt ]; then
  printf "%s\n" "$marker" > star-smoke/persistence.txt
fi
test "$(cat star-smoke/persistence.txt)" = "$marker"
python3 - <<'"'"'PY'"'"'
import os
import sys
print("star-python-ok", sys.version_info.major, os.path.isdir("/scratch"))
PY
echo star-ok' \
    >"${STATE_DIR}/project-exec.json"
  require_json_field_equals "${STATE_DIR}/project-exec.json" data.exit_code 0

  create_viewer_smoke_files "$project_id"
  if [ "$STAR_SMOKE_BROWSER" = "1" ]; then
    run_browser_smoke "$project_id"
  fi

  if [ "$STAR_SMOKE_NOTEBOOK" = "1" ]; then
    log "uploading and running smoke notebook"
    local notebook_src
    notebook_src="$(write_smoke_notebook)"
    cocalc_cli --timeout 2m --rpc-timeout 1m project file put -w "$project_id" \
      "$notebook_src" "$SMOKE_NOTEBOOK_PATH" \
      >"${STATE_DIR}/project-notebook-put.json"
    cocalc_cli --timeout 4m --rpc-timeout 2m project jupyter run -w "$project_id" \
      --path "$SMOKE_NOTEBOOK_PATH" --all-code --limit 2000 \
      >"${STATE_DIR}/project-jupyter-run.json"
  fi

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
