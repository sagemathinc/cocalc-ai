#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=""
BAY_ID="bay-0"
BAY_USER="cocalc-bay"
BAY_GROUP="cocalc-bay"
BAY_ROOT_BASE="/mnt/cocalc/bays"
INSTALL_BASE="/opt/cocalc/bay"
RELEASE_ID=""
WORKER_COUNT=2
ENABLE_WORKERS=1
START_BAY=0
FORCE_ENV=0
OVERLAY_MODE="current-cocalc"
ROUTER_PORT=9102
PERSIST_PORT=9103
HUB_BASE_PORT=9200
PUBLIC_URL=""
DAEMON_RELOAD=1

usage() {
  cat <<'EOF'
Usage: bay-bootstrap-release.sh --source <built-src-root> [options]

Stage a built CoCalc src tree as a bay release, install the scaffold, and
write bay env/secrets files.

Options:
  --source <dir>           built src root to stage (required)
  --bay-id <id>            bay id (default: bay-0)
  --bay-user <user>        service user / db user (default: cocalc-bay)
  --bay-group <group>      service group (default: cocalc-bay)
  --bay-root-base <dir>    base dir for bay state (default: /mnt/cocalc/bays)
  --install-base <dir>     install base for releases/current (default: /opt/cocalc/bay)
  --release-id <id>        explicit release id (default: timestamp-gitshort)
  --worker-count <n>       worker count to write into bay-workers.env (default: 2)
  --router-port <n>        router port (default: 9102)
  --persist-port <n>       persist port (default: 9103)
  --hub-base-port <n>      base port for hub workers (default: 9200)
  --public-url <url>       optional public bay URL
  --force-env              overwrite generated env files
  --no-enable-workers      do not enable worker units
  --start                  start cocalc-bay.target after install
  --overlay <mode>         overlay mode passed to install-scaffold (default: current-cocalc)
  --no-daemon-reload       skip daemon-reload during scaffold install
  -h, --help               show help
EOF
}

run() {
  echo "+ $*"
  "$@"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run this script as root" >&2
    exit 1
  fi
}

find_postgres() {
  if command -v postgres >/dev/null 2>&1; then
    command -v postgres
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/postgres' 2>/dev/null | sort | tail -n1
}

find_pg_ctl() {
  if command -v pg_ctl >/dev/null 2>&1; then
    command -v pg_ctl
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/pg_ctl' 2>/dev/null | sort | tail -n1
}

find_psql() {
  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/psql' 2>/dev/null | sort | tail -n1
}

find_createdb() {
  if command -v createdb >/dev/null 2>&1; then
    command -v createdb
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/createdb' 2>/dev/null | sort | tail -n1
}

render_if_missing_or_forced() {
  local target="$1"
  if [[ "$FORCE_ENV" -eq 1 || ! -e "$target" ]]; then
    cat >"$target"
  else
    cat >/dev/null
  fi
}

random_secret() {
  openssl rand -hex 32
}

postgres_ready() {
  local psql_bin="$1"
  local socket_dir="$2"
  local db_user="$3"
  local db_port="$4"
  runuser -u "$BAY_USER" -- env \
    PGHOST="$socket_dir" \
    PGPORT="$db_port" \
    PGUSER="$db_user" \
    "$psql_bin" -d postgres -Atqc "SELECT 1" >/dev/null 2>&1
}

ensure_bay_database() {
  local pg_ctl_bin="$1"
  local psql_bin="$2"
  local createdb_bin="$3"
  local postgres_data_dir="$4"
  local postgres_socket_dir="$5"
  local postgres_port="$6"
  local postgres_log="$7"
  local db_user="$8"
  local db_name="$9"
  local started_here=0

  mkdir -p "$postgres_socket_dir" "$(dirname "$postgres_log")"
  chown "${BAY_USER}:${BAY_GROUP}" "$postgres_socket_dir" "$(dirname "$postgres_log")"

  if ! postgres_ready "$psql_bin" "$postgres_socket_dir" "$db_user" "$postgres_port"; then
    run runuser -u "$BAY_USER" -- "$pg_ctl_bin" \
      -D "$postgres_data_dir" \
      -l "$postgres_log" \
      -o "-k ${postgres_socket_dir} -h 127.0.0.1 -p ${postgres_port}" \
      -w start
    started_here=1
  fi

  local db_exists
  db_exists="$(
    runuser -u "$BAY_USER" -- env \
      PGHOST="$postgres_socket_dir" \
      PGPORT="$postgres_port" \
      PGUSER="$db_user" \
      "$psql_bin" -d postgres -Atqc \
        "SELECT 1 FROM pg_database WHERE datname = '$db_name'"
  )"
  if [[ "$db_exists" != "1" ]]; then
    run runuser -u "$BAY_USER" -- env \
      PGHOST="$postgres_socket_dir" \
      PGPORT="$postgres_port" \
      PGUSER="$db_user" \
      "$createdb_bin" -O "$db_user" "$db_name"
  fi

  if [[ "$started_here" -eq 1 ]]; then
    run runuser -u "$BAY_USER" -- "$pg_ctl_bin" -D "$postgres_data_dir" -m fast -w stop
  fi
}

