#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
STAMP="$ROOT/packages/plus/build/static.stamp"

needs_build=0
if [ ! -f "$STAMP" ]; then
  needs_build=1
else
  if git -C "$ROOT" ls-files -z packages/static packages/frontend >/dev/null 2>&1; then
    while IFS= read -r -d '' file; do
      if [ "$ROOT/$file" -nt "$STAMP" ]; then
        needs_build=1
        break
      fi
    done < <(git -C "$ROOT" ls-files -z packages/static packages/frontend)
  else
    needs_build=1
  fi
fi

if [ "$needs_build" -eq 1 ]; then
  echo "Building static assets..."
  (cd "$ROOT/packages/static" && pnpm clean && pnpm install && pnpm build)
  mkdir -p "$(dirname "$STAMP")"
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STAMP"
else
  echo "Static assets are up to date."
fi
