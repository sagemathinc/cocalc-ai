#!/usr/bin/env bash
set -Eeuo pipefail

NAME="cocalc-plus-tools-minimal"
VERSION="$(node -p "require('../package.json').version")"
BUILD_DIR="../build"

TARGETS=(
  "linux:amd64"
  "linux:arm64"
  "darwin:arm64"
)

if [ -n "${COCALC_TOOL_OS:-}" ] || [ -n "${COCALC_TOOL_ARCH:-}" ]; then
  OS_OVERRIDE="${COCALC_TOOL_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
  ARCH_OVERRIDE="${COCALC_TOOL_ARCH:-$(uname -m)}"
  case "$ARCH_OVERRIDE" in
    x86_64|amd64) ARCH_OVERRIDE="amd64" ;;
    aarch64|arm64) ARCH_OVERRIDE="arm64" ;;
  esac
  TARGETS=("${OS_OVERRIDE}:${ARCH_OVERRIDE}")
fi

for TARGET in "${TARGETS[@]}"; do
  OS="${TARGET%%:*}"
  ARCH="${TARGET##*:}"
  TARGET_FILE="tools-minimal-${OS}-${ARCH}.tar.xz"
  FILE="${BUILD_DIR}/${TARGET_FILE}"

  if [ ! -f "$FILE" ]; then
    echo "Tools-minimal artifact not found: $FILE" >&2
    echo "Run: pnpm --filter @cocalc/project build:tools-minimal" >&2
    exit 1
  fi

  LATEST_KEY="${COCALC_R2_LATEST_KEY:-software/tools-minimal/latest-${OS}-${ARCH}.json}"
  PREFIX="${COCALC_R2_PREFIX:-software/tools-minimal/$VERSION}"

  node ../../cloud/scripts/publish-r2.js \
    --file "$FILE" \
    --bucket "${COCALC_R2_BUCKET:-}" \
    --prefix "$PREFIX" \
    --latest-key "$LATEST_KEY" \
    --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
    --os "$OS" \
    --arch "$ARCH"
done
