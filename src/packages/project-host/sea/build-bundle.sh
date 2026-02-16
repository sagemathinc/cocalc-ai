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
  --external node-pty \
  --external bufferutil \
  --external utf-8-validate

echo "- Bundle main entrypoint (daemon target)"
ncc build packages/project-host/dist/main.js \
  -o "$OUT"/main \
  --source-map \
  --external node-pty \
  --external bufferutil \
  --external utf-8-validate

echo "- Copy compiled project-host dist/"
if [ -d "packages/project-host/dist" ]; then
  mkdir -p "$OUT"/dist
  cp -r packages/project-host/dist/. "$OUT"/dist/
else
  echo "  (skipping dist; not found)"
fi

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

fetch_openat_binary() {
  local pkg="$1"
  local filename="$2"
  local dest_root="$3"
  local tmp
  tmp=$(mktemp -d)
  echo "  (fetching ${pkg} binary ${filename} from npm)"
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
  if [ ! -f "$tmp/package/$filename" ]; then
    echo "ERROR: ${pkg} did not contain ${filename}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  cp "$tmp/package/$filename" "$dest_root/$filename"
  rm -rf "$tmp"
}

ensure_openat_binary() {
  local triple="$1"
  local dest_root="$2"
  local filename="cocalc_openat2.${triple}.node"
  local pkg="@cocalc/openat2-${triple}"
  if [ -f "$dest_root/$filename" ]; then
    return
  fi
  fetch_openat_binary "$pkg" "$filename" "$dest_root"
}

copy_native_pkg() {
  local pkg="$1"
  local dest_root="$2"
  local dir=""
  if [ -d "$ROOT/packages/project-host/node_modules/$pkg" ]; then
    dir="$ROOT/packages/project-host/node_modules/$pkg"
  elif [ -d "$ROOT/packages/project-runner/node_modules/$pkg" ]; then
    dir="$ROOT/packages/project-runner/node_modules/$pkg"
  elif [ -d "$ROOT/packages/project/node_modules/$pkg" ]; then
    dir="$ROOT/packages/project/node_modules/$pkg"
  else
    dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  fi
  echo "- Copy native module ${pkg} -> ${dest_root}/node_modules/${pkg}"
  if [ -n "$dir" ]; then
    mkdir -p "${dest_root}/node_modules/${pkg}"
    cp -r "$dir"/. "${dest_root}/node_modules/${pkg}"/
  else
    fetch_native_pkg "$pkg" "${dest_root}/node_modules/${pkg}"
  fi
}

prune_node_pty_pkg() {
  local dest_root="$1"
  local pkg_dir="$dest_root/node_modules/node-pty"
  if [ ! -d "$pkg_dir" ]; then
    return
  fi
  # Keep only runtime essentials.
  find "$pkg_dir" -mindepth 1 -maxdepth 1 \
    ! -name lib \
    ! -name prebuilds \
    ! -name package.json \
    ! -name LICENSE \
    ! -name README.md \
    -exec rm -rf {} +
  # Keep only linux prebuilds for target runtime.
  if [ -d "$pkg_dir/prebuilds" ]; then
    find "$pkg_dir/prebuilds" -mindepth 1 -maxdepth 1 -type d \
      ! -name 'linux-*' -exec rm -rf {} +
  fi
}

echo "- Copy node-pty package"
copy_native_pkg "node-pty" "$OUT/bundle"
copy_native_pkg "node-pty" "$OUT/main"

echo "- Prune node-pty package"
prune_node_pty_pkg "$OUT/bundle"
prune_node_pty_pkg "$OUT/main"

copy_native_pkg "bufferutil" "$OUT/bundle"
copy_native_pkg "utf-8-validate" "$OUT/bundle"
copy_native_pkg "bufferutil" "$OUT/main"
copy_native_pkg "utf-8-validate" "$OUT/main"

echo "- Prune non-linux prebuilds"
for dest_root in "$OUT/bundle" "$OUT/main"; do
  for pkg in bufferutil utf-8-validate; do
    prebuilds="$dest_root/node_modules/$pkg/prebuilds"
    if [ -d "$prebuilds" ]; then
      find "$prebuilds" -mindepth 1 -maxdepth 1 -type d ! -name 'linux-*' -exec rm -rf {} + || true
    fi
  done
  rm -f "$dest_root"/node_modules/utf-8-validate/prebuilds/linux-*/utf-8-validate.musl.node || true
done

echo "- Verify node-pty prebuilds (linux x64 + arm64)"
for dest_root in "$OUT/bundle" "$OUT/main"; do
  if [ ! -f "$dest_root/node_modules/node-pty/prebuilds/linux-x64/pty.node" ]; then
    echo "ERROR: missing node-pty linux-x64 prebuild in $dest_root" >&2
    exit 1
  fi
  if [ ! -f "$dest_root/node_modules/node-pty/prebuilds/linux-arm64/pty.node" ]; then
    echo "ERROR: missing node-pty linux-arm64 prebuild in $dest_root" >&2
    exit 1
  fi
done

echo "- Ensure openat2 binaries (linux x64 + arm64)"
for dest_root in "$OUT/bundle" "$OUT/main"; do
  ensure_openat_binary "linux-x64-gnu" "$dest_root"
  ensure_openat_binary "linux-arm64-gnu" "$dest_root"
done

echo "- Verify openat2 binaries (linux x64 + arm64)"
for dest_root in "$OUT/bundle" "$OUT/main"; do
  if [ ! -f "$dest_root/cocalc_openat2.linux-x64-gnu.node" ]; then
    echo "ERROR: missing openat2 linux-x64-gnu binary in $dest_root" >&2
    exit 1
  fi
  if [ ! -f "$dest_root/cocalc_openat2.linux-arm64-gnu.node" ]; then
    echo "ERROR: missing openat2 linux-arm64-gnu binary in $dest_root" >&2
    exit 1
  fi
done

echo "- Copy project-runner templates"
for dest_root in "$OUT/bundle" "$OUT/main"; do
  mkdir -p "$dest_root/templates"
  cp -r packages/project-runner/templates/. "$dest_root/templates/"
done

for required in \
  "$OUT/bundle/templates/linux/bashrc" \
  "$OUT/bundle/templates/linux/bash_profile"; do
  if [ ! -f "$required" ]; then
    echo "ERROR: missing required template in bundle: $required" >&2
    exit 1
  fi
done

echo "- Remove other platform binaries"
rm -rf "$OUT"/build/win32 "$OUT"/build/darwin || true

echo "- Bundle created at $OUT"
