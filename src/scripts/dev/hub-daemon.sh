#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR_DEFAULT="$SRC_DIR/.local/hub-daemon"
CONFIG_FILE_DEFAULT="$SRC_DIR/.local/hub-daemon.env"
EXAMPLE_FILE="$SCRIPT_DIR/hub-daemon.env.example"

STATE_DIR="${COCALC_HUB_DAEMON_STATE_DIR:-$STATE_DIR_DEFAULT}"
CONFIG_FILE="${COCALC_HUB_DAEMON_CONFIG:-$CONFIG_FILE_DEFAULT}"

mkdir -p "$STATE_DIR"

PID_FILE="$STATE_DIR/hub.pid"

find_hub_pids() {
  pgrep -f "$SRC_DIR/packages/hub/node_modules/.bin/../@cocalc/hub/run/hub.js" || true
}

find_primary_hub_pid() {
  find_hub_pids | tail -n 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <init|start|stop|restart|status|logs|env>

Config file: $CONFIG_FILE
State dir:   $STATE_DIR
EOF
}

detect_host_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "src") { print $(i+1); exit }
        }
      }'
    return 0
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

load_config() {
  if [ -f "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
  fi

  HUB_CMD="${HUB_CMD:-./packages/hub/bin/start.sh postgres}"
  HUB_PORT="${HUB_PORT:-9100}"
  HUB_BIND_HOST="${HUB_BIND_HOST:-localhost}"
  HUB_ALLOW_INSECURE_HTTP_MODE="${HUB_ALLOW_INSECURE_HTTP_MODE:-0}"
  HUB_DISABLE_NEXT="${HUB_DISABLE_NEXT:-1}"
  HUB_DEBUG="${HUB_DEBUG:-cocalc:*}"
  HUB_DEBUG_FILE="${HUB_DEBUG_FILE:-$SRC_DIR/log}"
  HUB_STDOUT_LOG="${HUB_STDOUT_LOG:-$STATE_DIR/hub.stdout.log}"
  HUB_SOFTWARE_PACKAGES_ROOT="${HUB_SOFTWARE_PACKAGES_ROOT:-$SRC_DIR/packages}"
  HUB_USE_LOCAL_SOFTWARE="${HUB_USE_LOCAL_SOFTWARE:-1}"
  HUB_HOST_IP="${HUB_HOST_IP:-}"
  HUB_SOFTWARE_BASE_URL_FORCE="${HUB_SOFTWARE_BASE_URL_FORCE:-}"
  HUB_NODE_BIN="${HUB_NODE_BIN:-}"
  HUB_SELF_HOST_PAIR_URL="${HUB_SELF_HOST_PAIR_URL:-}"

  if [ -z "$HUB_SOFTWARE_BASE_URL_FORCE" ] && [ "$HUB_USE_LOCAL_SOFTWARE" = "1" ]; then
    if [ -z "$HUB_HOST_IP" ]; then
      HUB_HOST_IP="$(detect_host_ip || true)"
    fi
    if [ -n "$HUB_HOST_IP" ]; then
      HUB_SOFTWARE_BASE_URL_FORCE="http://$HUB_HOST_IP:$HUB_PORT/software"
    fi
  fi
}

resolve_node_bin() {
  if [ -n "${HUB_NODE_BIN:-}" ] && [ -x "$HUB_NODE_BIN" ]; then
    echo "$HUB_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local newest
    newest="$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1 || true)"
    if [ -n "$newest" ] && [ -x "$newest" ]; then
      echo "$newest"
      return 0
    fi
  fi
  return 1
}

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    local discovered
    discovered="$(find_primary_hub_pid)"
    if [ -n "$discovered" ]; then
      echo "$discovered" >"$PID_FILE"
      return 0
    fi
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  local discovered
  discovered="$(find_primary_hub_pid)"
  if [ -n "$discovered" ]; then
    echo "$discovered" >"$PID_FILE"
    return 0
  fi
  return 1
}

