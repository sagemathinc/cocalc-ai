#!/usr/bin/env bash

# Build a compact control-plane-only CoCalc Rocket bay update bundle.
#
# This artifact is for hub/backend deploys where the current target release
# already has valid static assets, project-host runtime, and systemd scaffold.
# The remote bootstrap path creates a new release from the current release,
# replaces only hub/control-plane runtime files, flips the current symlink, and
# the upgrade wrapper rolls hub workers after running migrations.
#
# Usage:
#   ./build-hub-bundle.sh [output-directory] [tarball-path]

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
DEFAULT_OUT="$ROOT/packages/rocket/build/bay-hub"
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
  TARBALL="$ROOT/packages/rocket/build/cocalc-bay-hub-linux-${ARCH}.tar.xz"
fi

if [[ "$#" -gt 0 ]]; then
  echo "ERROR: unknown argument: $1" >&2
  exit 2
fi

FINAL_OUT="$OUT"
FINAL_TARBALL="$TARBALL"
OUT_PARENT="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
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
    echo "ERROR: hub bundle validation failed; missing file: $path" >&2
    exit 1
  fi
}

mkdir -p "$OUT_PARENT"
trap cleanup EXIT

TMP_ROOT="$(mktemp -d "$OUT_PARENT/.${OUT_NAME}.tmp.XXXXXX")"
OUT="$TMP_ROOT/$OUT_NAME"

echo "Building CoCalc Rocket bay hub bundle..."
echo "  root:    $ROOT"
echo "  out:     $OUT"
echo "  tarball: $FINAL_TARBALL"

mkdir -p "$OUT/runtime"

cd "$ROOT"

echo "- Build compact control-plane bundle"
"$ROOT/scripts/control-plane-bundle/build-bundle.sh" \
  --entrypoint packages/rocket/bin/start-hub-worker.js \
  --out "$OUT/runtime/control-plane" \
  --package-filter @cocalc/rocket \
  --include-pglite \
  --no-static

echo "- Bundle schema migration helper with @vercel/ncc"
pnpm --filter @cocalc/project-host exec ncc build "$ROOT/packages/rocket/bin/bay-migrate-schema.js" \
  -o "$OUT/runtime/migrate-schema" \
  --external bufferutil \
  --external utf-8-validate \
  --license licenses.txt

copy_native_pkg "bufferutil" "$OUT/runtime/migrate-schema"
copy_native_pkg "utf-8-validate" "$OUT/runtime/migrate-schema"

echo "- Write hub manifest"
node - "$OUT/bay-hub-manifest.json" "$ROOT" <<'NODE'
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
  kind: "cocalc-bay-hub",
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
    hub: "runtime/control-plane/bundle/index.js",
    migrateSchema: "runtime/migrate-schema/index.js",
    apiV2Root: "runtime/control-plane/http-api-dist/pages/api/v2",
    apiV2Routes: "runtime/control-plane/api-v2-routes/index.js",
  },
};

fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
NODE

echo "- Validate hub bundle"
validate_file "$OUT/runtime/control-plane/bundle/index.js"
validate_file "$OUT/runtime/control-plane/api-v2-routes/index.js"
validate_file "$OUT/runtime/control-plane/http-api-dist/pages/api/v2/index.js"
validate_file "$OUT/runtime/migrate-schema/index.js"
validate_file "$OUT/bay-hub-manifest.json"

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

echo "Bay hub bundle ready:"
echo "  out:     $FINAL_OUT"
echo "  tarball: $FINAL_TARBALL"
