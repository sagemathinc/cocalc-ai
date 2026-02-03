#!/usr/bin/env bash
set -Eeuo pipefail

NAME="cocalc-plus"
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
TARBALL="${SEA_DIR}/${TARGET}.tar.xz"
TMPDIR=""

if [ ! -f "$FILE" ]; then
  if [ -f "$TARBALL" ]; then
    TMPDIR="$(mktemp -d)"
    tar -C "$TMPDIR" -Jxf "$TARBALL"
    if [ ! -f "$TMPDIR/$TARGET/$NAME" ]; then
      echo "SEA binary not found inside $TARBALL" >&2
      exit 1
    fi
    FILE="$TMPDIR/$TARGET/$NAME"
  else
    echo "SEA artifact not found: $FILE" >&2
    echo "Run: pnpm run sea" >&2
    exit 1
  fi
fi

LATEST_KEY="${COCALC_R2_LATEST_KEY:-software/cocalc-plus/latest-${OS}-${ARCH}.json}"
PREFIX="${COCALC_R2_PREFIX:-software/cocalc-plus/$VERSION}"

node ../../cloud/scripts/publish-r2.js \
  --file "$FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --prefix "$PREFIX" \
  --latest-key "$LATEST_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --os "$OS" \
  --arch "$ARCH"

if [ -n "$TMPDIR" ]; then
  rm -rf "$TMPDIR"
fi
