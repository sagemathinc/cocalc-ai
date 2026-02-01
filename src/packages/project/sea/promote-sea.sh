#!/usr/bin/env bash
set -Eeuo pipefail

OS="linux"

STAGING_KEY="${COCALC_R2_STAGING_KEY:-software/project/staging-${OS}.json}"
LATEST_KEY="${COCALC_R2_LATEST_KEY:-software/project/latest-${OS}.json}"

node ../../cloud/scripts/publish-r2.js \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --copy-from "$STAGING_KEY" \
  --copy-to "$LATEST_KEY"
