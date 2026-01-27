#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-pglite}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DATA_BASE_DEFAULT="$SRC_ROOT/data/app"

unset DATA COCALC_ROOT
export DEBUG="${DEBUG:='cocalc:*,-cocalc:silly:*'}"
export NODE_ENV="${NODE_ENV:=development}"
export NODE_NO_WARNINGS=1
export NODE_OPTIONS='--openssl-legacy-provider --max_old_space_size=8000 --trace-warnings --enable-source-maps --inspect'
export COCALC_PRODUCT=launchpad
unset PGHOST PGUSER PGDATABASE PGDATA PGPASSWORD

DATA_BASE="${DATA_BASE:=$DATA_BASE_DEFAULT}"

case "$MODE" in
  pglite)
    DATA="${DATA:=$DATA_BASE/pglite}"
    mkdir -p "$DATA"
    export DATA="$(realpath "$DATA")"
    export COCALC_DATA_DIR="${COCALC_DATA_DIR:=$DATA}"
    export COCALC_DB=pglite
    export COCALC_PGLITE_DATA_DIR="${COCALC_PGLITE_DATA_DIR:=$DATA/pglite}"
    ;;
  postgres)
    DATA="${DATA:=$DATA_BASE/postgres}"
    mkdir -p "$DATA"
    export DATA
    export DATA="$(realpath "$DATA")"
    export COCALC_DATA_DIR="${COCALC_DATA_DIR:=$DATA}"
    export COCALC_DB=postgres
    export COCALC_LOCAL_POSTGRES=1
    SOCKET_BASE="${XDG_RUNTIME_DIR:-$HOME/.local/share}"
    if command -v sha256sum >/dev/null 2>&1; then
      SOCKET_SUFFIX="$(printf "%s" "$DATA" | sha256sum | cut -c1-8)"
    elif command -v shasum >/dev/null 2>&1; then
      SOCKET_SUFFIX="$(printf "%s" "$DATA" | shasum -a 256 | cut -c1-8)"
    else
      SOCKET_SUFFIX="$(printf "%s" "$DATA" | cksum | awk '{print $1}' | cut -c1-8)"
    fi
    SOCKET_DIR="${COCALC_LOCAL_PG_SOCKET_DIR:-$SOCKET_BASE/cocalc/pg-$SOCKET_SUFFIX}"
    export COCALC_LOCAL_PG_SOCKET_DIR="${COCALC_LOCAL_PG_SOCKET_DIR:=$SOCKET_DIR}"
    export PGHOST="${PGHOST:=$SOCKET_DIR}"
    export PGUSER="${PGUSER:=smc}"
    export PGDATABASE="${PGDATABASE:=smc}"
    ;;
  *)
    echo "usage: $0 [pglite|postgres]" >&2
    exit 2
    ;;
esac

cocalc-hub-server --all --hostname="${HOST:=localhost}"
