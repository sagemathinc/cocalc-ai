#!/usr/bin/env bash

# Build a compact Node bundle for the CoCalc project daemon using @vercel/ncc.
#
# Usage:
#   ./build-bundle.sh [output-directory] [tarball-path]
#
# The script emits the bundle in packages/project/build/bundle by default.
# It bundles the runtime entry point, copies required native modules and
# supporting assets, and prepares the directory so it can be archived and
# embedded into the SEA executable.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="$(realpath -m "${1:-$ROOT/packages/project/build/bundle}")"
TARBALL="${2:-}"
if [ -n "$TARBALL" ]; then
  TARBALL="$(realpath -m "$TARBALL")"
fi
FINAL_OUT="$OUT"
FINAL_TARBALL="$TARBALL"
OUT_PARENT="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
LOCKFILE="$OUT_PARENT/.${OUT_NAME}.build.lock"
TMP_ROOT=""
TMP_TARBALL=""

cleanup() {
  if [ -n "$TMP_TARBALL" ]; then
    rm -f "$TMP_TARBALL" || true
  fi
  if [ -n "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT" || true
  fi
}

echo "Building CoCalc Project bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"

mkdir -p "$OUT_PARENT"
if [ -d "$LOCKFILE" ]; then
  rmdir "$LOCKFILE" 2>/dev/null || {
    echo "ERROR: stale bundle lock directory exists at $LOCKFILE" >&2
    exit 1
  }
fi
exec 9>"$LOCKFILE"
flock 9
trap cleanup EXIT
TMP_ROOT="$(mktemp -d "$OUT_PARENT/.${OUT_NAME}.tmp.XXXXXX")"
OUT="$TMP_ROOT/$OUT_NAME"
mkdir -p "$OUT"

cd "$ROOT"

echo "- Bundle entry point with @vercel/ncc"
ncc build packages/project/bin/cocalc-project.js \
  -o "$OUT"/bundle \
  --source-map \
  --external node-pty \
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

echo "- Write build identity"
node "$ROOT/scripts/dev/write-build-identity.js" \
  --root "$ROOT" \
  --package-root "$ROOT/packages/project" \
  --artifact-kind "project-bundle" \
  --out "$OUT/build-identity.json"

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
  local dir=""
  if [ -d "$ROOT/packages/project/node_modules/$pkg" ]; then
    dir="$ROOT/packages/project/node_modules/$pkg"
  elif [ -d "$ROOT/packages/project-runner/node_modules/$pkg" ]; then
    dir="$ROOT/packages/project-runner/node_modules/$pkg"
  else
    dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  fi
  echo "- Copy native module ${pkg}"
  if [ -n "$dir" ]; then
    mkdir -p "$OUT"/bundle/node_modules/"$pkg"
    cp -r "$dir"/. "$OUT"/bundle/node_modules/"$pkg"/
  else
    fetch_native_pkg "$pkg" "$OUT"/bundle/node_modules/"$pkg"
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
  # Keep only linux prebuilds for target runtime.
  if [ -d "$NODE_PTY_DIR/prebuilds" ]; then
    find "$NODE_PTY_DIR/prebuilds" -mindepth 1 -maxdepth 1 -type d \
      ! -name 'linux-*' -exec rm -rf {} +
  fi
fi

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
if [ ! -f "$OUT/bundle/node_modules/node-pty/prebuilds/linux-x64/pty.node" ]; then
  echo "ERROR: missing node-pty linux-x64 prebuild" >&2
  exit 1
fi
if [ ! -f "$OUT/bundle/node_modules/node-pty/prebuilds/linux-arm64/pty.node" ]; then
  echo "ERROR: missing node-pty linux-arm64 prebuild" >&2
  exit 1
fi

echo "- Copy project bin scripts"
mkdir -p "$OUT"/src/packages/project
cp -r packages/project/bin "$OUT"/src/packages/project/

echo "- Copy open helper into bundle bin"
mkdir -p "$OUT"/bin
cp packages/backend/dist/bin/open.js "$OUT"/bin/open
chmod +x "$OUT"/bin/open

mkdir -p "$(dirname "$FINAL_OUT")"
rm -rf "$FINAL_OUT"
mv "$OUT" "$FINAL_OUT"
OUT="$FINAL_OUT"

if [ -n "$FINAL_TARBALL" ]; then
  mkdir -p "$(dirname "$FINAL_TARBALL")"
  TMP_TARBALL="$FINAL_TARBALL.tmp.$$"
  tar -C "$(dirname "$OUT")" -Jcf "$TMP_TARBALL" "$(basename "$OUT")"
  tar -tJf "$TMP_TARBALL" >/dev/null
  mv "$TMP_TARBALL" "$FINAL_TARBALL"
  TMP_TARBALL=""
fi

echo "- Bundle created at $OUT"
