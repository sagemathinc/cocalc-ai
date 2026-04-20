#!/usr/bin/env bash
set -euo pipefail

load_bay_env() {
  local env_file
  for env_file in \
    "${COCALC_BAY_ENV_FILE:-/etc/cocalc/bay.env}" \
    "${COCALC_BAY_WORKERS_ENV_FILE:-/etc/cocalc/bay-workers.env}" \
    "${COCALC_BAY_OVERLAY_ENV_FILE:-/etc/cocalc/bay-overlay.env}" \
    "${COCALC_BAY_SECRETS_ENV_FILE:-/etc/cocalc/bay-secrets.env}"; do
    if [[ -r "$env_file" ]]; then
      # shellcheck disable=SC1090
      source "$env_file"
    fi
  done
}

load_bay_env

: "${COCALC_BAY_ID:=bay-1}"
: "${COCALC_BAY_ROOT:=/mnt/cocalc/bays/${COCALC_BAY_ID}}"
: "${COCALC_BAY_RELEASES_DIR:=/opt/cocalc/bay/releases}"
: "${COCALC_BAY_CURRENT_LINK:=/opt/cocalc/bay/current}"
: "${COCALC_BAY_STATE_DIR:=${COCALC_BAY_ROOT}/state}"
: "${COCALC_BAY_RUN_DIR:=${COCALC_BAY_ROOT}/run}"
: "${COCALC_BAY_LOG_DIR:=${COCALC_BAY_ROOT}/logs}"
: "${COCALC_BAY_BACKUP_DIR:=${COCALC_BAY_ROOT}/backups}"
: "${COCALC_BAY_POSTGRES_HOST:=127.0.0.1}"
: "${COCALC_BAY_POSTGRES_PORT:=5432}"
: "${COCALC_BAY_PERSIST_HOST:=127.0.0.1}"
: "${COCALC_BAY_PERSIST_PORT:=9202}"
: "${COCALC_BAY_PERSIST_HEALTH_PATH:=/healthz}"
: "${COCALC_BAY_ROUTER_HOST:=127.0.0.1}"
: "${COCALC_BAY_ROUTER_PORT:=9102}"
: "${COCALC_BAY_ROUTER_HEALTH_PATH:=/healthz}"
: "${COCALC_BAY_HUB_BIND_HOST:=127.0.0.1}"
: "${COCALC_BAY_HUB_BASE_PORT:=9300}"
: "${COCALC_BAY_HUB_HEALTH_PATH:=/alive}"
: "${COCALC_BAY_MIN_HEALTHY_WORKERS:=1}"
: "${COCALC_BAY_WORKER_COUNT:=1}"
: "${COCALC_BAY_HEALTH_TIMEOUT_S:=15}"
: "${COCALC_BAY_MIN_FREE_MB:=1024}"
: "${COCALC_BAY_EVENT_LOG:=${COCALC_BAY_STATE_DIR}/rollout-events.jsonl}"

bay_log() {
  printf '[bay:%s] %s\n' "$COCALC_BAY_ID" "$*" >&2
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    bay_log "missing required environment variable: $name"
    exit 1
  fi
}

ensure_dirs() {
  mkdir -p \
    "$COCALC_BAY_ROOT" \
    "$COCALC_BAY_STATE_DIR" \
    "$COCALC_BAY_RUN_DIR" \
    "$COCALC_BAY_LOG_DIR" \
    "$COCALC_BAY_BACKUP_DIR"
}

current_version() {
  if [[ -L "$COCALC_BAY_CURRENT_LINK" ]]; then
    basename "$(readlink -f "$COCALC_BAY_CURRENT_LINK")"
    return 0
  fi
  if [[ -r "${COCALC_BAY_STATE_DIR}/current-version" ]]; then
    cat "${COCALC_BAY_STATE_DIR}/current-version"
    return 0
  fi
  return 1
}

previous_version() {
  if [[ -r "${COCALC_BAY_STATE_DIR}/previous-version" ]]; then
    cat "${COCALC_BAY_STATE_DIR}/previous-version"
    return 0
  fi
  return 1
}

