#!/usr/bin/env bash
set -Eeuo pipefail

# Build once per tools build, then install the same platform-independent JS
# bundle after restoring each platform's binary-tools cache.
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "${1:?output directory required}"
OUT="$(cd "$1" && pwd)"
SOURCE="${COCALC_REFLECT_SOURCE_DIR:-}"
TMP=""
cleanup() { if [ -n "$TMP" ]; then rm -rf "$TMP"; fi; }
trap cleanup EXIT
if [ -z "$SOURCE" ]; then
  MANIFEST="$HERE/reflect-source.json"
  REPO="$(node -p 'require(process.argv[1]).repository' "$MANIFEST")"
  COMMIT="$(node -p 'require(process.argv[1]).commit' "$MANIFEST")"
  SHA="$(node -p 'require(process.argv[1]).sha256' "$MANIFEST")"
  TMP="$(mktemp -d)"
  curl --fail --location --retry 3 --max-time 120 \
    "https://codeload.github.com/$REPO/tar.gz/$COMMIT" -o "$TMP/source.tar.gz"
  ACTUAL="$(node -e 'const fs=require("fs"), c=require("crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$TMP/source.tar.gz")"
  if [ "$ACTUAL" != "$SHA" ]; then
    echo "Reflect source checksum mismatch" >&2
    exit 1
  fi
  mkdir "$TMP/source"
  tar -xzf "$TMP/source.tar.gz" -C "$TMP/source" --strip-components=1
  SOURCE="$TMP/source"
  pnpm --dir "$SOURCE" install --frozen-lockfile
fi
pnpm --dir "$SOURCE" bundle
install -m 0644 "$SOURCE/dist/bundle.mjs" "$OUT/reflect.mjs"
install -m 0644 "$SOURCE/LICENSE.txt" "$OUT/LICENSE.txt"
install -m 0755 "$HERE/reflect" "$OUT/reflect"
node "$OUT/reflect.mjs" jupyter --help >/dev/null
