#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${COCALC_CONAT_TRANSPORT_MATRIX_STATE_DIR:-$SRC_DIR/.local/conat-transport-matrix}"
RESULT_DIR="$STATE_DIR/results"
BASE_PORT="${COCALC_CONAT_TRANSPORT_MATRIX_BASE_PORT:-19100}"
SYSTEM_PASSWORD="${COCALC_CONAT_TRANSPORT_MATRIX_SYSTEM_PASSWORD:-conat-transport-matrix}"
DURATION="${COCALC_CONAT_TRANSPORT_MATRIX_DURATION:-10s}"
WARMUP="${COCALC_CONAT_TRANSPORT_MATRIX_WARMUP:-20}"
PAYLOAD_BYTES="${COCALC_CONAT_TRANSPORT_MATRIX_PAYLOAD_BYTES:-16}"
ROUTER_COUNTS="${COCALC_CONAT_TRANSPORT_MATRIX_ROUTER_COUNTS:-1 2 4 8}"
CONCURRENCIES="${COCALC_CONAT_TRANSPORT_MATRIX_CONCURRENCIES:-64 128 256}"
COMPRESSION_MODES="${COCALC_CONAT_TRANSPORT_MATRIX_COMPRESSION:-off on}"
REQUEST_TRANSPORTS="${COCALC_CONAT_TRANSPORT_MATRIX_REQUEST_TRANSPORTS:-pubsub raw-rpc fast-rpc}"
RESPONSE_MODES="${COCALC_CONAT_TRANSPORT_MATRIX_RESPONSE_MODES:-default}"
CLIENT_PROCESSES="${COCALC_CONAT_TRANSPORT_MATRIX_CLIENT_PROCESSES:-1}"

log() {
  printf '[conat-transport-matrix] %s\n' "$*" >&2
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <run|start|stop|status>

Environment:
  COCALC_CONAT_TRANSPORT_MATRIX_ROUTER_COUNTS="$ROUTER_COUNTS"
  COCALC_CONAT_TRANSPORT_MATRIX_CONCURRENCIES="$CONCURRENCIES"
  COCALC_CONAT_TRANSPORT_MATRIX_COMPRESSION="$COMPRESSION_MODES"
  COCALC_CONAT_TRANSPORT_MATRIX_REQUEST_TRANSPORTS="$REQUEST_TRANSPORTS"
  COCALC_CONAT_TRANSPORT_MATRIX_RESPONSE_MODES="$RESPONSE_MODES"
  COCALC_CONAT_TRANSPORT_MATRIX_CLIENT_PROCESSES=$CLIENT_PROCESSES
  COCALC_CONAT_TRANSPORT_MATRIX_DURATION=$DURATION
  COCALC_CONAT_TRANSPORT_MATRIX_WARMUP=$WARMUP
  COCALC_CONAT_TRANSPORT_MATRIX_PAYLOAD_BYTES=$PAYLOAD_BYTES
  COCALC_CONAT_TRANSPORT_MATRIX_BASE_PORT=$BASE_PORT
EOF
}

require_build() {
  local cli="$SRC_DIR/packages/cli/dist/bin/main.js"
  local server="$SRC_DIR/packages/conat/dist/core/server.js"
  if [[ ! -f "$cli" || ! -f "$server" ]]; then
    log "missing built CLI or Conat server; run pnpm -C '$SRC_DIR' tsc first"
    exit 1
  fi
}

pid_file() {
  printf '%s/router-%s.pid' "$STATE_DIR" "$1"
}

log_file() {
  printf '%s/router-%s.log' "$STATE_DIR" "$1"
}

router_port() {
  local index="$1"
  printf '%s' $((BASE_PORT + index - 1))
}

addresses_for_count() {
  local count="$1"
  local index port out=""
  for index in $(seq 1 "$count"); do
    port="$(router_port "$index")"
    if [[ -n "$out" ]]; then
      out="$out,"
    fi
    out="${out}http://127.0.0.1:${port}"
  done
  printf '%s' "$out"
}

