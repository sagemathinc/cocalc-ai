#!/usr/bin/env bash
set -euo pipefail

export DEBUG_CONSOLE=yes
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR_DEFAULT="$SRC_DIR/.local/hub-daemon"
CONFIG_FILE_DEFAULT="$SRC_DIR/.local/hub-daemon.env"
EXAMPLE_FILE="$SCRIPT_DIR/hub-daemon.env.example"

STATE_DIR="${COCALC_HUB_DAEMON_STATE_DIR:-$STATE_DIR_DEFAULT}"
CONFIG_FILE="${COCALC_HUB_DAEMON_CONFIG:-$CONFIG_FILE_DEFAULT}"

mkdir -p "$STATE_DIR"

PID_FILE="$STATE_DIR/hub.pid"

rotate_log_file() {
  local file="${1:-}"
  if [ -z "$file" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$file")"
  rm -f "$file.2"
  if [ -f "$file.1" ]; then
    mv -f "$file.1" "$file.2"
  fi
  if [ -f "$file" ] && [ -s "$file" ]; then
    mv -f "$file" "$file.1"
  else
    rm -f "$file"
  fi
}

find_hub_pids() {
  ps -eo pid=,args= \
    | awk -v hub_root="$SRC_DIR/packages/hub" '
        index($0, hub_root) > 0 && $0 ~ /run\/hub\.js/ { print $1 }
      ' \
    || true
}

port_hex() {
  local port="${1:-}"
  if [ -z "$port" ]; then
    return 1
  fi
  printf '%04X\n' "$port"
}

pid_listens_on_port_via_proc() {
  local pid="${1:-}"
  local port="${2:-}"
  if [ -z "$pid" ] || [ -z "$port" ] || [ ! -d "/proc/$pid" ]; then
    return 1
  fi

  local port_hex_value inodes inode proc_file
  port_hex_value="$(port_hex "$port" 2>/dev/null || true)"
  if [ -z "$port_hex_value" ]; then
    return 1
  fi

  inodes="$(
    find "/proc/$pid/fd" -maxdepth 1 -type l -printf '%l\n' 2>/dev/null \
      | sed -n 's/^socket:\[\([0-9][0-9]*\)\]$/\1/p' \
      | sort -u
  )"
  if [ -z "$inodes" ]; then
    return 1
  fi

  for proc_file in "/proc/$pid/net/tcp" "/proc/$pid/net/tcp6"; do
    if [ ! -r "$proc_file" ]; then
      continue
    fi
    while read -r inode; do
      if printf "%s\n" "$inodes" | grep -qx "$inode"; then
        return 0
      fi
    done < <(
      awk -v port_hex="$port_hex_value" '
        NR > 1 {
          split($2, local_addr, ":");
          if (toupper(local_addr[2]) == port_hex && $4 == "0A") {
            print $10;
          }
        }
      ' "$proc_file" 2>/dev/null
    )
  done

  return 1
}

find_pids_listening_on_port_via_proc() {
  local port="${1:-}"
  local pid
  if [ -z "$port" ]; then
    return 0
  fi
  for pid in /proc/[0-9]*; do
    pid="${pid#/proc/}"
    if pid_listens_on_port_via_proc "$pid" "$port"; then
      echo "$pid"
    fi
  done | sort -u
}

find_pids_listening_on_port() {
  local port="${1:-}"
  if [ -z "$port" ]; then
    return 0
  fi
  local pids
  pids="$(
    ss -ltnp "( sport = :$port )" 2>/dev/null \
      | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
      | sort -u || true
  )"
  if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)"
  fi
  if [ -z "$pids" ]; then
    pids="$(find_pids_listening_on_port_via_proc "$port" || true)"
  fi
  if [ -n "$pids" ]; then
    echo "$pids"
  fi
}

find_hub_pids_on_config_port() {
  local port="${HUB_PORT:-9100}"
  local hub_pids port_pids pid
  hub_pids="$(find_hub_pids | sort -u)"
  port_pids="$(find_pids_listening_on_port "$port" || true)"
  if [ -z "$hub_pids" ] || [ -z "$port_pids" ]; then
    return 0
  fi
  for pid in $port_pids; do
    if printf "%s\n" "$hub_pids" | grep -qx "$pid"; then
      echo "$pid"
    fi
  done
}

find_primary_hub_pid() {
  find_hub_pids_on_config_port | tail -n 1
}

current_hub_pid() {
  if is_running; then
    cat "$PID_FILE" 2>/dev/null || true
  fi
}

