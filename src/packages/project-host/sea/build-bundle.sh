#!/usr/bin/env bash

# Build a compact Node bundle for the CoCalc project host using @vercel/ncc.
# This bundles the CLI entry point, copies required native modules, and pulls
# in the project-runner templates so the SEA build can embed everything into a
# single archive.
#
# Usage:
#   ./build-bundle.sh [output-directory]
#
# You should have already installed workspace dependencies. The script will
# build the TypeScript sources for @cocalc/project-host and the static assets.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/project-host/build/bundle}"

echo "Building CoCalc Project Host bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

echo "- Build project-host"
pnpm --filter @cocalc/project-host run build

echo "- Bundle entry point with @vercel/ncc"
ncc build packages/project-host/bin/start.js \
  -o "$OUT"/bundle \
  --source-map \
  --external bufferutil \
  --external utf-8-validate

# zeromq expects its build manifest next to the native addon; ncc copies the
# compiled .node file but not the manifest.json, so copy it manually.
ZEROMQ_BUILD=$(find packages -path "*node_modules/zeromq/build" -type d -print -quit || true)
if [ -n "$ZEROMQ_BUILD" ]; then
  mkdir -p "$OUT"/bundle/build
  cp -r "$ZEROMQ_BUILD/"* "$OUT"/bundle/build/
  # Keep only linux builds in the bundle to avoid shipping unused platforms.
  rm -rf "$OUT"/bundle/build/darwin "$OUT"/bundle/build/win32 || true
  # Keep only glibc builds (we run on glibc-based Ubuntu).
  rm -rf "$OUT"/bundle/build/linux/*/node/musl-* || true
  # zeromq looks for ../build relative to the bundle root, so mirror it there too.
  rm -f "$OUT/build"
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

echo "- Copy node-pty native addons (linux x64 + arm64)"
copy_native_pkg "@lydell/node-pty-linux-x64"
copy_native_pkg "@lydell/node-pty-linux-arm64"
rm -rf "$OUT"/bundle/node_modules/@lydell/node-pty-darwin-* || true
rm -rf "$OUT"/bundle/node_modules/@lydell/node-pty-win32-* || true

echo "- Allow node-pty native subpath requires"
for pkg in "$OUT"/bundle/node_modules/@lydell/node-pty-linux-*/package.json; do
  [ -f "$pkg" ] || continue
  node -e "const fs=require('fs');const p=process.argv[1];const data=JSON.parse(fs.readFileSync(p,'utf8'));delete data.exports;fs.writeFileSync(p, JSON.stringify(data,null,2));" "$pkg"
done
for pkgdir in "$OUT"/bundle/node_modules/@lydell/node-pty-linux-*; do
  [ -d "$pkgdir" ] || continue
  arch=$(basename "$pkgdir" | sed 's/^node-pty-linux-//')
  prebuild="$pkgdir/prebuilds/linux-$arch/pty.node"
  if [ -f "$prebuild" ]; then
    cp "$prebuild" "$pkgdir/pty.node"
  fi
done

copy_native_pkg "bufferutil"
copy_native_pkg "utf-8-validate"

echo "- Prune non-linux prebuilds"
for pkg in bufferutil utf-8-validate; do
  prebuilds="$OUT/bundle/node_modules/$pkg/prebuilds"
  if [ -d "$prebuilds" ]; then
    find "$prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name 'linux-*' -exec rm -rf {} + || true
  fi
done

echo "- Strip musl prebuilds"
rm -f "$OUT"/bundle/node_modules/utf-8-validate/prebuilds/linux-*/utf-8-validate.musl.node || true

echo "- Copy project-runner templates"
mkdir -p "$OUT"/bundle/templates
cp -r packages/project-runner/templates/. "$OUT"/bundle/templates/

echo "- Remove other platform binaries"
rm -rf "$OUT"/build/win32 "$OUT"/build/darwin || true

echo "- Bundle created at $OUT"
