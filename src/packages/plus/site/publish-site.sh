#!/usr/bin/env bash
set -Eeuo pipefail

FILE="./index.html"
if [ ! -f "$FILE" ]; then
  echo "Site artifact not found: $FILE" >&2
  exit 1
fi

KEY="${COCALC_R2_SITE_KEY:-software/cocalc-plus/index.html}"

node ../../cloud/scripts/publish-r2.js \
  --file "$FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"
