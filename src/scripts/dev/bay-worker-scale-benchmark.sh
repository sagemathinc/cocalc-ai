#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${COCALC_BAY_WORKER_SCALE_STATE_DIR:-$SRC_DIR/.local/bay-worker-scale}"
RESULT_DIR="$STATE_DIR/results"
BASE_PORT="${COCALC_BAY_WORKER_SCALE_BASE_PORT:-18001}"
COUNT="${COCALC_BAY_WORKER_SCALE_COUNT:-4}"
ENTRYPOINT_API="${COCALC_BAY_WORKER_SCALE_API:-http://localhost:9100}"
ENTRYPOINT_APIS="${COCALC_BAY_WORKER_SCALE_APIS:-$ENTRYPOINT_API}"
CONAT_SERVERS="${COCALC_BAY_WORKER_SCALE_CONAT_SERVERS:-$ENTRYPOINT_API}"
CONCURRENCIES="${COCALC_BAY_WORKER_SCALE_CONCURRENCIES:-32 64 128}"
ITERATIONS="${COCALC_BAY_WORKER_SCALE_ITERATIONS:-400}"
DURATION="${COCALC_BAY_WORKER_SCALE_DURATION:-}"
WARMUP="${COCALC_BAY_WORKER_SCALE_WARMUP:-40}"
PROJECT_ID="${COCALC_BAY_WORKER_SCALE_PROJECT_ID:-}"

log() {
  printf '[bay-worker-scale] %s\n' "$*" >&2
}

