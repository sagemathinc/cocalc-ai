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
    ;;
  *)
    echo "usage: $0 [pglite|postgres]" >&2
    exit 2
    ;;
esac

cocalc-hub-server --all --hostname="${HOST:=localhost}"
