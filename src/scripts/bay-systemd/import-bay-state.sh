#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/lib.sh
source "${SCRIPT_DIR}/bin/lib.sh"

INPUT_DIR=""
START_BAY=0
RECREATE_DB=1
PRUNE_CLOUDFLARE=1

usage() {
  cat <<'EOF'
Usage: import-bay-state.sh --input <dir> [options]

Import a previously exported launchpad-state bundle into the current bay.

Expected files in the input directory:
  - postgres.dump
  - sync.tar.gz          optional
  - secrets.tar.gz       optional
  - extra-secrets.tar.gz optional
  - manifest.json        optional

Options:
  --input <dir>       exported state directory (required)
  --start             start cocalc-bay.target after import
  --no-db-recreate    restore into the existing DB instead of drop/create
  --keep-cloudflare   preserve an existing launchpad-cloudflare secret tree
  -h, --help          show help
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

find_psql() {
  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/psql' 2>/dev/null | sort | tail -n1
}

find_pg_restore() {
  if command -v pg_restore >/dev/null 2>&1; then
    command -v pg_restore
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/pg_restore' 2>/dev/null | sort | tail -n1
}

find_dropdb() {
  if command -v dropdb >/dev/null 2>&1; then
    command -v dropdb
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/dropdb' 2>/dev/null | sort | tail -n1
}

find_createdb() {
  if command -v createdb >/dev/null 2>&1; then
    command -v createdb
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/createdb' 2>/dev/null | sort | tail -n1
}

postgres_ready() {
  local psql_bin="$1"
  runuser -u "${COCALC_BAY_POSTGRES_USER}" -- env \
    PGHOST="${COCALC_BAY_POSTGRES_SOCKET_DIR}" \
    PGPORT="${COCALC_BAY_POSTGRES_PORT}" \
    PGUSER="${COCALC_BAY_POSTGRES_USER}" \
    "$psql_bin" -d postgres -Atqc "SELECT 1" >/dev/null 2>&1
}

ensure_postgres() {
  local psql_bin="$1"
  run systemctl start cocalc-bay-postgres.service
  local deadline=$((SECONDS + COCALC_BAY_HEALTH_TIMEOUT_S))
  until postgres_ready "$psql_bin"; do
    if ((SECONDS >= deadline)); then
      bay_log "postgres is not ready"
      exit 1
    fi
    sleep 0.2
  done
}

stop_bay_units() {
  local targets=(
    cocalc-bay.target
    cocalc-bay-hub-workers.target
  )
  local units=(
    cocalc-bay-conat-persist.service
    cocalc-bay-conat-router.service
    cocalc-bay-migrations.service
  )
  local worker_ids=()
  local worker_id
  local deadline
  local unit
  local active

  mapfile -t worker_ids < <(enabled_worker_ids || true)
  if [[ "${#worker_ids[@]}" -eq 0 ]]; then
    for ((worker_id = 1; worker_id <= COCALC_BAY_WORKER_COUNT; worker_id += 1)); do
      worker_ids+=("${worker_id}")
    done
  fi

  for worker_id in "${worker_ids[@]}"; do
    units+=("cocalc-bay-hub@${worker_id}.service")
  done

  run systemctl stop --no-block "${targets[@]}" || true
  run systemctl stop --no-block "${units[@]}" || true
  run systemctl kill --kill-who=all --signal=SIGKILL "${units[@]}" || true
  deadline=$((SECONDS + COCALC_BAY_HEALTH_TIMEOUT_S))
  while :; do
    active=0
    for unit in "${units[@]}"; do
      if systemctl is-active --quiet "$unit"; then
        active=1
        break
      fi
    done
    if [[ "$active" -eq 0 ]]; then
      break
    fi
    if ((SECONDS >= deadline)); then
      bay_log "timed out waiting for bay units to stop"
      exit 1
    fi
    sleep 0.2
  done
  run systemctl reset-failed "${targets[@]}" "${units[@]}" || true
}

recreate_database() {
  local psql_bin="$1"
  local dropdb_bin="$2"
  local createdb_bin="$3"
  runuser -u "${COCALC_BAY_POSTGRES_USER}" -- env \
    PGHOST="${COCALC_BAY_POSTGRES_SOCKET_DIR}" \
    PGPORT="${COCALC_BAY_POSTGRES_PORT}" \
    PGUSER="${COCALC_BAY_POSTGRES_USER}" \
    "$psql_bin" -d postgres -v ON_ERROR_STOP=1 -c \
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PGDATABASE}' AND pid <> pg_backend_pid();" \
      >/dev/null
  run runuser -u "${COCALC_BAY_POSTGRES_USER}" -- env \
    PGHOST="${COCALC_BAY_POSTGRES_SOCKET_DIR}" \
    PGPORT="${COCALC_BAY_POSTGRES_PORT}" \
    PGUSER="${COCALC_BAY_POSTGRES_USER}" \
    "$dropdb_bin" --if-exists "${PGDATABASE}"
  run runuser -u "${COCALC_BAY_POSTGRES_USER}" -- env \
    PGHOST="${COCALC_BAY_POSTGRES_SOCKET_DIR}" \
    PGPORT="${COCALC_BAY_POSTGRES_PORT}" \
    PGUSER="${COCALC_BAY_POSTGRES_USER}" \
    "$createdb_bin" -O "${COCALC_BAY_POSTGRES_USER}" "${PGDATABASE}"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input)
        INPUT_DIR="$2"
        shift 2
        ;;
      --start)
        START_BAY=1
        shift
        ;;
      --no-db-recreate)
        RECREATE_DB=0
        shift
        ;;
      --keep-cloudflare)
        PRUNE_CLOUDFLARE=0
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
  ensure_dirs

  if [[ -z "$INPUT_DIR" ]]; then
    echo "--input is required" >&2
    exit 2
  fi
  if [[ ! -d "$INPUT_DIR" ]]; then
    echo "input dir does not exist: $INPUT_DIR" >&2
    exit 1
  fi
  if [[ ! -f "${INPUT_DIR}/postgres.dump" ]]; then
    echo "missing postgres dump: ${INPUT_DIR}/postgres.dump" >&2
    exit 1
  fi

  require_var COCALC_BAY_POSTGRES_SOCKET_DIR
  require_var COCALC_BAY_POSTGRES_USER
  require_var PGDATABASE
  require_var SECRETS

  local psql_bin pg_restore_bin dropdb_bin createdb_bin
  psql_bin="$(find_psql)"
  pg_restore_bin="$(find_pg_restore)"
  dropdb_bin="$(find_dropdb)"
  createdb_bin="$(find_createdb)"
  if [[ -z "$psql_bin" || -z "$pg_restore_bin" || -z "$dropdb_bin" || -z "$createdb_bin" ]]; then
    echo "required postgres client tools are missing" >&2
    exit 1
  fi

  stop_bay_units
  ensure_postgres "$psql_bin"

  if [[ "$RECREATE_DB" -eq 1 ]]; then
    recreate_database "$psql_bin" "$dropdb_bin" "$createdb_bin"
  fi

  run runuser -u "${COCALC_BAY_POSTGRES_USER}" -- env \
    PGHOST="${COCALC_BAY_POSTGRES_SOCKET_DIR}" \
    PGPORT="${COCALC_BAY_POSTGRES_PORT}" \
    PGUSER="${COCALC_BAY_POSTGRES_USER}" \
    PGDATABASE="${PGDATABASE}" \
    "$pg_restore_bin" \
      --no-owner \
      --role="${COCALC_BAY_POSTGRES_USER}" \
      --dbname="${PGDATABASE}" \
      "${INPUT_DIR}/postgres.dump"

  if [[ -f "${INPUT_DIR}/sync.tar.gz" ]]; then
    run tar -C "${COCALC_BAY_ROOT}" -xzf "${INPUT_DIR}/sync.tar.gz"
  fi

  if [[ -f "${INPUT_DIR}/secrets.tar.gz" ]]; then
    if [[ "$PRUNE_CLOUDFLARE" -eq 1 && -d "${SECRETS}/launchpad-cloudflare" ]]; then
      run rm -rf "${SECRETS}/launchpad-cloudflare"
    fi
    run tar -C "${COCALC_BAY_ROOT}" -xzf "${INPUT_DIR}/secrets.tar.gz"
  fi

  if [[ -f "${INPUT_DIR}/extra-secrets.tar.gz" ]]; then
    run mkdir -p "${COCALC_BAY_ROOT}/imported-extra-secrets"
    run tar -C "${COCALC_BAY_ROOT}/imported-extra-secrets" -xzf "${INPUT_DIR}/extra-secrets.tar.gz"
  fi

  if [[ -d "${COCALC_BAY_ROOT}/sync" ]]; then
    run chown -R "${COCALC_BAY_POSTGRES_USER}:${COCALC_BAY_POSTGRES_USER}" "${COCALC_BAY_ROOT}/sync"
  fi
  if [[ -d "${SECRETS}" ]]; then
    run chown -R "${COCALC_BAY_POSTGRES_USER}:${COCALC_BAY_POSTGRES_USER}" "${SECRETS}"
  fi
  if [[ -d "${COCALC_BAY_ROOT}/imported-extra-secrets" ]]; then
    run chown -R "${COCALC_BAY_POSTGRES_USER}:${COCALC_BAY_POSTGRES_USER}" "${COCALC_BAY_ROOT}/imported-extra-secrets"
  fi

  if [[ "$START_BAY" -eq 1 ]]; then
    run systemctl start cocalc-bay.target
  fi

  echo "bay state import complete from ${INPUT_DIR}"
}

main "$@"