start_router() {
  local port="$1" compression="$2" pid log_path
  pid="$(pid_file "$port")"
  log_path="$(log_file "$port")"
  mkdir -p "$STATE_DIR"
  if [[ -f "$pid" ]] && kill -0 "$(cat "$pid")" 2>/dev/null; then
    return 0
  fi
  rm -f "$pid"
  : > "$log_path"
  (
    cd "$SRC_DIR"
    export NODE_ENV=production
    export NODE_NO_WARNINGS=1
    export NODE_PATH="$SRC_DIR/packages/node_modules${NODE_PATH:+:$NODE_PATH}"
    export COCALC_CONAT_SOCKET_IO_COMPRESSION="$compression"
    export COCALC_CONAT_MAX_CONNECTIONS=100000
    export COCALC_CONAT_MAX_CONNECTIONS_PER_USER=100000
    export COCALC_CONAT_MAX_CONNECTIONS_PER_HUB_USER=100000
    export MATRIX_PORT="$port"
    export MATRIX_SYSTEM_PASSWORD="$SYSTEM_PASSWORD"
    exec node - <<'JS'
const { init } = require("./packages/conat/dist/core/server.js");
const port = Number(process.env.MATRIX_PORT);
const server = init({
  id: `matrix-${port}`,
  port,
  systemAccountPassword: process.env.MATRIX_SYSTEM_PASSWORD,
});
const close = async () => {
  try {
    server.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
setInterval(() => undefined, 1 << 30);
JS
  ) >> "$log_path" 2>&1 &
  echo $! > "$pid"
}

wait_router() {
  local port="$1" log_path
  log_path="$(log_file "$port")"
  for _ in $(seq 1 30); do
    if curl -sS "http://127.0.0.1:${port}/conat/?EIO=4&transport=polling" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -f "$(pid_file "$port")" ]] && ! kill -0 "$(cat "$(pid_file "$port")")" 2>/dev/null; then
      log "router $port exited early"
      tail -n 80 "$log_path" >&2 || true
      exit 1
    fi
    sleep 0.2
  done
  log "router $port did not become reachable"
  tail -n 80 "$log_path" >&2 || true
  exit 1
}

start_routers() {
  local count="$1" compression="$2" index port
  stop_routers
  for index in $(seq 1 "$count"); do
    port="$(router_port "$index")"
    start_router "$port" "$compression"
  done
  for index in $(seq 1 "$count"); do
    wait_router "$(router_port "$index")"
  done
}

stop_routers() {
  local file pid
  shopt -s nullglob
  for file in "$STATE_DIR"/router-*.pid; do
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  done
}

status_routers() {
  local file pid port
  shopt -s nullglob
  for file in "$STATE_DIR"/router-*.pid; do
    pid="$(cat "$file" 2>/dev/null || true)"
    port="$(basename "$file" .pid | sed 's/^router-//')"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      printf 'router-%s pid=%s running\n' "$port" "$pid"
    else
      printf 'router-%s stopped\n' "$port"
    fi
  done
}

normalize_compression() {
  case "${1,,}" in
    on|1|true|yes) printf '1' ;;
    off|0|false|no) printf '0' ;;
    *)
      log "invalid compression mode '$1'"
      exit 1
      ;;
  esac
}

run_client_once() {
  local addresses="$1" concurrency="$2" transport="$3" response_mode="$4" output="$5"
  node "$SRC_DIR/packages/cli/dist/bin/main.js" --json load conat-messages \
    --addresses "$addresses" \
    --system-password "$SYSTEM_PASSWORD" \
    --duration "$DURATION" \
    --warmup "$WARMUP" \
    --concurrency "$concurrency" \
    --payload-bytes "$PAYLOAD_BYTES" \
    --mode request \
    --request-transport "$transport" \
    --response-mode "$response_mode" > "$output"
}