release_dir() {
  local version="$1"
  printf '%s/%s' "$COCALC_BAY_RELEASES_DIR" "$version"
}

assert_release_exists() {
  local version="$1"
  if [[ ! -d "$(release_dir "$version")" ]]; then
    bay_log "release does not exist: $(release_dir "$version")"
    exit 1
  fi
}

set_current_version() {
  local version="$1"
  local previous=""
  previous="$(current_version || true)"
  assert_release_exists "$version"
  mkdir -p "$COCALC_BAY_STATE_DIR"
  if [[ -n "$previous" ]]; then
    printf '%s\n' "$previous" > "${COCALC_BAY_STATE_DIR}/previous-version"
  fi
  ln -sfn "$(release_dir "$version")" "$COCALC_BAY_CURRENT_LINK"
  printf '%s\n' "$version" > "${COCALC_BAY_STATE_DIR}/current-version"
}

worker_port() {
  local worker_id="$1"
  printf '%s' $((COCALC_BAY_HUB_BASE_PORT + worker_id - 1))
}

worker_url() {
  local worker_id="$1"
  printf 'http://%s:%s%s' \
    "$COCALC_BAY_HUB_BIND_HOST" \
    "$(worker_port "$worker_id")" \
    "$COCALC_BAY_HUB_HEALTH_PATH"
}

persist_url() {
  printf 'http://%s:%s%s' \
    "$COCALC_BAY_PERSIST_HOST" \
    "$COCALC_BAY_PERSIST_PORT" \
    "$COCALC_BAY_PERSIST_HEALTH_PATH"
}

router_url() {
  printf 'http://%s:%s%s' \
    "$COCALC_BAY_ROUTER_HOST" \
    "$COCALC_BAY_ROUTER_PORT" \
    "$COCALC_BAY_ROUTER_HEALTH_PATH"
}

tcp_check() {
  local host="$1"
  local port="$2"
  timeout "${COCALC_BAY_HEALTH_TIMEOUT_S}" bash -lc ">/dev/tcp/${host}/${port}" \
    >/dev/null 2>&1
}

http_check() {
  local url="$1"
  curl --fail --silent --show-error --max-time "${COCALC_BAY_HEALTH_TIMEOUT_S}" \
    "$url" >/dev/null
}

wait_for_http_check() {
  local url="$1"
  local label="$2"
  local deadline=$((SECONDS + COCALC_BAY_HEALTH_TIMEOUT_S))
  until http_check "$url"; do
    if ((SECONDS >= deadline)); then
      bay_log "${label} is unhealthy"
      return 1
    fi
    sleep 0.2
  done
}

write_event() {
  local action="$1"
  local scope="$2"
  local result="$3"
  local target_version="${4:-}"
  local previous="${5:-}"
  local message="${6:-}"
  mkdir -p "$COCALC_BAY_STATE_DIR"
  python3 - "$COCALC_BAY_EVENT_LOG" "$COCALC_BAY_ID" "$action" "$scope" "$result" "$target_version" "$previous" "$message" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, bay_id, action, scope, result, target_version, previous, message = sys.argv[1:]
event = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "bay_id": bay_id,
    "actor": os.environ.get("USER", "unknown"),
    "action": action,
    "scope": scope,
    "result": result,
}
if target_version:
    event["target_version"] = target_version
if previous:
    event["previous_version"] = previous
if message:
    event["message"] = message
with open(path, "a", encoding="utf-8") as out:
    out.write(json.dumps(event, sort_keys=True) + "\n")
PY
}

run_env_cmd() {
  local name="$1"
  require_var "$name"
  exec bash -lc "${!name}"
}

run_env_cmd_once() {
  local name="$1"
  require_var "$name"
  bash -lc "${!name}"
}

enabled_worker_ids() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  systemctl list-unit-files 'cocalc-bay-hub@*.service' --no-legend 2>/dev/null \
    | awk '/enabled/ {print $1}' \
    | sed -n 's/^cocalc-bay-hub@\([0-9][0-9]*\)\.service$/\1/p' \
    | sort -n
}
