#!/usr/bin/env bash
set -Eeuo pipefail

# Build a minimal tools tarball for CoCalc Plus (rg/fd/dust/ouch).
#
# Usage:
#   ./build-tools-minimal.sh [output-directory]
#
# Builds linux/amd64, linux/arm64, and darwin/arm64 from any host by
# overriding target platform/arch via env vars.

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT_DIR="${1:-$ROOT/packages/project/build}"
WORK_DIR="$OUT_DIR/tools-minimal"

TARGETS=(
  "linux:amd64"
  "linux:arm64"
  "darwin:arm64"
)

TOOLS=(rg fd ouch)

echo "Building CoCalc minimal tools bundle..."
echo "  root: $ROOT"
echo "  out : $OUT_DIR"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

for TARGET in "${TARGETS[@]}"; do
  OS="${TARGET%%:*}"
  ARCH="${TARGET##*:}"
  echo "- Building tools-minimal for ${OS}/${ARCH}"
  rm -rf "$WORK_DIR/bin"
  mkdir -p "$WORK_DIR/bin"
  COCALC_BIN_PATH="$WORK_DIR/bin" \
  COCALC_TOOL_PLATFORM="$OS" \
  COCALC_TOOL_ARCH="$ARCH" \
    node -e 'const { install } = require("@cocalc/backend/sandbox/install");(async () => {for (const app of ["rg","fd","ouch"]) {await install(app);}})().catch((err)=>{console.error(err);process.exit(1);});'
  TARGET_FILE="$OUT_DIR/tools-minimal-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET_FILE"
  tar -C "$WORK_DIR" -Jcf "$TARGET_FILE" bin
  echo "  - Tools-minimal bundle created at $TARGET_FILE"
done
