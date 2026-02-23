#!/usr/bin/env bash
set -Eeuo pipefail

NAME="cocalc-cli"
VERSION="$(node -p "require('../package.json').version")"
MACHINE="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

case "$MACHINE" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported arch: $MACHINE" >&2
    exit 1
    ;;
esac

SEA_DIR="../build/sea"
TARGET="${NAME}-${VERSION}-${MACHINE}-${OS}"
FILE="${SEA_DIR}/${TARGET}"
FILE_XZ="${FILE}.xz"

if [ ! -f "$FILE" ]; then
  echo "SEA artifact not found: $FILE" >&2
  echo "Run: pnpm run sea" >&2
  exit 1
fi

if ! command -v xz >/dev/null 2>&1; then
  echo "Missing required command: xz" >&2
  exit 1
fi

# Keep original binary while publishing a compressed artifact.
xz -z -f -k -9 "$FILE"

if [ ! -f "$FILE_XZ" ]; then
  echo "Failed to produce compressed artifact: $FILE_XZ" >&2
  exit 1
fi

LATEST_KEY="${COCALC_R2_LATEST_KEY:-software/cocalc/latest-${OS}-${ARCH}.json}"
PREFIX="${COCALC_R2_PREFIX:-software/cocalc/$VERSION}"

node ../../cloud/scripts/publish-r2.js \
  --file "$FILE_XZ" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --prefix "$PREFIX" \
  --latest-key "$LATEST_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --os "$OS" \
  --arch "$ARCH" \
  --version "$VERSION" \
  --content-type "application/x-xz"