get_env_from_pid() {
  local pid="${1:-}"
  local key="${2:-}"
  if [ -z "$pid" ] || [ -z "$key" ] || [ ! -r "/proc/$pid/environ" ]; then
    return 0
  fi
  tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null \
    | sed -n "s/^${key}=//p" \
    | head -n 1
}

find_latest_in_log() {
  local file="${1:-}"
  local sed_expr="${2:-}"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    return 0
  fi
  tail -n 20000 "$file" 2>/dev/null | sed -n "$sed_expr" | tail -n 1
}

detect_hub_postgres_socket_dir() {
  local pid pg_host
  pid="$(current_hub_pid || true)"
  pg_host="$(get_env_from_pid "$pid" "PGHOST" || true)"
  if [ -n "$pg_host" ]; then
    echo "$pg_host"
    return 0
  fi
  find_latest_in_log "$HUB_STDOUT_LOG" "s/.*socketDir: '\\([^']*\\)'.*/\\1/p"
}

detect_hub_postgres_data_dir() {
  local pid data_dir
  pid="$(current_hub_pid || true)"
  data_dir="$(get_env_from_pid "$pid" "DATA" || true)"
  if [ -n "$data_dir" ]; then
    echo "$data_dir/postgres"
    return 0
  fi
  data_dir="$(get_env_from_pid "$pid" "COCALC_DATA_DIR" || true)"
  if [ -n "$data_dir" ]; then
    if [ -d "$data_dir/postgres" ]; then
      echo "$data_dir/postgres"
    else
      echo "$data_dir"
    fi
    return 0
  fi
  local env_file data_base
  for env_file in \
    "$SRC_DIR/data/app/postgres/local-postgres.env" \
    "$SRC_DIR/data/postgres/local-postgres.env"
  do
    if [ -f "$env_file" ]; then
      data_base="$(
        sed -n \
          -e 's/^export COCALC_DATA_DIR=//p' \
          -e 's/^export DATA=//p' \
          "$env_file" \
          | head -n 1
      )"
      if [ -n "$data_base" ]; then
        if [ -d "$data_base/postgres" ]; then
          echo "$data_base/postgres"
        else
          echo "$data_base"
        fi
        return 0
      fi
    fi
  done
  find_latest_in_log "$HUB_STDOUT_LOG" "s/.*dataDir: '\\([^']*\\)'.*/\\1/p"
}

detect_hub_public_hostname() {
  find_latest_in_log "$HUB_STDOUT_LOG" "s/.*hostname: '\\([^']*\\)'.*/\\1/p"
}

detect_hub_bootstrap_signup_url() {
  if [ ! -f "$HUB_STDOUT_LOG" ]; then
    return 0
  fi
  tail -n 20000 "$HUB_STDOUT_LOG" 2>/dev/null \
    | grep -Eo 'https?://[^[:space:]]+/auth/sign-up\?registrationToken=[^[:space:]]*bootstrap=1[^[:space:]]*' \
    | tail -n 1
}

