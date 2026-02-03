#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR/../../.." rev-parse --show-toplevel)"

TMP_REFLECT_DIR=""
if [ -n "${REFLECT_SYNC_DIR:-}" ]; then
  REFLECT_DIR="$REFLECT_SYNC_DIR"
else
  REFLECT_DIR="$(dirname "$REPO_ROOT")/reflect-sync"
fi

if [ ! -d "$REFLECT_DIR" ]; then
  echo "reflect-sync repo not found at $REFLECT_DIR" >&2
  echo "Cloning https://github.com/sagemathinc/reflect-sync ..." >&2
  TMP_REFLECT_DIR="$(mktemp -d)"
  git clone --depth 1 https://github.com/sagemathinc/reflect-sync "$TMP_REFLECT_DIR"
  REFLECT_DIR="$TMP_REFLECT_DIR"
fi

echo "Building reflect-sync bundle from $REFLECT_DIR"
(
  cd "$REFLECT_DIR"
  pnpm bundle
)

BUNDLE_FILE="$REFLECT_DIR/dist/bundle.mjs"
if [ ! -f "$BUNDLE_FILE" ]; then
  echo "Missing bundle artifact: $BUNDLE_FILE" >&2
  exit 1
fi

KEY="${COCALC_R2_REFLECT_BUNDLE_KEY:-software/reflect-sync/bundle.mjs}"
node "$REPO_ROOT/src/packages/cloud/scripts/publish-r2.js" \
  --file "$BUNDLE_FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/javascript; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"

if [ -n "$TMP_REFLECT_DIR" ]; then
  rm -rf "$TMP_REFLECT_DIR"
fi
