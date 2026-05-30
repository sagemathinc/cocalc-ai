#!/usr/bin/env bash

# Build a compact Node bundle for CoCalc Launchpad using the shared
# control-plane bundle builder.

set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT="${1:-$ROOT/packages/launchpad/build/bundle}"

echo "WARNING: be sure to 'cd static && pnpm clean && pnpm install && pnpm build' to reset the static content!"

"$ROOT/scripts/control-plane-bundle/build-bundle.sh" \
  --entrypoint packages/launchpad/bin/start.js \
  --out "$OUT" \
  --package-filter @cocalc/launchpad \
  --include-pglite \
  --exclude-static 'embed-*.js'
