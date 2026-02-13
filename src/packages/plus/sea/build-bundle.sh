#!/usr/bin/env bash

# Build a compact Node bundle for CoCalc Plus using @vercel/ncc.
#
# Usage:
#   ./build-bundle.sh [output-directory]
#
# The script expects pnpm v8+ and Node 18+ (Node 24 for runtime).
# It runs the package build for @cocalc/plus, bundles the entry point
# packages/plus/dist/bin/start.js (delegating to @cocalc/lite/main),
# and copies the static frontend assets.
#
# Native addons that are marked external (e.g. node-pty) are copied into
# bundle/node_modules below. Additional assets can be copied after this script
# if needed.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/plus/build/bundle}"

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

echo "Building CoCalc Plus bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"
echo "  target: ${TARGET_PREBUILDS_DIR}"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

echo "- Build @cocalc/plus"
pnpm --filter @cocalc/plus build

echo "- Bundle entry point with @vercel/ncc"
ncc build packages/plus/dist/bin/start.js \
  -o "$OUT"/bundle \
  --external node-pty \
  --external bufferutil \
  --external utf-8-validate \
  --external reflect-sync

# zeromq expects its build manifest next to the native addon; ncc copies the
# compiled .node file but not the manifest.json, so copy it manually.
# Ensure zeromq native addon files are available where the loader expects them.
ZEROMQ_BUILD=$(find packages -path "*node_modules/zeromq/build" -type d -print -quit || true)
if [ -n "$ZEROMQ_BUILD" ]; then
  mkdir -p "$OUT"/bundle/build
  cp -r "$ZEROMQ_BUILD/"* "$OUT"/bundle/build/
  # Keep only target OS + arch for SEA output.
  find "$OUT"/bundle/build -mindepth 1 -maxdepth 1 -type d \
    ! -name "$TARGET_OS" -exec rm -rf {} +
  if [ -d "$OUT"/bundle/build/"$TARGET_OS" ]; then
    find "$OUT"/bundle/build/"$TARGET_OS" -mindepth 1 -maxdepth 1 -type d \
      ! -name "$TARGET_ARCH" -exec rm -rf {} +
  fi
  if [ "$TARGET_OS" = "linux" ]; then
    # SEA target is glibc-based; drop musl payloads.
    rm -rf "$OUT"/bundle/build/linux/"$TARGET_ARCH"/node/musl-* || true
  fi
  # zeromq looks for ../build relative to the bundle root; use a symlink
  # so we don't duplicate payloads in the tarball.
  rm -rf "$OUT"/build
  ln -s "bundle/build" "$OUT/build"
else
  echo "zeromq build directory not found; skipping copy"
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

echo "- Copy node-pty package"
copy_native_pkg "node-pty"

echo "- Prune node-pty package"
NODE_PTY_DIR="$OUT/bundle/node_modules/node-pty"
if [ -d "$NODE_PTY_DIR" ]; then
  # Keep only runtime essentials.
  find "$NODE_PTY_DIR" -mindepth 1 -maxdepth 1 \
    ! -name lib \
    ! -name prebuilds \
    ! -name package.json \
    ! -name LICENSE \
    ! -name README.md \
    -exec rm -rf {} +
  # Keep only prebuilds for the target OS.
  if [ -d "$NODE_PTY_DIR/prebuilds" ]; then
    find "$NODE_PTY_DIR/prebuilds" -mindepth 1 -maxdepth 1 -type d \
      ! -name "$TARGET_PREBUILDS_DIR" -exec rm -rf {} +
  fi
fi

copy_native_pkg "bufferutil"
copy_native_pkg "utf-8-validate"

echo "- Prune bufferutil/utf-8-validate prebuilds to target"
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
    echo "- Copy js package ${pkg}"
    mkdir -p "$OUT"/bundle/node_modules/"$pkg"
    # Follow symlinks so pnpm store paths are materialized.
    rsync -aL "$dir"/ "$OUT"/bundle/node_modules/"$pkg"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

resolve_js_pkg_dir() {
  local pkg="$1"
  local base="$2"
  node -e "const path=require('path');const {createRequire}=require('module');const r=createRequire(path.join(process.argv[1],'package.json'));const entry=r.resolve(process.argv[2]);console.log(path.dirname(path.dirname(entry)));" "$base" "$pkg" 2>/dev/null || true
}

copy_js_pkg_tree() {
  local pkg="$1"
  local base="$2"
  local out="$3"
  node -e '
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const base = process.argv[1];
const rootPkg = process.argv[2];
const rootReq = createRequire(path.join(base, "package.json"));
const seen = new Set();
function resolvePackageRoot(name, resolver) {
  try {
    const pkgJsonPath = resolver.resolve(`${name}/package.json`);
    return { pkgJsonPath, dir: path.dirname(pkgJsonPath) };
  } catch {}
  let entry;
  try {
    entry = resolver.resolve(name);
  } catch {
    return null;
  }
  let dir = path.dirname(entry);
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      return { pkgJsonPath: candidate, dir };
    }
    dir = path.dirname(dir);
  }
  return null;
}
function add(name, resolver) {
  if (seen.has(name)) return;
  const resolved = resolvePackageRoot(name, resolver);
  if (!resolved) {
    return;
  }
  const { pkgJsonPath, dir } = resolved;
  seen.add(name);
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
  } catch {
    pkgJson = {};
  }
  const deps = pkgJson.dependencies || {};
  const pkgReq = createRequire(path.join(dir, "package.json"));
  for (const dep of Object.keys(deps)) add(dep, pkgReq);
  process.stdout.write(`${name}\t${dir}\n`);
}
add(rootPkg, rootReq);
' "$base" "$pkg" | while IFS=$'\t' read -r name dir; do
    if [ -z "$name" ] || [ -z "$dir" ]; then
      continue
    fi
    dest="$out/bundle/node_modules/$name"
    mkdir -p "$(dirname "$dest")"
    rsync -aL "$dir"/ "$dest"/
  done
}

echo "- Copy reflect-sync + deps (from @cocalc/plus)"
copy_js_pkg_tree "reflect-sync" "$ROOT/packages/plus" "$OUT"
if [ ! -f "$OUT/bundle/node_modules/reflect-sync/dist/index.js" ]; then
  echo "ERROR: reflect-sync not copied into bundle output"
  exit 1
fi

echo "- Copy static frontend assets"
mkdir -p "$OUT"/static
rsync -a --delete \
  --exclude '*.map' \
  --exclude 'embed-*.js' \
  packages/static/dist/ "$OUT/static/"

echo "- Bundle created at $OUT"
