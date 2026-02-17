#!/usr/bin/env bash
set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/cli/build/bundle}"

echo "Building CoCalc CLI bundle..."
echo "  root: $ROOT"
echo "  out : $OUT"

mkdir -p "$OUT"
rm -rf "$OUT"/*

cd "$ROOT"

echo "- Build @cocalc/cli"
pnpm --filter @cocalc/cli build

echo "- Bundle CLI entry point with @vercel/ncc"
ncc build "$ROOT/packages/cli/dist/bin/cocalc.js" \
  -o "$OUT" \
  --minify \
  --license "licenses.txt"

if [ ! -f "$OUT/index.js" ]; then
  echo "ERROR: bundle output missing $OUT/index.js" >&2
  exit 1
fi

echo "Bundle ready: $OUT/index.js"
