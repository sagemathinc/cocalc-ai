#!/usr/bin/env bash

# Build a frontend/static-only CoCalc Rocket bay update bundle.
#
# This artifact is meant for fast dogfood frontend deploys. The remote
# bootstrap path creates a new versioned bay release from the current release,
# replaces only these static asset directories, flips the current symlink, and
# restarts hub workers.
#
# Usage:
#   ./build-static-bundle.sh [output-directory] [tarball-path]

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
DEFAULT_OUT="$ROOT/packages/rocket/build/bay-static"
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
  TARBALL="$ROOT/packages/rocket/build/cocalc-bay-static-linux-${ARCH}.tar.xz"
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

validate_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "ERROR: static bundle validation failed; missing file: $path" >&2
    exit 1
  fi
}

copy_webapp_assets() {
  local dest="$1"
  echo "- Copy webapp assets"
  mkdir -p "$dest"/runtime/control-plane/webapp
  local asset
  for asset in \
    favicon.ico \
    favicon-16x16.png \
    favicon-32x32.png \
    safari-pinned-tab.svg \
    cocalc-font-black.svg \
    cocalc-font-dark.svg \
    cocalc-font-white.svg \
    cocalc-icon-white-transparent.svg \
    cocalc-icon-white.svg \
    cocalc-icon.svg \
    cocalc-logo.svg \
    open-cocalc-font-dark.svg \
    serviceWorker.js; do
    if [[ -f "packages/assets/${asset}" ]]; then
      cp "packages/assets/${asset}" "$dest"/runtime/control-plane/webapp/
    fi
  done
}

copy_provider_setup_scripts() {
  local dest="$1"
  echo "- Copy provider setup scripts"
  if [[ -f "packages/server/cloud/gcp/gcp-setup.sh" ]]; then
    mkdir -p "$dest"/runtime/control-plane/bundle/gcp
    cp "packages/server/cloud/gcp/gcp-setup.sh" \
      "$dest"/runtime/control-plane/bundle/gcp/
  fi
  if [[ -f "packages/server/cloud/nebius/nebius-setup.sh" ]]; then
    mkdir -p "$dest"/runtime/control-plane/bundle/nebius
    cp "packages/server/cloud/nebius/nebius-setup.sh" \
      "$dest"/runtime/control-plane/bundle/nebius/
  fi
}

mkdir -p "$OUT_PARENT"
trap cleanup EXIT

TMP_ROOT="$(mktemp -d "$OUT_PARENT/.${OUT_NAME}.tmp.XXXXXX")"
OUT="$TMP_ROOT/$OUT_NAME"

echo "Building CoCalc Rocket bay static bundle..."
echo "  root:    $ROOT"
echo "  out:     $OUT"
echo "  tarball: $FINAL_TARBALL"

mkdir -p "$OUT/runtime/control-plane"

cd "$ROOT"

echo "- Build static frontend assets"
pnpm --filter @cocalc/launchpad run build:static

echo "- Copy static frontend assets"
mkdir -p "$OUT/runtime/control-plane/static"
rsync -a --delete --exclude '*.map' \
  packages/static/dist/ "$OUT/runtime/control-plane/static/"

echo "- Copy public assets"
mkdir -p "$OUT/runtime/control-plane/public"
rsync -a --delete packages/assets/public/ \
  "$OUT/runtime/control-plane/public/"

copy_webapp_assets "$OUT"

copy_provider_setup_scripts "$OUT"

echo "- Write static manifest"
node - "$OUT/bay-static-manifest.json" "$ROOT" <<'NODE'
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
  kind: "cocalc-bay-static",
  version: 1,
  created: new Date().toISOString(),
  git: {
    commit: run("git", ["rev-parse", "HEAD"]),
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: run("git", ["status", "--porcelain"]).length > 0,
  },
  paths: {
    static: "runtime/control-plane/static",
    public: "runtime/control-plane/public",
    webapp: "runtime/control-plane/webapp",
    gcpSetup: "runtime/control-plane/bundle/gcp/gcp-setup.sh",
    nebiusSetup: "runtime/control-plane/bundle/nebius/nebius-setup.sh",
  },
};

fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

echo "- Validate static bundle"
validate_file "$OUT/runtime/control-plane/static/public.html"
validate_file "$OUT/runtime/control-plane/public/cocalc-content.css"
validate_file "$OUT/runtime/control-plane/webapp/favicon.ico"
validate_file "$OUT/runtime/control-plane/bundle/gcp/gcp-setup.sh"
validate_file "$OUT/runtime/control-plane/bundle/nebius/nebius-setup.sh"
validate_file "$OUT/bay-static-manifest.json"

echo "- Publish output directory"
rm -rf "$FINAL_OUT"
mv "$OUT" "$FINAL_OUT"
TMP_ROOT=""

echo "- Create tarball"
mkdir -p "$(dirname "$FINAL_TARBALL")"
TMP_TARBALL="$(mktemp "$(dirname "$FINAL_TARBALL")/.tmp.$(basename "$FINAL_TARBALL").XXXXXX")"
tar -C "$(dirname "$FINAL_OUT")" -cJf "$TMP_TARBALL" "$(basename "$FINAL_OUT")"
mv "$TMP_TARBALL" "$FINAL_TARBALL"
TMP_TARBALL=""

echo "Bay static bundle ready:"
echo "  directory: $FINAL_OUT"
echo "  tarball:   $FINAL_TARBALL"