derive_release_id() {
  local git_short
  git_short="$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  date +%Y%m%d%H%M%S
  printf -- "-%s" "$git_short"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --source)
        SOURCE_ROOT="$2"
        shift 2
        ;;
      --bay-id)
        BAY_ID="$2"
        shift 2
        ;;
      --bay-user)
        BAY_USER="$2"
        shift 2
        ;;
      --bay-group)
        BAY_GROUP="$2"
        shift 2
        ;;
      --bay-root-base)
        BAY_ROOT_BASE="$2"
        shift 2
        ;;
      --install-base)
        INSTALL_BASE="$2"
        shift 2
        ;;
      --release-id)
        RELEASE_ID="$2"
        shift 2
        ;;
      --worker-count)
        WORKER_COUNT="$2"
        shift 2
        ;;
      --router-port)
        ROUTER_PORT="$2"
        shift 2
        ;;
      --persist-port)
        PERSIST_PORT="$2"
        shift 2
        ;;
      --hub-base-port)
        HUB_BASE_PORT="$2"
        shift 2
        ;;
      --public-url)
        PUBLIC_URL="$2"
        shift 2
        ;;
      --force-env)
        FORCE_ENV=1
        shift
        ;;
      --no-enable-workers)
        ENABLE_WORKERS=0
        shift
        ;;
      --start)
        START_BAY=1
        shift
        ;;
      --overlay)
        OVERLAY_MODE="$2"
        shift 2
        ;;
      --no-daemon-reload)
        DAEMON_RELOAD=0
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  require_root

  if [[ -z "$SOURCE_ROOT" ]]; then
    echo "--source is required" >&2
    usage >&2
    exit 2
  fi

  if [[ ! -d "$SOURCE_ROOT/packages" ]]; then
    echo "source root must look like a built src tree: missing packages/" >&2
    exit 1
  fi

  if [[ -z "$RELEASE_ID" ]]; then
    RELEASE_ID="$(derive_release_id)"
  fi

  BAY_ROOT="${BAY_ROOT_BASE}/${BAY_ID}"
  RELEASES_DIR="${INSTALL_BASE}/releases"
  CURRENT_LINK="${INSTALL_BASE}/current"
  TARGET_RELEASE="${RELEASES_DIR}/${RELEASE_ID}"
  ENV_DIR="/etc/cocalc"
  POSTGRES_BIN="$(find_postgres)"
  PG_CTL_BIN="$(find_pg_ctl)"
  PSQL_BIN="$(find_psql)"
  CREATEDB_BIN="$(find_createdb)"
  if [[ -z "$POSTGRES_BIN" ]]; then
    echo "could not find postgres binary" >&2
    exit 1
  fi
  if [[ -z "$PG_CTL_BIN" || -z "$PSQL_BIN" || -z "$CREATEDB_BIN" ]]; then
    echo "could not find required postgres client tools (pg_ctl/psql/createdb)" >&2
    exit 1
  fi

  run mkdir -p "$TARGET_RELEASE"
  run rsync -a --delete \
    --exclude '.git' \
    --exclude '.local' \
    --exclude 'data' \
    --exclude '.build-home' \
    "${SOURCE_ROOT}/" "${TARGET_RELEASE}/"
  run ln -sfn "$TARGET_RELEASE" "$CURRENT_LINK"

  INSTALL_CMD=("${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh" "--overlay" "$OVERLAY_MODE")
  if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
    INSTALL_CMD+=("--daemon-reload")
  fi
  run "${INSTALL_CMD[@]}"

  run mkdir -p "${BAY_ROOT}/secrets" "${BAY_ROOT}/projects"
  run chown -R "${BAY_USER}:${BAY_GROUP}" "$BAY_ROOT" "${INSTALL_BASE}"

  if [[ ! -f "${BAY_ROOT}/secrets/conat-password" ]]; then
    random_secret > "${BAY_ROOT}/secrets/conat-password"
    chmod 0600 "${BAY_ROOT}/secrets/conat-password"
    chown "${BAY_USER}:${BAY_GROUP}" "${BAY_ROOT}/secrets/conat-password"
  fi

  ensure_bay_database \
    "$PG_CTL_BIN" \
    "$PSQL_BIN" \
    "$CREATEDB_BIN" \
    "${BAY_ROOT}/postgres" \
    "${BAY_ROOT}/run/postgres" \
    "5432" \
    "${BAY_ROOT}/logs/postgres-bootstrap.log" \
    "$BAY_USER" \
    "$BAY_USER"

  render_if_missing_or_forced "${ENV_DIR}/bay.env" <<EOF
