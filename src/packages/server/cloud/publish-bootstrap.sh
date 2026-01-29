#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
BOOTSTRAP_PY="${ROOT}/packages/server/cloud/bootstrap/bootstrap.py"

if [ ! -f "$BOOTSTRAP_PY" ]; then
  echo "bootstrap.py not found at $BOOTSTRAP_PY" >&2
  exit 1
fi

SELECTOR="${COCALC_BOOTSTRAP_SELECTOR:-latest}"
PREFIX="${COCALC_R2_PREFIX:-software/bootstrap/${SELECTOR}}"
PUBLISH="${ROOT}/packages/cloud/scripts/publish-r2.js"

if [ ! -f "$PUBLISH" ]; then
  echo "publish-r2.js not found at $PUBLISH" >&2
  exit 1
fi

ARGS=(
  --file "$BOOTSTRAP_PY"
  --bucket "${COCALC_R2_BUCKET:-}"
  --prefix "$PREFIX"
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}"
)

if [ -n "${COCALC_BOOTSTRAP_CACHE_CONTROL:-}" ]; then
  ARGS+=(--cache-control "${COCALC_BOOTSTRAP_CACHE_CONTROL}")
fi

node "$PUBLISH" "${ARGS[@]}"