print_bootstrap_signup_url() {
  local signup_url
  signup_url="$(detect_hub_bootstrap_signup_url || true)"
  if [ -n "$signup_url" ]; then
    echo "bootstrap sign-up url:"
    echo "  $signup_url"
  fi
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <init|start|stop|restart|build|status|logs|env>

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
  local from_hostname
  from_hostname="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$from_hostname" ]; then
    echo "$from_hostname"
    return 0
  fi
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2; exit}'
  fi
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
  HUB_AUTO_BUILD_LOCAL_SOFTWARE="${HUB_AUTO_BUILD_LOCAL_SOFTWARE:-1}"
  HUB_HOST_IP="${HUB_HOST_IP:-}"
  HUB_SOFTWARE_BASE_URL_FORCE="${HUB_SOFTWARE_BASE_URL_FORCE:-}"
  HUB_NODE_BIN="${HUB_NODE_BIN:-}"
  HUB_SELF_HOST_PAIR_URL="${HUB_SELF_HOST_PAIR_URL:-}"
  HUB_CLOUDFLARED_PID_FILE="${HUB_CLOUDFLARED_PID_FILE:-$STATE_DIR/cloudflared.pid}"
  COCALC_BAY_ID="${COCALC_BAY_ID:-bay-0}"
  COCALC_BAY_LABEL="${COCALC_BAY_LABEL:-}"
  COCALC_BAY_REGION="${COCALC_BAY_REGION:-}"
  COCALC_CLUSTER_ROLE="${COCALC_CLUSTER_ROLE:-standalone}"
  COCALC_CLUSTER_SEED_BAY_ID="${COCALC_CLUSTER_SEED_BAY_ID:-}"
  COCALC_CLUSTER_SEED_CONAT_SERVER="${COCALC_CLUSTER_SEED_CONAT_SERVER:-}"
  COCALC_CLUSTER_SEED_CONAT_PASSWORD="${COCALC_CLUSTER_SEED_CONAT_PASSWORD:-}"

  if [ -z "$HUB_SOFTWARE_BASE_URL_FORCE" ] && [ "$HUB_USE_LOCAL_SOFTWARE" = "1" ]; then
    if [ -n "$HUB_SELF_HOST_PAIR_URL" ]; then
      HUB_SOFTWARE_BASE_URL_FORCE="${HUB_SELF_HOST_PAIR_URL%/}/software"
    elif [ "$HUB_BIND_HOST" = "localhost" ] || [ "$HUB_BIND_HOST" = "127.0.0.1" ] || [ "$HUB_BIND_HOST" = "::1" ]; then
      # Hub is loopback-only, so local software URLs must also be loopback.
      HUB_SOFTWARE_BASE_URL_FORCE="http://127.0.0.1:$HUB_PORT/software"
    else
      if [ -z "$HUB_HOST_IP" ]; then
        HUB_HOST_IP="$(detect_host_ip || true)"
      fi
      if [ -n "$HUB_HOST_IP" ]; then
        HUB_SOFTWARE_BASE_URL_FORCE="http://$HUB_HOST_IP:$HUB_PORT/software"
      fi
    fi
  fi
}

stop_cloudflared() {
  local pid_file="${HUB_CLOUDFLARED_PID_FILE:-$STATE_DIR/cloudflared.pid}"
  if [ ! -f "$pid_file" ]; then
    return 0
  fi
  local pid
  pid="$(tr -dc '0-9' < "$pid_file" | head -c 16 || true)"
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    return 0
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    local i
    for i in $(seq 1 20); do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    echo "cloudflared stopped (pid $pid)"
  fi
  rm -f "$pid_file"
}

