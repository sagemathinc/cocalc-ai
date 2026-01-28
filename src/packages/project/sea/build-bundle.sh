#!/usr/bin/env bash

# Build a compact Node bundle for the CoCalc project daemon using @vercel/ncc.
#
# Usage:
#   ./build-bundle.sh [output-directory]
#
# The script emits the bundle in packages/project/build/bundle by default.
# It bundles the runtime entry point, copies required native modules and
# supporting assets, and prepares the directory so it can be archived and
# embedded into the SEA executable.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/project/build/bundle}"

echo "Building CoCalc Project bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"

rm -rf "$OUT"
mkdir -p "$OUT"

cd "$ROOT"

echo "- Bundle entry point with @vercel/ncc"
ncc build packages/project/bin/cocalc-project.js \
  -o "$OUT"/bundle \
  --source-map \
  --external bufferutil \
  --external utf-8-validate

# 2. Generate a minimal package.json (needed for packageDirectory) and copy assets
export ROOT OUT
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.ROOT;
const outDir = process.env.OUT;
if (!root || !outDir) {
  throw new Error("ROOT and OUT must be defined");
}

const srcPkg = require(path.join(root, "packages/project/package.json"));
const bundlePkg = {
  name: "@cocalc/project-bundle",
  private: true,
  version: srcPkg.version
};

fs.writeFileSync(
  path.join(outDir, "bundle", "package.json"),
  JSON.stringify(bundlePkg, null, 2)
);
NODE

# Copy zeromq native manifest/build artifacts expected at runtime (via @cocalc/jupyter)
ZEROMQ_BUILD=$(find packages -path "*node_modules/zeromq/build" -type d -print -quit || true)
if [ -n "$ZEROMQ_BUILD" ]; then
echo "- Copy zeromq native build artefacts"
  mkdir -p "$OUT"/bundle/build
  cp -r "$ZEROMQ_BUILD/"* "$OUT"/bundle/build/
  # Keep only linux builds in the bundle to avoid shipping unused platforms.
  rm -rf "$OUT"/bundle/build/darwin "$OUT"/bundle/build/win32 || true
  # Keep only glibc builds (we run on glibc-based Ubuntu).
  rm -rf "$OUT"/bundle/build/linux/*/node/musl-* || true
  # Ensure legacy path /opt/cocalc/project-bundle/build/... resolves correctly.
  rm -f "$OUT/build"
  ln -s "bundle/build" "$OUT/build"
else
  echo "  (zeromq build directory not found; skipping copy)"
fi

fetch_native_pkg() {
  local pkg="$1"
  local dest="$2"
  local tmp
  tmp=$(mktemp -d)
  echo "  (fetching ${pkg} from npm)"
  (
    cd "$tmp"
    npm pack --silent "$pkg" >/dev/null
    local tgz
    tgz=$(ls *.tgz | head -n1)
    if [ -z "$tgz" ]; then
      echo "ERROR: failed to download ${pkg} via npm pack"
      exit 1
    fi
    tar -xzf "$tgz"
  )
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$tmp"/package/. "$dest"/
  rm -rf "$tmp"
}

copy_native_pkg() {
  local pkg="$1"
  local dir
  dir=$(find src/packages -path "*node_modules/${pkg}" -type d -print -quit || true)
  echo "- Copy native module ${pkg}"
  if [ -n "$dir" ]; then
    mkdir -p "$OUT"/bundle/node_modules/"$pkg"
    cp -r "$dir"/. "$OUT"/bundle/node_modules/"$pkg"/
  else
    fetch_native_pkg "$pkg" "$OUT"/bundle/node_modules/"$pkg"
  fi
}

patch_node_pty_exports() {
  local dest_root="$1"
  for pkg in "${dest_root}"/bundle/node_modules/@lydell/node-pty-linux-*/package.json; do
    [ -f "$pkg" ] || continue
    node -e "const fs=require('fs');const p=process.argv[1];const data=JSON.parse(fs.readFileSync(p,'utf8'));delete data.exports;fs.writeFileSync(p, JSON.stringify(data,null,2));" "$pkg"
  done
  for pkgdir in "${dest_root}"/bundle/node_modules/@lydell/node-pty-linux-*; do
    [ -d "$pkgdir" ] || continue
    arch=$(basename "$pkgdir" | sed 's/^node-pty-linux-//')
    prebuild="$pkgdir/prebuilds/linux-$arch/pty.node"
    if [ -f "$prebuild" ]; then
      cp "$prebuild" "$pkgdir/pty.node"
    fi
  done
}

echo "- Copy node-pty native addon(s)"
case "${OSTYPE}" in
  linux*)
    copy_native_pkg "@lydell/node-pty-linux-x64"
    copy_native_pkg "@lydell/node-pty-linux-arm64"
    ;;
  darwin*)
    case "$(uname -m)" in
      x86_64) copy_native_pkg "@lydell/node-pty-darwin-x64" ;;
      arm64) copy_native_pkg "@lydell/node-pty-darwin-arm64" ;;
      *) echo "  (unsupported darwin arch for node-pty: $(uname -m))" ;;
    esac
    ;;
  *)
    echo "  (unsupported platform for node-pty: ${OSTYPE})"
    ;;
esac

echo "- Allow node-pty native subpath requires"
patch_node_pty_exports "$OUT"

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

echo "- Add bundle README"
if [ -f "$ROOT/packages/project/sea/bundle-README.md" ]; then
  cp "$ROOT/packages/project/sea/bundle-README.md" "$OUT"/bundle/README.md
fi

echo "- Verify native addons (linux glibc)"
if ! compgen -G "$OUT/bundle/build/linux/x64/node/glibc-*/addon.node" >/dev/null; then
  echo "ERROR: missing zeromq glibc addon for linux/x64" >&2
  exit 1
fi
if ! compgen -G "$OUT/bundle/build/linux/arm64/node/glibc-*/addon.node" >/dev/null; then
  echo "ERROR: missing zeromq glibc addon for linux/arm64" >&2
  exit 1
fi
if [ ! -f "$OUT/bundle/node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node" ]; then
  echo "ERROR: missing node-pty linux-x64 prebuild" >&2
  exit 1
fi
if [ ! -f "$OUT/bundle/node_modules/@lydell/node-pty-linux-arm64/prebuilds/linux-arm64/pty.node" ]; then
  echo "ERROR: missing node-pty linux-arm64 prebuild" >&2
  exit 1
fi

# Trim native builds for other platforms to keep output lean
case "${OSTYPE}" in
  linux*)
    rm -rf "$OUT"/bundle/node_modules/@lydell/node-pty-darwin-* || true
    ;;
  darwin*)
    rm -rf "$OUT"/bundle/node_modules/@lydell/node-pty-linux-* || true
    ;;
esac

echo "- Copy project bin scripts"
mkdir -p "$OUT"/src/packages/project
cp -r packages/project/bin "$OUT"/src/packages/project/

echo "- Bundle created at $OUT"
