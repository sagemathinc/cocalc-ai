#!/usr/bin/env bash

# Build a self-contained CoCalc Rocket bay runtime bundle.
#
# The resulting tarball is intentionally a systemd-friendly runtime bundle,
# not a SEA binary. Phase 2 can embed this tarball in a SEA launcher once the
# bundle contract is stable.
#
# Usage:
#   ./build-bundle.sh [output-directory] [tarball-path]

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
DEFAULT_OUT="$ROOT/packages/rocket/build/bay-runtime"
OUT_ARG="${1:-}"
if [[ -n "$OUT_ARG" && "$OUT_ARG" != --* ]]; then
  OUT="$(realpath -m "$OUT_ARG")"
  shift
else
  OUT="$DEFAULT_OUT"
fi
TARBALL="${1:-}"
if [[ -n "$TARBALL" && "$TARBALL" != --* ]]; then
  TARBALL="$(realpath -m "$TARBALL")"
  shift
else
  case "$(uname -m)" in
    x86_64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) ARCH="$(uname -m)" ;;
  esac
  TARBALL="$ROOT/packages/rocket/build/cocalc-bay-runtime-linux-${ARCH}.tar.xz"
fi

if [[ "$#" -gt 0 ]]; then
  echo "ERROR: unknown argument: $1" >&2
  exit 2
fi

FINAL_OUT="$OUT"
FINAL_TARBALL="$TARBALL"
OUT_PARENT="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
LOCKFILE="$OUT_PARENT/.${OUT_NAME}.build.lock"
TMP_ROOT=""
TMP_TARBALL=""

cleanup() {
  if [[ -n "$TMP_TARBALL" ]]; then
    rm -f "$TMP_TARBALL" || true
  fi
  if [[ -n "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT" || true
  fi
}

copy_native_pkg() {
  local pkg="$1"
  local dest_root="$2"
  local dir
  dir=$(find "$ROOT/packages" -path "*node_modules/${pkg}" -type d -print -quit || true)
  if [[ -n "$dir" ]]; then
    echo "- Copy native module ${pkg} -> ${dest_root}/node_modules/${pkg}"
    mkdir -p "${dest_root}/node_modules/${pkg}"
    cp -a "$dir"/. "${dest_root}/node_modules/${pkg}"/
  else
    echo "  (skipping ${pkg}; not found)"
  fi
}

validate_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: bundle validation failed; missing file: $path" >&2
    exit 1
  fi
}

mkdir -p "$OUT_PARENT"
if [[ -d "$LOCKFILE" ]]; then
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

echo "Building CoCalc Rocket bay runtime bundle..."
echo "  root:    $ROOT"
echo "  out:     $OUT"
echo "  tarball: $FINAL_TARBALL"

mkdir -p "$OUT/runtime"

cd "$ROOT"

echo "- Build project-host bundle"
pnpm --filter @cocalc/project-host run build:bundle

echo "- Build hub runtime dependencies"
pnpm --filter @cocalc/database run build
pnpm --filter @cocalc/server run build
pnpm --filter @cocalc/http-api run build
pnpm --filter @cocalc/hub run build

echo "- Copy project-host daemon bundle"
mkdir -p "$OUT/runtime/project-host"
cp -a "$ROOT/packages/project-host/build/bundle/main"/. \
  "$OUT/runtime/project-host"/

echo "- Bundle hub worker with @vercel/ncc"
pnpm --filter @cocalc/project-host exec ncc build "$ROOT/packages/hub/run/hub.js" \
  -o "$OUT/runtime/hub" \
  --external bufferutil \
  --external utf-8-validate \
  --license licenses.txt

copy_native_pkg "bufferutil" "$OUT/runtime/hub"
copy_native_pkg "utf-8-validate" "$OUT/runtime/hub"

echo "- Bundle schema migration helper with @vercel/ncc"
pnpm --filter @cocalc/project-host exec ncc build "$ROOT/packages/rocket/bin/bay-migrate-schema.js" \
  -o "$OUT/runtime/migrate-schema" \
  --external bufferutil \
  --external utf-8-validate \
  --license licenses.txt

copy_native_pkg "bufferutil" "$OUT/runtime/migrate-schema"
copy_native_pkg "utf-8-validate" "$OUT/runtime/migrate-schema"

echo "- Copy bay systemd scaffold"
mkdir -p "$OUT/scripts"
cp -a "$ROOT/scripts/bay-systemd" "$OUT/scripts/"

echo "- Write runtime manifest"
node - "$OUT/bay-runtime-manifest.json" "$ROOT" <<'NODE'
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [out, root] = process.argv.slice(2);

function run(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const manifest = {
  kind: "cocalc-bay-runtime",
  version: 1,
  created: new Date().toISOString(),
  git: {
    commit: run("git", ["rev-parse", "HEAD"]),
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: run("git", ["status", "--porcelain"]).length > 0,
  },
  node: {
    version: process.version,
    platform: process.platform,
    arch: process.arch,
    modules: process.versions.modules,
  },
  entrypoints: {
    projectHost: "runtime/project-host/index.js",
    hub: "runtime/hub/index.js",
    migrateSchema: "runtime/migrate-schema/index.js",
  },
  scaffold: "scripts/bay-systemd",
};

fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
NODE

echo "- Validate runtime bundle"
validate_file "$OUT/runtime/project-host/index.js"
validate_file "$OUT/runtime/hub/index.js"
validate_file "$OUT/runtime/migrate-schema/index.js"
validate_file "$OUT/scripts/bay-systemd/install-scaffold.sh"
validate_file "$OUT/scripts/bay-systemd/bay-bootstrap-release.sh"
validate_file "$OUT/scripts/bay-systemd/env/bay-rocket-bundle-overlay.env.example"
validate_file "$OUT/bay-runtime-manifest.json"

echo "- Publish output directory"
rm -rf "$FINAL_OUT"
mkdir -p "$(dirname "$FINAL_OUT")"
mv "$OUT" "$FINAL_OUT"
OUT="$FINAL_OUT"
TMP_ROOT=""

echo "- Create tarball"
mkdir -p "$(dirname "$FINAL_TARBALL")"
TMP_TARBALL="${FINAL_TARBALL}.tmp.$$"
tar -C "$(dirname "$FINAL_OUT")" -cJf "$TMP_TARBALL" "$(basename "$FINAL_OUT")"
mv "$TMP_TARBALL" "$FINAL_TARBALL"
TMP_TARBALL=""

echo "Bay runtime bundle ready:"
echo "  directory: $FINAL_OUT"
echo "  tarball:   $FINAL_TARBALL"
