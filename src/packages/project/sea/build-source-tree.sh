#!/usr/bin/env bash

# The CoCalc source of this build, for agents in projects to read: shipped in
# the project bundle as source/ (/opt/cocalc/project-bundle/source), so it is
# exactly the code that runs, versioned and retained with the bundle.
#
# Only git-tracked text that explains how CoCalc works: no images, video,
# fonts, lockfiles, tests, translations other than English, generated icon
# fonts, release scripts or internal agent notes.  About 55 MB, under 10 MB in the bundle's
# xz tarball.
#
# Usage:
#   ./build-source-tree.sh <src-dir> <out-dir>
#
# <src-dir> is the repository's src/.  Set COCALC_BUNDLE_SOURCE=0 to skip.

set -euo pipefail

SRC="$(realpath "$1")"
OUT="$2"

if [ "${COCALC_BUNDLE_SOURCE:-1}" = "0" ]; then
  echo "  (COCALC_BUNDLE_SOURCE=0: no source tree)"
  exit 0
fi

keep() {
  grep -Ev '\.(png|jpe?g|gif|webp|svg|ico|mp4|webm|ttf|otf|woff2?|eot|pdf|wasm|zip|gz|tgz|lock|map)$' |
    grep -Ev '(^|/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|go\.sum)$' |
    grep -Ev '(\.test\.|\.spec\.|\.browser-test\.|/__tests?__/|/test/|/tests/|/playwright/|playwright\.config|\.snap$|/(__)?fixtures?(__)?/)' |
    grep -Ev '^\.(agents|skills)/' |
    grep -Ev '^scripts/' |
    grep -Ev '^packages/frontend/i18n/trans/' |
    grep -Ev '^packages/frontend/public/lang/locales/([^e]|e[^n]|en[^/])' |
    grep -Ev '^packages/assets/cocalc-icons-font/' |
    grep -Ev '^packages/frontend/components/iconfont\.cn/' |
    grep -Ev '(^|/)CHANGELOG(\.md)?$' || true
}

rm -rf "$OUT"
mkdir -p "$OUT"
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
# tracked files, as they are in this checkout (what is built)
git -C "$SRC" ls-files -- . | keep >"$LIST"
tar -C "$SRC" -cf - --files-from="$LIST" | tar -C "$OUT" -xf -

COMMIT="$(git -C "$SRC" rev-parse HEAD)"
DATE="$(git -C "$SRC" log -1 --format=%cs HEAD)"
DIRTY=""
if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no -- . 2>/dev/null)" ]; then
  DIRTY=" (built with uncommitted changes)"
fi

{
  echo "# CoCalc source, commit ${COMMIT:0:10}"
  echo
  echo "The source of the CoCalc release running here, read-only: commit"
  echo "$COMMIT, $DATE$DIRTY. It describes this release exactly; the GitHub"
  echo "repository may be newer. Tests, images and translations are left out."
  echo "Search it with \`rg\`; start from the package that matches the question."
  echo
  echo "## Packages"
  echo
  echo "| Package | Files | What it is |"
  echo "|---|---|---|"
  # every workspace package, nested ones (e.g. packages/apps/notebook) too
  find "$OUT/packages" -mindepth 2 -name package.json -not -path "*/node_modules/*" | sort |
  while read -r pj; do
    dir="$(dirname "$pj")"
    name="${dir#"$OUT"/packages/}"
    desc="$(node -e 'const d=require(process.argv[1]); console.log(String(d.description ?? "").replace(/\|/g, "/").trim())' "$pj" 2>/dev/null || true)"
    files="$(find "$dir" -type f | wc -l | tr -d ' ')"
    echo "| \`packages/$name\` | $files | $desc |"
  done
} >"$OUT/INDEX.md"

echo "  source tree: $(wc -l <"$LIST" | tr -d ' ') files, $(du -sh "$OUT" | cut -f1)"