run_client_split() {
  local addresses="$1" concurrency="$2" transport="$3" response_mode="$4" run_dir="$5"
  local per remainder index child_concurrency pids start end
  mkdir -p "$run_dir"
  per=$((concurrency / CLIENT_PROCESSES))
  remainder=$((concurrency % CLIENT_PROCESSES))
  pids=""
  start="$(node -e 'process.stdout.write(`${Date.now()}`)')"
  for index in $(seq 1 "$CLIENT_PROCESSES"); do
    child_concurrency="$per"
    if [[ "$index" -le "$remainder" ]]; then
      child_concurrency=$((child_concurrency + 1))
    fi
    if [[ "$child_concurrency" -le 0 ]]; then
      continue
    fi
    run_client_once "$addresses" "$child_concurrency" "$transport" "$response_mode" "$run_dir/client-${index}.json" &
    pids="$pids $!"
  done
  # shellcheck disable=SC2086
  wait $pids
  end="$(node -e 'process.stdout.write(`${Date.now()}`)')"
  node - "$concurrency" "$((end - start))" "$run_dir"/client-*.json <<'JS'
const fs = require("node:fs");
const [totalConcurrency, parentWallMs, ...files] = process.argv.slice(2);
const rows = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
const attempts = rows.reduce((sum, row) => sum + row.data.successes + row.data.failures, 0);
const successes = rows.reduce((sum, row) => sum + row.data.successes, 0);
const failures = rows.reduce((sum, row) => sum + row.data.failures, 0);
const childOps = rows.map((row) => row.data.ops_per_sec);
const childP95 = rows.map((row) => row.data.latency_ms.p95);
const childP99 = rows.map((row) => row.data.latency_ms.p99);
const wallMs = Number(parentWallMs);
const rate = attempts > 0 && wallMs > 0 ? attempts * 1000 / wallMs : 0;
console.log(JSON.stringify({
  total_concurrency: Number(totalConcurrency),
  client_processes: rows.length,
  successes,
  failures,
  parent_wall_ms: wallMs,
  aggregate_ops_per_sec: Number(rate.toFixed(3)),
  sum_child_ops_per_sec: Number(childOps.reduce((sum, x) => sum + x, 0).toFixed(3)),
  child_ops_per_sec: childOps,
  child_p95_ms: childP95,
  child_p99_ms: childP99,
  sample_errors: rows.flatMap((row) => row.data.sample_errors ?? []).slice(0, 10),
}));
JS
}

run_matrix() {
  require_build
  mkdir -p "$RESULT_DIR"
  local started out compression_label compression router_count addresses transport response_mode concurrency run_dir summary
  started="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$RESULT_DIR/conat-transport-matrix-${started}.jsonl"
  log "writing $out"
  for compression_label in $COMPRESSION_MODES; do
    compression="$(normalize_compression "$compression_label")"
    for router_count in $ROUTER_COUNTS; do
      log "starting routers count=$router_count compression=$compression_label"
      start_routers "$router_count" "$compression"
      addresses="$(addresses_for_count "$router_count")"
      for transport in $REQUEST_TRANSPORTS; do
        for response_mode in $RESPONSE_MODES; do
          if [[ "$transport" != "pubsub" && "$response_mode" != "default" ]]; then
            continue
          fi
          for concurrency in $CONCURRENCIES; do
            log "run compression=$compression_label routers=$router_count transport=$transport response=$response_mode concurrency=$concurrency"
            run_dir="$RESULT_DIR/run-${started}-c${compression_label}-r${router_count}-t${transport}-resp${response_mode}-n${concurrency}"
            summary="$(run_client_split "$addresses" "$concurrency" "$transport" "$response_mode" "$run_dir")"
            node - "$summary" "$compression_label" "$router_count" "$addresses" "$transport" "$response_mode" "$concurrency" "$DURATION" "$PAYLOAD_BYTES" <<'JS' | tee -a "$out"
const [summaryJson, compression, routerCount, addresses, transport, responseMode, concurrency, duration, payloadBytes] = process.argv.slice(2);
console.log(JSON.stringify({
  started_at: new Date().toISOString(),
  compression,
  router_count: Number(routerCount),
  addresses: addresses.split(","),
  request_transport: transport,
  response_mode: responseMode,
  concurrency: Number(concurrency),
  duration,
  payload_bytes: Number(payloadBytes),
  ...JSON.parse(summaryJson),
}));
JS
          done
        done
      done
    done
  done
  stop_routers
  log "wrote $out"
}

cmd="${1:-}"
case "$cmd" in
  run)
    run_matrix
    ;;
  start)
    require_build
    start_routers "${2:-1}" "$(normalize_compression "${3:-off}")"
    ;;
  stop)
    stop_routers
    ;;
  status)
    status_routers
    ;;
  *)
    usage
    exit 2
    ;;
esac
