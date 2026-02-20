#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR_DEFAULT="$SRC_DIR/.local/lite-daemon"
CONFIG_FILE_DEFAULT="$SRC_DIR/.local/lite-daemon.env"
EXAMPLE_FILE="$SCRIPT_DIR/lite-daemon.env.example"

STATE_DIR="${COCALC_LITE_DAEMON_STATE_DIR:-$STATE_DIR_DEFAULT}"
CONFIG_FILE="${COCALC_LITE_DAEMON_CONFIG:-$CONFIG_FILE_DEFAULT}"

mkdir -p "$STATE_DIR"

PID_FILE="$STATE_DIR/lite.pid"

usage() {
  cat <<EOF
Usage: $(basename "$0") <init|start|stop|restart|status|logs|env>

Config file: $CONFIG_FILE
State dir:   $STATE_DIR
EOF
}

load_config() {
  if [ -f "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
  fi

  local scratch_default
  scratch_default="$HOME/scratch/$(basename "$(dirname "$SRC_DIR")")-lite-daemon"

  LITE_CMD="${LITE_CMD:-./packages/lite/bin/start.js}"
  LITE_HOST="${LITE_HOST:-localhost}"
  LITE_PORT="${LITE_PORT:-}"
  LITE_AUTH_TOKEN="${LITE_AUTH_TOKEN:-}"
  LITE_HOME="${LITE_HOME:-$scratch_default}"
  LITE_CONNECTION_INFO="${LITE_CONNECTION_INFO:-$STATE_DIR/connection-info.json}"
  LITE_DEBUG="${LITE_DEBUG:-}"
  LITE_NODE_BIN="${LITE_NODE_BIN:-}"
  LITE_STDOUT_LOG="${LITE_STDOUT_LOG:-$STATE_DIR/lite.stdout.log}"
  LITE_DB_PATH="$LITE_HOME/.local/share/cocalc-lite/hub.db"
}

resolve_node_bin() {
  if [ -n "${LITE_NODE_BIN:-}" ] && [ -x "$LITE_NODE_BIN" ]; then
    echo "$LITE_NODE_BIN"
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

pid_looks_like_lite() {
  local pid="${1:-}"
  if [ -z "$pid" ] || [ ! -r "/proc/$pid/cmdline" ]; then
    return 1
  fi
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q "packages/lite/bin/start.js"
}

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi
  if ! pid_looks_like_lite "$pid"; then
    return 1
  fi
  return 0
}

print_connection_info_summary() {
  if [ ! -f "$LITE_CONNECTION_INFO" ]; then
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const path = process.argv[1];
      try {
        const info = JSON.parse(fs.readFileSync(path, "utf8"));
        const host = info.host || "localhost";
        const protocol = info.protocol === "https" ? "https" : "http";
        const port = Number(info.port) || "";
        const token = info.token ? "set" : "empty";
        const url = info.url || (port ? `${protocol}://${host}:${port}` : "");
        console.log(`connection info: ${path}`);
        if (url) console.log(`url:            ${url}`);
        console.log(`auth token:     ${token}`);
      } catch (_) {}
    ' "$LITE_CONNECTION_INFO" || true
  fi
}

start_daemon() {
  load_config
  if is_running; then
    echo "lite daemon already running (pid $(cat "$PID_FILE"))"
    print_connection_info_summary
    return 0
  fi

  rm -f "$PID_FILE"
  if [ -n "$LITE_CONNECTION_INFO" ]; then
    rm -f "$LITE_CONNECTION_INFO"
  fi
  mkdir -p "$LITE_HOME"
  mkdir -p "$(dirname "$LITE_STDOUT_LOG")"
  mkdir -p "$(dirname "$LITE_CONNECTION_INFO")"
  touch "$LITE_STDOUT_LOG"

  (
    cd "$SRC_DIR"
    export PATH="$SRC_DIR/packages/lite/node_modules/.bin:$SRC_DIR/node_modules/.bin:$PATH:/usr/local/bin:/usr/bin:/bin"
    local node_bin
    node_bin="$(resolve_node_bin || true)"
    if [ -n "$node_bin" ]; then
      export PATH="$(dirname "$node_bin"):$PATH"
    fi
    unset npm_config_prefix

    # Preserve true user home/path so lite can still discover host context.
    export COCALC_ORIGINAL_HOME="${COCALC_ORIGINAL_HOME:-$HOME}"
    export COCALC_ORIGINAL_PATH="${COCALC_ORIGINAL_PATH:-$PATH}"

    export HOME="$LITE_HOME"
    export HOST="$LITE_HOST"
    if [ -n "$LITE_PORT" ]; then
      export PORT="$LITE_PORT"
    fi
    if [ -n "$LITE_AUTH_TOKEN" ]; then
      export AUTH_TOKEN="$LITE_AUTH_TOKEN"
    fi
    if [ -n "$LITE_CONNECTION_INFO" ]; then
      export COCALC_WRITE_CONNECTION_INFO="$LITE_CONNECTION_INFO"
    fi
    if [ -n "$LITE_DEBUG" ]; then
      export DEBUG="$LITE_DEBUG"
    fi

    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash -lc "$LITE_CMD" >>"$LITE_STDOUT_LOG" 2>&1 < /dev/null &
    else
      nohup bash -lc "$LITE_CMD" >>"$LITE_STDOUT_LOG" 2>&1 < /dev/null &
    fi
    echo $! >"$PID_FILE"
  )

  local i
  for i in $(seq 1 30); do
    if is_running; then
      break
    fi
    sleep 1
  done

  if is_running; then
    echo "lite daemon started (pid $(cat "$PID_FILE"))"
    echo "stdout: $LITE_STDOUT_LOG"
    echo "home:   $LITE_HOME"
    print_connection_info_summary
    return 0
  fi

  echo "lite daemon failed to start; see $LITE_STDOUT_LOG" >&2
  return 1
}

stop_daemon() {
  load_config
  if ! is_running; then
    echo "lite daemon is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    echo "lite daemon pid file is empty; clearing state"
    rm -f "$PID_FILE"
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true

  local i
  for i in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      echo "lite daemon stopped"
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
  echo "lite daemon killed"
}

show_status() {
  load_config
  if is_running; then
    echo "running (pid $(cat "$PID_FILE"))"
  else
    echo "stopped"
  fi
  echo "config:         $CONFIG_FILE"
  echo "state:          $STATE_DIR"
  echo "home:           $LITE_HOME"
  echo "stdout:         $LITE_STDOUT_LOG"
  echo "connection:     $LITE_CONNECTION_INFO"
  echo "sqlite db:      $LITE_DB_PATH"
  print_connection_info_summary
}

show_env() {
  load_config
  cat <<EOF
LITE_CMD=$LITE_CMD
LITE_HOST=$LITE_HOST
LITE_PORT=$LITE_PORT
LITE_AUTH_TOKEN=$LITE_AUTH_TOKEN
LITE_HOME=$LITE_HOME
LITE_CONNECTION_INFO=$LITE_CONNECTION_INFO
LITE_DB_PATH=$LITE_DB_PATH
LITE_DEBUG=$LITE_DEBUG
LITE_NODE_BIN=$LITE_NODE_BIN
LITE_STDOUT_LOG=$LITE_STDOUT_LOG
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
    touch "$LITE_STDOUT_LOG"
    tail -f "$LITE_STDOUT_LOG"
    ;;
  env)
    show_env
    ;;
  *)
    usage
    exit 1
    ;;
esac