have_local_tools_bundle() {
  local root="$1"
  if compgen -G "$root/project/build/tools-linux-*.tar.xz" >/dev/null 2>&1; then
    return 0
  fi
  if compgen -G "$root/project/build/tools-minimal-linux-*.tar.xz" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

ensure_local_software_artifacts() {
  if [ "$HUB_USE_LOCAL_SOFTWARE" != "1" ]; then
    return 0
  fi
  if [ "$HUB_AUTO_BUILD_LOCAL_SOFTWARE" != "1" ]; then
    return 0
  fi

  local configured_root source_root
  configured_root="$(realpath "$HUB_SOFTWARE_PACKAGES_ROOT" 2>/dev/null || true)"
  source_root="$(realpath "$SRC_DIR/packages" 2>/dev/null || true)"
  if [ -z "$configured_root" ] || [ ! -d "$configured_root" ]; then
    echo "hub daemon: HUB_SOFTWARE_PACKAGES_ROOT is not a directory: $HUB_SOFTWARE_PACKAGES_ROOT" >&2
    return 0
  fi
  if [ -z "$source_root" ] || [ "$configured_root" != "$source_root" ]; then
    echo "hub daemon: skipping auto-build for non-local software root: $HUB_SOFTWARE_PACKAGES_ROOT"
    return 0
  fi

  local need_project_host_bundle=0
  local need_project_bundle=0
  local need_tools_bundle=0
  [ -f "$source_root/project-host/build/bundle-linux.tar.xz" ] || need_project_host_bundle=1
  [ -f "$source_root/project/build/bundle-linux.tar.xz" ] || need_project_bundle=1
  if ! have_local_tools_bundle "$source_root"; then
    need_tools_bundle=1
  fi

  if [ "$need_project_host_bundle" = "0" ] \
    && [ "$need_project_bundle" = "0" ] \
    && [ "$need_tools_bundle" = "0" ]; then
    return 0
  fi

  echo "hub daemon: local software artifacts missing; building now..."
  if [ "$need_project_host_bundle" = "1" ]; then
    echo "  - building project-host bundle"
    pnpm --dir "$SRC_DIR/packages/project-host" build:bundle
  fi
  if [ "$need_project_bundle" = "1" ]; then
    echo "  - building project bundle"
    pnpm --dir "$SRC_DIR/packages/project" build:bundle
  fi
  if [ "$need_tools_bundle" = "1" ]; then
    echo "  - building tools bundle"
    pnpm --dir "$SRC_DIR/packages/project" build:tools
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
  load_config
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
  local port_match
  port_match="$(find_hub_pids_on_config_port | grep -x "$pid" || true)"
  if kill -0 "$pid" >/dev/null 2>&1 && [ -n "$port_match" ]; then
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

  ensure_local_software_artifacts

  rm -f "$PID_FILE"
  mkdir -p "$(dirname "$HUB_STDOUT_LOG")"
  rotate_log_file "$HUB_STDOUT_LOG"
  if [ -n "$HUB_DEBUG_FILE" ]; then
    rotate_log_file "$HUB_DEBUG_FILE"
  fi
  touch "$HUB_STDOUT_LOG"
  if [ -n "$HUB_DEBUG_FILE" ]; then
    touch "$HUB_DEBUG_FILE"
  fi

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
    export COCALC_BAY_ID
    if [ -n "$COCALC_BAY_LABEL" ]; then
      export COCALC_BAY_LABEL
    else
      unset COCALC_BAY_LABEL
    fi
    if [ -n "$COCALC_BAY_REGION" ]; then
      export COCALC_BAY_REGION
    else
      unset COCALC_BAY_REGION
    fi
    export COCALC_CLUSTER_ROLE
    if [ -n "$COCALC_CLUSTER_SEED_BAY_ID" ]; then
      export COCALC_CLUSTER_SEED_BAY_ID
    else
      unset COCALC_CLUSTER_SEED_BAY_ID
    fi
    if [ -n "$COCALC_CLUSTER_SEED_CONAT_SERVER" ]; then
      export COCALC_CLUSTER_SEED_CONAT_SERVER
    else
      unset COCALC_CLUSTER_SEED_CONAT_SERVER
    fi
    if [ -n "$COCALC_CLUSTER_SEED_CONAT_PASSWORD" ]; then
      export COCALC_CLUSTER_SEED_CONAT_PASSWORD
    else
      unset COCALC_CLUSTER_SEED_CONAT_PASSWORD
    fi
    if [ -n "$HUB_SOFTWARE_BASE_URL_FORCE" ]; then
      export COCALC_PROJECT_HOST_SOFTWARE_BASE_URL_FORCE="$HUB_SOFTWARE_BASE_URL_FORCE"
    fi
    if [ -n "$HUB_SELF_HOST_PAIR_URL" ]; then
      export COCALC_SELF_HOST_PAIR_URL="$HUB_SELF_HOST_PAIR_URL"
    else
      export COCALC_SELF_HOST_PAIR_URL="http://127.0.0.1:$HUB_PORT"
    fi
    export COCALC_LAUNCHPAD_CLOUDFLARED_PID_FILE="$HUB_CLOUDFLARED_PID_FILE"
    if command -v setsid >/dev/null 2>&1; then
      nohup setsid bash -c "$HUB_CMD" >>"$HUB_STDOUT_LOG" 2>&1 < /dev/null &
    else
      nohup bash -c "$HUB_CMD" >>"$HUB_STDOUT_LOG" 2>&1 < /dev/null &
    fi
    echo $! >"$PID_FILE"
  )

  local running_pid=""
  local i
  for i in $(seq 1 30); do
    running_pid="$(find_primary_hub_pid || true)"
    if [ -n "$running_pid" ]; then
      echo "$running_pid" >"$PID_FILE"
      break
    fi
    sleep 1
  done
  if is_running; then
    echo "hub daemon started (pid $(cat "$PID_FILE"))"
    echo "stdout: $HUB_STDOUT_LOG"
    echo "debug:  $HUB_DEBUG_FILE"
    if [ -n "$HUB_SOFTWARE_BASE_URL_FORCE" ]; then
      echo "software base (forced): $HUB_SOFTWARE_BASE_URL_FORCE"
    fi
    print_bootstrap_signup_url
    return 0
  fi

  echo "hub daemon failed to start; see $HUB_STDOUT_LOG" >&2
  return 1
}

build_daemon() {
  load_config
  (
    cd "$SRC_DIR"
    pnpm build
    pnpm --dir "$SRC_DIR/packages/project-host" build:bundle
    pnpm --dir "$SRC_DIR/packages/project" build:bundle
    stop_daemon 1
    start_daemon
    eval "$(pnpm -s dev:env:hub)"
    cocalc host upgrade --hub-source --wait --all-online
  )
}

