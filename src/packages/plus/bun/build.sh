#!/usr/bin/env bash

# Build CoCalc Plus for Bun: the app, the same on every platform, and one
# launcher executable per platform (plus/bun/launcher.ts compiled with Bun's
# runtime).  The launcher runs app/bundle/index.js next to it.
#
# Usage:
#   plus/bun/build.sh [bundle-directory] [output-directory]
#
#   bundle-directory  output of plus/sea/build-bundle.sh
#                     (default: packages/plus/build/bundle)
#   output-directory  default: packages/plus/build/bun
#
# COCALC_PLUS_BUN_TARGETS lists the Bun targets (default below).  Output:
#   <out>/app/                       bundle/, static/, public/
#   <out>/launchers/<target>/cocalc-plus[.exe]
#
# It needs the Bun in plus/bun/.bun-version: the launcher embeds Bun's runtime.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PLUS="$(dirname "$HERE")"
BUNDLE="$(cd "${1:-$PLUS/build/bundle}" && pwd)"
OUT="${2:-$PLUS/build/bun}"
TARGETS="${COCALC_PLUS_BUN_TARGETS:-linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64}"

want="$(tr -d '[:space:]' < "$HERE/.bun-version")"
have="$(bun --version)"
if [ "$want" != "$have" ]; then
  echo "plus/bun/build.sh needs Bun $want (plus/bun/.bun-version); this is Bun $have" >&2
  exit 1
fi
if [ ! -f "$BUNDLE/bundle/index.js" ] || [ ! -d "$BUNDLE/static" ]; then
  echo "not a CoCalc Plus bundle (plus/sea/build-bundle.sh): $BUNDLE" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/launchers"

echo "- App (from $BUNDLE)"
cp -R "$BUNDLE/bundle" "$BUNDLE/static" "$BUNDLE/public" "$OUT/app/"
# Native addons that only Node loads: under Bun, terminals use Bun.Terminal
# (project/conat/terminal/pty.ts) and ws is Bun's own, which needs neither
# bufferutil nor utf-8-validate.  Without them the app is the same everywhere.
rm -rf "$OUT/app/bundle/node_modules/"{node-pty,bufferutil,utf-8-validate}

for target in $TARGETS; do
  exe=cocalc-plus
  case "$target" in
    windows-*) exe=cocalc-plus.exe ;;
  esac
  echo "- Launcher for $target"
  mkdir -p "$OUT/launchers/$target"
  bun build --compile --minify --target="bun-$target" \
    "$HERE/launcher.ts" --outfile "$OUT/launchers/$target/$exe"
done

echo "- Built $OUT"