start_daemon() {
  load_config
  if is_running; then
    echo "hub daemon already running (pid $(cat "$PID_FILE"))"
    return 0
  fi

  rm -f "$PID_FILE"
  rm -f "$HUB_DEBUG_FILE"
  mkdir -p "$(dirname "$HUB_STDOUT_LOG")"
  touch "$HUB_STDOUT_LOG"

  (
    cd "$SRC_DIR"
    export PATH="$SRC_DIR/packages/hub/node_modules/.bin:$SRC_DIR/node_modules/.bin:$PATH:/usr/local/bin:/usr/bin:/bin"
    local node_bin
    node_bin="$(resolve_node_bin || true)"
    if [ -n "$node_bin" ]; then
      export PATH="$(dirname "$node_bin"):$PATH"
    fi
    unset npm_config_prefix
    export DEBUG="$HUB_DEBUG"
    export DEBUG_FILE="$HUB_DEBUG_FILE"
    export HOST="$HUB_BIND_HOST"
    if [ "$HUB_ALLOW_INSECURE_HTTP_MODE" = "1" ]; then
      export COCALC_ALLOW_INSECURE_HTTP_MODE=true
    fi
    export COCALC_DISABLE_NEXT="$HUB_DISABLE_NEXT"
    export PORT="$HUB_PORT"
    export COCALC_PROJECT_HOST_SOFTWARE_PACKAGES_ROOT="$HUB_SOFTWARE_PACKAGES_ROOT"
    if [ -n "$HUB_SOFTWARE_BASE_URL_FORCE" ]; then
      export COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE="$HUB_SOFTWARE_BASE_URL_FORCE"
    fi
    if [ -n "$HUB_SELF_HOST_PAIR_URL" ]; then
      export COCALC_SELF_HOST_PAIR_URL="$HUB_SELF_HOST_PAIR_URL"
    else
      export COCALC_SELF_HOST_PAIR_URL="http://127.0.0.1:$HUB_PORT"
    fi
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash -c "$HUB_CMD" >>"$HUB_STDOUT_LOG" 2>&1 < /dev/null &
    else
      nohup bash -c "$HUB_CMD" >>"$HUB_STDOUT_LOG" 2>&1 < /dev/null &
    fi
    echo $! >"$PID_FILE"
  )

  sleep 2
  local running_pid
  running_pid="$(find_primary_hub_pid)"
  if [ -n "$running_pid" ]; then
    echo "$running_pid" >"$PID_FILE"
  fi
  if is_running; then
    echo "hub daemon started (pid $(cat "$PID_FILE"))"
    echo "stdout: $HUB_STDOUT_LOG"
    echo "debug:  $HUB_DEBUG_FILE"
    if [ -n "$HUB_SOFTWARE_BASE_URL_FORCE" ]; then
      echo "software base (forced): $HUB_SOFTWARE_BASE_URL_FORCE"
    fi
    return 0
  fi

  echo "hub daemon failed to start; see $HUB_STDOUT_LOG" >&2
  return 1
}

stop_daemon() {
  if ! is_running; then
    echo "hub daemon is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid pids
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  pids="$(printf "%s\n%s\n" "$pid" "$(find_hub_pids)" | awk 'NF' | sort -u)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs -r kill >/dev/null 2>&1 || true
  fi

  local i
  for i in $(seq 1 30); do
    if ! is_running; then
      rm -f "$PID_FILE"
      echo "hub daemon stopped"
      return 0
    fi
    sleep 1
  done

  pids="$(printf "%s\n%s\n" "$pid" "$(find_hub_pids)" | awk 'NF' | sort -u)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs -r kill -9 >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
  echo "hub daemon killed"
}

show_status() {
  load_config
  if is_running; then
    echo "running (pid $(cat "$PID_FILE"))"
  else
    echo "stopped"
  fi
  echo "config: $CONFIG_FILE"
  echo "state:  $STATE_DIR"
  echo "stdout: $HUB_STDOUT_LOG"
  echo "debug:  $HUB_DEBUG_FILE"
  if [ -n "$HUB_SOFTWARE_BASE_URL_FORCE" ]; then
    echo "software base (forced): $HUB_SOFTWARE_BASE_URL_FORCE"
  fi
}

show_env() {
  load_config
  cat <<EOF
HUB_CMD=$HUB_CMD
HUB_PORT=$HUB_PORT
HUB_BIND_HOST=$HUB_BIND_HOST
HUB_ALLOW_INSECURE_HTTP_MODE=$HUB_ALLOW_INSECURE_HTTP_MODE
HUB_DISABLE_NEXT=$HUB_DISABLE_NEXT
HUB_DEBUG=$HUB_DEBUG
HUB_DEBUG_FILE=$HUB_DEBUG_FILE
HUB_STDOUT_LOG=$HUB_STDOUT_LOG
HUB_SOFTWARE_PACKAGES_ROOT=$HUB_SOFTWARE_PACKAGES_ROOT
HUB_USE_LOCAL_SOFTWARE=$HUB_USE_LOCAL_SOFTWARE
HUB_HOST_IP=$HUB_HOST_IP
HUB_SOFTWARE_BASE_URL_FORCE=$HUB_SOFTWARE_BASE_URL_FORCE
HUB_NODE_BIN=$HUB_NODE_BIN
HUB_SELF_HOST_PAIR_URL=$HUB_SELF_HOST_PAIR_URL
EOF
}

init_config() {
  if [ -f "$CONFIG_FILE" ]; then
    echo "config already exists: $CONFIG_FILE"
    return 0
  fi
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cp "$EXAMPLE_FILE" "$CONFIG_FILE"
  echo "created config: $CONFIG_FILE"
}

cmd="${1:-}"
case "$cmd" in
  init)
    init_config
    ;;
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    start_daemon
    ;;
  status)
    show_status
    ;;
  logs)
    load_config
    touch "$HUB_STDOUT_LOG"
    tail -f "$HUB_STDOUT_LOG"
    ;;
  env)
    show_env
    ;;
  *)
    usage
    exit 1
    ;;
esac