stop_daemon() {
  local keep_cloudflared="${1:-0}"
  load_config
  local stopped=0
  if ! is_running; then
    echo "hub daemon is not running"
    rm -f "$PID_FILE"
    stopped=1
  else
    local pid pids
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    pids="$(printf "%s\n%s\n" "$pid" "$(find_hub_pids_on_config_port)" | awk 'NF' | sort -u)"
    if [ -n "$pids" ]; then
      echo "$pids" | xargs -r kill >/dev/null 2>&1 || true
    fi

    local i
    for i in $(seq 1 30); do
      if ! is_running; then
        rm -f "$PID_FILE"
        echo "hub daemon stopped"
        stopped=1
        break
      fi
      sleep 1
    done

    if [ "$stopped" != "1" ]; then
      pids="$(printf "%s\n%s\n" "$pid" "$(find_hub_pids_on_config_port)" | awk 'NF' | sort -u)"
      if [ -n "$pids" ]; then
        echo "$pids" | xargs -r kill -9 >/dev/null 2>&1 || true
      fi
      rm -f "$PID_FILE"
      echo "hub daemon killed"
    fi
  fi

  if [ "$keep_cloudflared" != "1" ]; then
    stop_cloudflared
  fi
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
  echo "bay id: $COCALC_BAY_ID"
  echo "cluster role: $COCALC_CLUSTER_ROLE"
  if [ -n "$COCALC_CLUSTER_SEED_BAY_ID" ]; then
    echo "cluster seed bay: $COCALC_CLUSTER_SEED_BAY_ID"
  fi
  if [ -n "$COCALC_CLUSTER_SEED_CONAT_SERVER" ]; then
    echo "cluster seed fabric: $COCALC_CLUSTER_SEED_CONAT_SERVER"
  fi
  local hub_host hub_url public_hostname
  hub_host="$HUB_BIND_HOST"
  if [ "$hub_host" = "0.0.0.0" ] || [ -z "$hub_host" ]; then
    hub_host="127.0.0.1"
  fi
  hub_url="http://$hub_host:$HUB_PORT"
  echo "hub url: $hub_url"
  public_hostname="$(detect_hub_public_hostname || true)"
  if [ -n "$public_hostname" ]; then
    echo "public url: https://$public_hostname"
  fi
  print_bootstrap_signup_url
  local pg_host pg_data
  pg_host="$(detect_hub_postgres_socket_dir || true)"
  pg_data="$(detect_hub_postgres_data_dir || true)"
  if [ -n "$pg_host" ]; then
    echo "postgres socket (PGHOST): $pg_host"
    echo "postgres user   (PGUSER): smc"
    echo "psql hint: export PGHOST='$pg_host' PGUSER='smc'"
  else
    echo "postgres socket (PGHOST): not detected from $HUB_STDOUT_LOG"
    echo "postgres user   (PGUSER): smc"
    echo "hint: grep socketDir in hub log, then export PGHOST and PGUSER=smc"
  fi
  if [ -n "$pg_data" ]; then
    echo "postgres data dir: $pg_data"
  fi
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
HUB_AUTO_BUILD_LOCAL_SOFTWARE=$HUB_AUTO_BUILD_LOCAL_SOFTWARE
HUB_HOST_IP=$HUB_HOST_IP
HUB_SOFTWARE_BASE_URL_FORCE=$HUB_SOFTWARE_BASE_URL_FORCE
HUB_NODE_BIN=$HUB_NODE_BIN
HUB_SELF_HOST_PAIR_URL=$HUB_SELF_HOST_PAIR_URL
HUB_CLOUDFLARED_PID_FILE=$HUB_CLOUDFLARED_PID_FILE
COCALC_BAY_ID=$COCALC_BAY_ID
COCALC_BAY_LABEL=$COCALC_BAY_LABEL
COCALC_BAY_REGION=$COCALC_BAY_REGION
COCALC_CLUSTER_ROLE=$COCALC_CLUSTER_ROLE
COCALC_CLUSTER_SEED_BAY_ID=$COCALC_CLUSTER_SEED_BAY_ID
COCALC_CLUSTER_SEED_CONAT_SERVER=$COCALC_CLUSTER_SEED_CONAT_SERVER
COCALC_CLUSTER_SEED_CONAT_PASSWORD=$COCALC_CLUSTER_SEED_CONAT_PASSWORD
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
    stop_daemon 1
    start_daemon
    ;;
  build)
    build_daemon
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
