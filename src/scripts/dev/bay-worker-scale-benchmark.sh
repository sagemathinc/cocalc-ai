#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${COCALC_BAY_WORKER_SCALE_STATE_DIR:-$SRC_DIR/.local/bay-worker-scale}"
RESULT_DIR="$STATE_DIR/results"
BASE_PORT="${COCALC_BAY_WORKER_SCALE_BASE_PORT:-18001}"
COUNT="${COCALC_BAY_WORKER_SCALE_COUNT:-4}"
ENTRYPOINT_API="${COCALC_BAY_WORKER_SCALE_API:-http://localhost:9100}"
CONCURRENCIES="${COCALC_BAY_WORKER_SCALE_CONCURRENCIES:-32 64 128}"
ITERATIONS="${COCALC_BAY_WORKER_SCALE_ITERATIONS:-400}"
WARMUP="${COCALC_BAY_WORKER_SCALE_WARMUP:-40}"

log() {
  printf '[bay-worker-scale] %s\n' "$*" >&2
}

require_running_hub_env() {
  cd "$SRC_DIR"
  eval "$(pnpm -s dev:env:hub)"
  : "${COCALC_PROJECT_ID:?COCALC_PROJECT_ID missing from dev:env:hub}"
  export COCALC_PROJECT_ID
}

detect_pg_env() {
  local status pg_host pg_user
  status="$("$SRC_DIR/scripts/dev/hub-daemon.sh" status)"
  pg_host="$(printf '%s\n' "$status" | sed -n "s/^postgres socket (PGHOST): //p" | head -n 1)"
  pg_user="$(printf '%s\n' "$status" | sed -n "s/^postgres user   (PGUSER): //p" | head -n 1)"
  if [[ -z "$pg_host" || -z "$pg_user" ]]; then
    log "unable to detect running hub postgres env"
    printf '%s\n' "$status" >&2
    exit 1
  fi
  PGHOST_DETECTED="$pg_host"
  PGUSER_DETECTED="$pg_user"
  PGDATABASE_DETECTED="${PGDATABASE:-smc}"
}

worker_port() {
  local index="$1"
  printf '%s' $((BASE_PORT + index - 1))
}

pid_file_for_port() {
  printf '%s/worker-%s.pid' "$STATE_DIR" "$1"
}

log_file_for_port() {
  printf '%s/worker-%s.log' "$STATE_DIR" "$1"
}

start_worker() {
  local port="$1" pid_file log_file
  pid_file="$(pid_file_for_port "$port")"
  log_file="$(log_file_for_port "$port")"
  mkdir -p "$STATE_DIR"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    log "worker $port already running pid $(cat "$pid_file")"
    return 0
  fi
  rm -f "$pid_file"
  : > "$log_file"
  nohup setsid bash -lc "
    cd '$SRC_DIR'
    export PATH='$SRC_DIR/packages/hub/node_modules/.bin:$SRC_DIR/node_modules/.bin:'\"\$PATH\"':/usr/local/bin:/usr/bin:/bin'
    export NODE_OPTIONS='--openssl-legacy-provider --max_old_space_size=8000 --trace-warnings --enable-source-maps'
    export NODE_ENV=development
    export NODE_NO_WARNINGS=1
    export DEBUG='cocalc:*'
    export HOST=localhost
    export PORT='$port'
    export DATA='$SRC_DIR/data/app/postgres'
    export COCALC_DATA_DIR='$SRC_DIR/data/app/postgres'
    export COCALC_DB=postgres
    export PGHOST='$PGHOST_DETECTED'
    export PGUSER='$PGUSER_DETECTED'
    export PGDATABASE='$PGDATABASE_DETECTED'
    export CONAT_SERVER='$ENTRYPOINT_API'
    export COCALC_DISABLE_NEXT=1
    export NO_RSPACK_DEV_SERVER=1
    export COCALC_BAY_ID=bay-0
    export COCALC_CLUSTER_ROLE=seed
    export COCALC_CLUSTER_SEED_BAY_ID=bay-0
    export COCALC_CLUSTER_BAY_IDS=bay-0,bay-1,bay-2
    export HUB_CLUSTER_BAY_IDS=bay-0,bay-1,bay-2
    export COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT='$SRC_DIR/packages'
    exec node packages/hub/run/hub.js --conat-api --proxy-server --hostname=localhost
  " >> "$log_file" 2>&1 < /dev/null &
  echo $! > "$pid_file"
  log "started worker $port launcher pid $(cat "$pid_file")"
}

wait_worker() {
  local port="$1" log_file
  log_file="$(log_file_for_port "$port")"
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:${port}/alive" >/dev/null 2>&1; then
      log "healthy worker $port"
      return 0
    fi
    sleep 1
  done
  log "worker $port did not become healthy"
  tail -n 80 "$log_file" >&2 || true
  exit 1
}

start_workers() {
  detect_pg_env
  for index in $(seq 1 "$COUNT"); do
    start_worker "$(worker_port "$index")"
  done
  for index in $(seq 1 "$COUNT"); do
    wait_worker "$(worker_port "$index")"
  done
}

stop_workers() {
  local file pid
  shopt -s nullglob
  for file in "$STATE_DIR"/worker-*.pid; do
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      log "stopping pid $pid"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  done
}

status_workers() {
  local file pid
  shopt -s nullglob
  for file in "$STATE_DIR"/worker-*.pid; do
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      printf '%s pid=%s running\n' "$(basename "$file" .pid)" "$pid"
    else
      printf '%s stopped\n' "$(basename "$file" .pid)"
    fi
  done
}

run_sweep() {
  require_running_hub_env
  mkdir -p "$RESULT_DIR"
  local out concurrency
  out="$RESULT_DIR/worker${COUNT}-hotpath-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
  for concurrency in $CONCURRENCIES; do
    log "running workers=$COUNT concurrency=$concurrency"
    node "$SRC_DIR/packages/cli/dist/bin/main.js" --api "$ENTRYPOINT_API" --json \
      load three-bay \
      --project "$COCALC_PROJECT_ID" \
      --iterations "$ITERATIONS" \
      --warmup "$WARMUP" \
      --concurrency "$concurrency" \
      --hot-path | tee -a "$out"
  done
  log "wrote $out"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|status|run|start-run>

Environment:
  COCALC_BAY_WORKER_SCALE_COUNT=$COUNT
  COCALC_BAY_WORKER_SCALE_BASE_PORT=$BASE_PORT
  COCALC_BAY_WORKER_SCALE_API=$ENTRYPOINT_API
  COCALC_BAY_WORKER_SCALE_CONCURRENCIES="$CONCURRENCIES"
  COCALC_BAY_WORKER_SCALE_ITERATIONS=$ITERATIONS
  COCALC_BAY_WORKER_SCALE_WARMUP=$WARMUP
EOF
}

cmd="${1:-}"
case "$cmd" in
  start)
    start_workers
    ;;
  stop)
    stop_workers
    ;;
  status)
    status_workers
    ;;
  run)
    run_sweep
    ;;
  start-run)
    start_workers
    run_sweep
    ;;
  *)
    usage
    exit 2
    ;;
esac
