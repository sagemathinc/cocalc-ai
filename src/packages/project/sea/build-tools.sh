#!/usr/bin/env bash
set -Eeuo pipefail

# Build a tools tarball containing the project host helper binaries
# (dropbear, rg, rustic, etc.) from the local build output.
#
# Usage:
#   ./build-tools.sh [output-directory]
#
# The script downloads prebuilt tool binaries (via sandbox/install) and emits
# packages/project/build/tools-<os>-<arch>.tar.xz by default. It can build
# both linux/amd64 and linux/arm64 from a single host by overriding target
# arch via env vars.

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT_DIR="${1:-$ROOT/packages/project/build}"
WORK_DIR="$OUT_DIR/tools"
OS="linux"
ARCHES=("amd64" "arm64")

echo "Building CoCalc tools bundle..."
echo "  root: $ROOT"
echo "  out : $OUT_DIR"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

for ARCH in "${ARCHES[@]}"; do
  echo "- Building tools for ${OS}/${ARCH}"
  rm -rf "$WORK_DIR/bin"
  mkdir -p "$WORK_DIR/bin"
  COCALC_BIN_PATH="$WORK_DIR/bin" \
  COCALC_TOOL_PLATFORM="$OS" \
  COCALC_TOOL_ARCH="$ARCH" \
    node -e 'require("@cocalc/backend/sandbox/install").install()'
  TARGET="$OUT_DIR/tools-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET"
  tar -C "$WORK_DIR" -Jcf "$TARGET" bin
  echo "  - Tools bundle created at $TARGET"
done
