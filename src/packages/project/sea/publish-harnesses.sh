#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="$(node -p "require('../package.json').version")"
BUILD_DIR="../build"
ARCH="${COCALC_HARNESS_ARCH:-$(uname -m)}"
OS="${COCALC_HARNESS_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
TARGET="harnesses-${OS}-${ARCH}.tar.xz"
FILE="${BUILD_DIR}/${TARGET}"

if [ ! -f "$FILE" ]; then
  echo "Managed harness artifact not found: $FILE" >&2
  echo "Run: pnpm --filter @cocalc/project build:harnesses" >&2
  exit 1
fi

node ../../cloud/scripts/publish-r2.js \
  --file "$FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --prefix "${COCALC_R2_PREFIX:-software/harnesses/$VERSION}" \
  --latest-key "${COCALC_R2_LATEST_KEY:-software/harnesses/latest-${OS}-${ARCH}.json}" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --os "$OS" \
  --arch "$ARCH"
