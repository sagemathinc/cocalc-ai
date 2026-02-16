#!/usr/bin/env bash

# Build a compact Node bundle for CoCalc Launchpad using @vercel/ncc.
#
# Usage:
#   ./build-bundle.sh [output-directory]
#
# The script expects pnpm v8+ and Node 18+ (Node 24 for runtime).
# It builds Launchpad plus its runtime dependencies, bundles the CLI entry
# point (packages/launchpad/bin/start.js), and copies static assets,
# Next api/v2 handlers, and PGlite assets.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/launchpad/build/bundle}"

case "${OSTYPE}" in
  linux*) TARGET_OS="linux" ;;
  darwin*) TARGET_OS="darwin" ;;
  *)
    echo "unsupported platform: ${OSTYPE}" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64) TARGET_ARCH="x64" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *)
    echo "unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

TARGET_PREBUILDS_DIR="${TARGET_OS}-${TARGET_ARCH}"

echo "WARNING: be sure to 'cd static && pnpm clean && pnpm install && pnpm build' to reset the static content!"

echo "Building CoCalc Launchpad bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"
echo "  target: ${TARGET_PREBUILDS_DIR}"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

echo "- Build Launchpad runtime dependencies"
pnpm --filter @cocalc/launchpad run build
pnpm --filter @cocalc/database run build
pnpm --filter @cocalc/server run build
pnpm --filter @cocalc/hub run build
pnpm --filter @cocalc/next run ts-build

echo "- Prepare Next lib alias for bundler"
NEXT_DIST="$ROOT/packages/next/dist"
NEXT_LIB_ALIAS_CREATED=""
if [ -d "$NEXT_DIST" ]; then
  mkdir -p "$NEXT_DIST/node_modules"
  if [ ! -e "$NEXT_DIST/node_modules/lib" ]; then
    ln -s ../lib "$NEXT_DIST/node_modules/lib"
    NEXT_LIB_ALIAS_CREATED="1"
  fi
fi

echo "- Bundle entry point with @vercel/ncc"
NODE_PATH="${NODE_PATH:+$NODE_PATH:}$ROOT/packages/next/dist" \
ncc build packages/launchpad/bin/start.js \
  -o "$OUT"/bundle \
  --external @electric-sql/pglite \
  --external bufferutil \
  --external utf-8-validate

if [ "$NEXT_LIB_ALIAS_CREATED" = "1" ]; then
  rm -f "$NEXT_DIST/node_modules/lib"
fi

copy_native_pkg() {
  local pkg="$1"
  local dir
  dir=$(find packages -path "*node_modules/${pkg}" -type d -print -quit || true)
  if [ -n "$dir" ]; then
    echo "- Copy native module ${pkg}"
    mkdir -p "$OUT"/bundle/node_modules/"$pkg"
    cp -r "$dir"/. "$OUT"/bundle/node_modules/"$pkg"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

copy_native_pkg "bufferutil"
copy_native_pkg "utf-8-validate"

echo "- Prune native prebuilds to target"
for pkg in bufferutil utf-8-validate; do
  prebuilds="$OUT/bundle/node_modules/$pkg/prebuilds"
  if [ -d "$prebuilds" ]; then
    find "$prebuilds" -mindepth 1 -maxdepth 1 -type d \
      ! -name "$TARGET_PREBUILDS_DIR" -exec rm -rf {} +
  fi
done

copy_js_pkg() {
  local pkg="$1"
  local dir
  dir=$(find packages -path "*node_modules/${pkg}" -type d -print -quit || true)
  if [ -n "$dir" ]; then
    echo "- Copy package ${pkg}"
    mkdir -p "$OUT"/bundle/node_modules/"$pkg"
    cp -r "$dir"/. "$OUT"/bundle/node_modules/"$pkg"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

copy_js_pkg "@electric-sql/pglite"

echo "- Prune pglite package"
PGLITE_DIR="$OUT/bundle/node_modules/@electric-sql/pglite"
if [ -d "$PGLITE_DIR" ]; then
  # Keep runtime essentials only.
  find "$PGLITE_DIR" -mindepth 1 -maxdepth 1 \
    ! -name dist \
    ! -name package.json \
    ! -name LICENSE \
    ! -name README.md \
    -exec rm -rf {} +
  # Drop TS declaration/source maps from runtime payload.
  find "$PGLITE_DIR/dist" -type f \
    \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.cts' \) \
    -delete
fi

echo "- Copy static frontend assets"
mkdir -p "$OUT"/static
rsync -a --delete \
  --exclude '*.map' \
  --exclude 'embed-*.js' \
  packages/static/dist/ "$OUT/static/"

echo "- Copy Next api/v2 handlers"
mkdir -p "$OUT"/next-dist
rsync -a --delete \
  --include '/lib/***' \
  --include '/pages/' \
  --include '/pages/api/' \
  --include '/pages/api/v2/***' \
  --exclude '*' \
  packages/next/dist/ "$OUT/next-dist/"

echo "- Copy bootstrap.py"
BOOTSTRAP_PY="$ROOT/packages/server/cloud/bootstrap/bootstrap.py"
if [ -f "$BOOTSTRAP_PY" ]; then
  mkdir -p "$OUT"/bundle/bootstrap
  cp "$BOOTSTRAP_PY" "$OUT"/bundle/bootstrap/bootstrap.py
else
  echo "bootstrap.py not found at $BOOTSTRAP_PY"
fi

echo "- Bundle created at $OUT"