COCALC_BAY_ID=${BAY_ID}
COCALC_BAY_ROOT=${BAY_ROOT}
COCALC_BAY_RELEASES_DIR=${RELEASES_DIR}
COCALC_BAY_CURRENT_LINK=${CURRENT_LINK}
COCALC_BAY_STATE_DIR=${BAY_ROOT}/state
COCALC_BAY_RUN_DIR=${BAY_ROOT}/run
COCALC_BAY_LOG_DIR=${BAY_ROOT}/logs
COCALC_BAY_BACKUP_DIR=${BAY_ROOT}/backups

COCALC_BAY_POSTGRES_HOST=127.0.0.1
COCALC_BAY_POSTGRES_PORT=5432
COCALC_BAY_POSTGRES_DATA_DIR=${BAY_ROOT}/postgres
COCALC_BAY_POSTGRES_SOCKET_DIR=${BAY_ROOT}/run/postgres
COCALC_BAY_POSTGRES_DB=${BAY_USER}
COCALC_BAY_POSTGRES_USER=${BAY_USER}

COCALC_BAY_PERSIST_HOST=127.0.0.1
COCALC_BAY_PERSIST_PORT=${PERSIST_PORT}
COCALC_BAY_PERSIST_HEALTH_PATH=/healthz

COCALC_BAY_ROUTER_HOST=127.0.0.1
COCALC_BAY_ROUTER_PORT=${ROUTER_PORT}
COCALC_BAY_ROUTER_HEALTH_PATH=/healthz

COCALC_BAY_HUB_BIND_HOST=127.0.0.1
COCALC_BAY_HUB_BASE_PORT=${HUB_BASE_PORT}
COCALC_BAY_HUB_HEALTH_PATH=/healthz

COCALC_BAY_MIN_HEALTHY_WORKERS=1
COCALC_BAY_HEALTH_TIMEOUT_S=5
COCALC_BAY_MIN_FREE_MB=1024

COCALC_PRODUCT=launchpad
COCALC_CLUSTER_ROLE=standalone
COCALC_CLUSTER_BAY_IDS=${BAY_ID}
COCALC_BAY_PUBLIC_URL=${PUBLIC_URL}
COCALC_DISABLE_NEXT=1

DATA=${BAY_ROOT}
COCALC_DATA_DIR=${BAY_ROOT}
PROJECTS=${BAY_ROOT}/projects/[project_id]
LOGS=${BAY_ROOT}/logs
SECRETS=${BAY_ROOT}/secrets
PGHOST=${BAY_ROOT}/run/postgres
PGPORT=5432
PGUSER=${BAY_USER}
PGDATABASE=${BAY_USER}
COCALC_DB=postgres
CONAT_SERVER=http://127.0.0.1:${ROUTER_PORT}

COCALC_BAY_POSTGRES_CMD='${POSTGRES_BIN} -D "\$COCALC_BAY_POSTGRES_DATA_DIR" -k "\$COCALC_BAY_POSTGRES_SOCKET_DIR" -h "\$COCALC_BAY_POSTGRES_HOST" -p "\$COCALC_BAY_POSTGRES_PORT"'
EOF

  render_if_missing_or_forced "${ENV_DIR}/bay-workers.env" <<EOF
COCALC_BAY_WORKER_COUNT=${WORKER_COUNT}
COCALC_BAY_WORKER_NODE_OPTIONS=
COCALC_BAY_WORKER_EXTRA_ENV=
EOF

  render_if_missing_or_forced "${ENV_DIR}/bay-secrets.env" <<EOF
COCALC_SESSION_SECRET=$(random_secret)
COCALC_COOKIE_SECRET=$(random_secret)
COCALC_CONAT_SHARED_SECRET=$(random_secret)
EOF
  chmod 0600 "${ENV_DIR}/bay-secrets.env"

  run systemctl enable cocalc-bay.target
  if [[ "$ENABLE_WORKERS" -eq 1 ]]; then
    for worker_id in $(seq 1 "$WORKER_COUNT"); do
      run systemctl enable "cocalc-bay-hub@${worker_id}.service"
    done
  fi

  if [[ "$START_BAY" -eq 1 ]]; then
    run systemctl start cocalc-bay.target
  fi

  cat <<EOF
Release bootstrap complete.

Source root:      ${SOURCE_ROOT}
Release id:       ${RELEASE_ID}
Target release:   ${TARGET_RELEASE}
Current link:     ${CURRENT_LINK}
Bay root:         ${BAY_ROOT}

Generated files:
  /etc/cocalc/bay.env
  /etc/cocalc/bay-workers.env
  /etc/cocalc/bay-secrets.env
  ${BAY_ROOT}/secrets/conat-password

Next steps:
  1. Review /etc/cocalc/bay.env
  2. Review /etc/cocalc/bay-overlay.env
  3. Verify migrations manually:
     ${CURRENT_LINK}/bin/bay-migrate
  4. Start the bay if not already started:
     systemctl start cocalc-bay.target
EOF
}

main "$@"