require_running_hub_env() {
  cd "$SRC_DIR"
  eval "$(pnpm -s dev:env:hub)"
  if [[ -n "$PROJECT_ID" ]]; then
    COCALC_PROJECT_ID="$PROJECT_ID"
  fi
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

conat_file_for_port() {
  printf '%s/worker-%s.conat' "$STATE_DIR" "$1"
}

normalize_list() {
  printf '%s' "$1" | tr ',' ' '
}

count_items() {
  local count=0 item
  for item in $(normalize_list "$1"); do
    count=$((count + 1))
  done
  printf '%s' "$count"
}

pick_round_robin() {
  local list="$1" index="$2" count target item
  count="$(count_items "$list")"
  if [[ "$count" -le 0 ]]; then
    log "empty list"
    exit 1
  fi
  target=$(( (index - 1) % count + 1 ))
  count=0
  for item in $(normalize_list "$list"); do
    count=$((count + 1))
    if [[ "$count" -eq "$target" ]]; then
      printf '%s' "$item"
      return 0
    fi
  done
}

now_ms() {
  node -e 'process.stdout.write(`${Date.now()}`)'
}

start_worker() {
  local port="$1" conat_server="$2" pid_file log_file conat_file
  pid_file="$(pid_file_for_port "$port")"
  log_file="$(log_file_for_port "$port")"
  conat_file="$(conat_file_for_port "$port")"
  mkdir -p "$STATE_DIR"
  if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    log "worker $port already running pid $(cat "$pid_file")"
    return 0
  fi
  rm -f "$pid_file"
  : > "$log_file"
  printf '%s\n' "$conat_server" > "$conat_file"
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
    export CONAT_SERVER='$conat_server'
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
  log "started worker $port conat=$conat_server launcher pid $(cat "$pid_file")"
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
  local index port conat_server
  for index in $(seq 1 "$COUNT"); do
    port="$(worker_port "$index")"
    conat_server="$(pick_round_robin "$CONAT_SERVERS" "$index")"
    start_worker "$port" "$conat_server"
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
    rm -f "${file%.pid}.conat"
  done
}

status_workers() {
  local file pid port conat
  shopt -s nullglob
  for file in "$STATE_DIR"/worker-*.pid; do
    pid="$(cat "$file" 2>/dev/null || true)"
    port="$(basename "$file" .pid | sed 's/^worker-//')"
    conat="$(cat "$(conat_file_for_port "$port")" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      printf '%s pid=%s conat=%s running\n' "$(basename "$file" .pid)" "$pid" "${conat:-unknown}"
    else
      printf '%s stopped\n' "$(basename "$file" .pid)"
    fi
  done
}

run_load_once() {
  local api="$1" concurrency="$2" output="$3"
  local args=(
    "$SRC_DIR/packages/cli/dist/bin/main.js"
    --api "$api"
    --json
    load three-bay
    --project "$COCALC_PROJECT_ID"
    --warmup "$WARMUP"
    --concurrency "$concurrency"
    --hot-path
  )
  if [[ -n "$DURATION" ]]; then
    args+=(--duration "$DURATION")
  else
    args+=(--iterations "$ITERATIONS")
  fi
  node "${args[@]}" > "$output"
}

run_split_load() {
  local concurrency="$1" out="$2" api_count per remainder run_dir start end api index api_concurrency pids
  api_count="$(count_items "$ENTRYPOINT_APIS")"
  run_dir="$RESULT_DIR/split-$(date -u +%Y%m%dT%H%M%SZ)-c${concurrency}"
  mkdir -p "$run_dir"
  per=$((concurrency / api_count))
  remainder=$((concurrency % api_count))
  start="$(now_ms)"
  pids=""
  index=0
  for api in $(normalize_list "$ENTRYPOINT_APIS"); do
    index=$((index + 1))
    api_concurrency="$per"
    if [[ "$index" -le "$remainder" ]]; then
      api_concurrency=$((api_concurrency + 1))
    fi
    if [[ "$api_concurrency" -le 0 ]]; then
      continue
    fi
    log "running client api=$api concurrency=$api_concurrency"
    run_load_once "$api" "$api_concurrency" "$run_dir/client-${index}.json" &
    pids="$pids $!"
  done
  # shellcheck disable=SC2086
  wait $pids
  end="$(now_ms)"
  node - <<'JS' "$concurrency" "$((end - start))" "$run_dir"/client-*.json | tee -a "$out"
const fs = require("node:fs");
const [totalConcurrency, wallMs, ...files] = process.argv.slice(2);
const rows = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const attempts = rows.reduce((sum, row) => sum + row.data.successes + row.data.failures, 0);
const successes = rows.reduce((sum, row) => sum + row.data.successes, 0);
const failures = rows.reduce((sum, row) => sum + row.data.failures, 0);
const childScenariosPerSec = rows.reduce((sum, row) => sum + row.data.ops_per_sec, 0);
const wall = Number(wallMs);
console.log(JSON.stringify({
  total_concurrency: Number(totalConcurrency),
  split_apis: rows.map((row) => row.meta.api),
  successes,
  failures,
  parent_wall_ms: wall,
  aggregate_scenarios_per_sec: Number((attempts * 1000 / wall).toFixed(3)),
  aggregate_component_reads_per_sec: Number((attempts * 5 * 1000 / wall).toFixed(3)),
  sum_child_scenarios_per_sec: Number(childScenariosPerSec.toFixed(3)),
  sum_child_component_reads_per_sec: Number((childScenariosPerSec * 5).toFixed(3)),
  child_ops_per_sec: rows.map((row) => row.data.ops_per_sec),
  child_iterations: rows.map((row) => row.data.iterations),
  child_p50_ms: rows.map((row) => row.data.latency_ms.p50),
  child_p95_ms: rows.map((row) => row.data.latency_ms.p95),
}));
JS
}

run_sweep() {
  require_running_hub_env
  mkdir -p "$RESULT_DIR"
  local out concurrency
  out="$RESULT_DIR/worker${COUNT}-hotpath-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
  for concurrency in $CONCURRENCIES; do
    log "running workers=$COUNT concurrency=$concurrency"
    if [[ "$(count_items "$ENTRYPOINT_APIS")" -gt 1 ]]; then
      run_split_load "$concurrency" "$out"
    else
      run_load_once "$ENTRYPOINT_API" "$concurrency" /dev/stdout | tee -a "$out"
    fi
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
  COCALC_BAY_WORKER_SCALE_APIS="$ENTRYPOINT_APIS"
  COCALC_BAY_WORKER_SCALE_CONAT_SERVERS="$CONAT_SERVERS"
  COCALC_BAY_WORKER_SCALE_CONCURRENCIES="$CONCURRENCIES"
  COCALC_BAY_WORKER_SCALE_ITERATIONS=$ITERATIONS
  COCALC_BAY_WORKER_SCALE_DURATION=${DURATION:-}
  COCALC_BAY_WORKER_SCALE_WARMUP=$WARMUP
  COCALC_BAY_WORKER_SCALE_PROJECT_ID=${PROJECT_ID:-}
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
