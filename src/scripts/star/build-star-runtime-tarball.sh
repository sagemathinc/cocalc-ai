#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
OUTPUT="${1:-${STAR_RUNTIME_TARBALL:-/tmp/cocalc-star-runtime.tar.gz}}"
STAR_RUNTIME_BUILD="${STAR_RUNTIME_BUILD:-1}"

log() {
  printf '[star-runtime-build] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-star-runtime-tarball.sh [output.tar.gz]

Build a CoCalc Star runtime tarball. The archive extracts to src/ and includes
tracked source files plus built runtime artifacts such as node_modules, dist
trees, the project bundle, and generated static assets.

Set STAR_RUNTIME_BUILD=0 to skip the local build step and package the current
workspace state.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

use_node_26() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 26 >/dev/null
  fi
}

build_runtime() {
  if [ "$STAR_RUNTIME_BUILD" = "0" ]; then
    log "skipping local build because STAR_RUNTIME_BUILD=0"
    return
  fi

  log "building workspace runtime artifacts"
  (
    cd "$SRC_ROOT"
    use_node_26
    export COCALC_SETUP_PROFILE=star
    if command -v corepack >/dev/null 2>&1; then
      corepack enable
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
      npm install -g pnpm@10.33.0
    fi
    ./workspaces.py install
    pnpm --filter @cocalc/app-notebook build
    ./workspaces.py build --dev
    pnpm python-api
    pnpm --dir packages/project build:bundle
  )
}

append_if_exists() {
  local path="$1"
  if [ -e "${REPO_ROOT}/${path}" ] || [ -L "${REPO_ROOT}/${path}" ]; then
    printf '%s\0' "$path"
  fi
}

runtime_paths() {
  (
    cd "$REPO_ROOT"
    git ls-files -z src
    git ls-files -z --others --exclude-standard src

    append_if_exists src/packages/node_modules
    find src/packages -mindepth 2 -maxdepth 3 -type d -name node_modules -print0
    find src/packages -mindepth 2 -maxdepth 3 -type d -name dist -print0
    find src/packages -mindepth 2 -maxdepth 3 -type d -name dist-ts -print0
    append_if_exists src/packages/project/build
    find src/packages -mindepth 2 -maxdepth 3 -type f -name .successful-build -print0
    append_if_exists src/python/cocalc-api/site
  )
}

build_runtime

[ -d "$SRC_ROOT/packages/node_modules" ] || die "missing src/packages/node_modules; build did not install dependencies"
[ -d "$SRC_ROOT/packages/static/dist" ] || die "missing src/packages/static/dist; build did not produce frontend assets"
[ -d "$SRC_ROOT/packages/project/build/bundle" ] || die "missing project bundle; build did not produce project runtime"
[ -x "$SRC_ROOT/packages/backend/node_modules/.bin/dropbear" ] || die "missing backend tools bundle dropbear"

mkdir -p "$(dirname "$OUTPUT")"
log "creating $OUTPUT"
runtime_paths | tar --null -czf "$OUTPUT" \
  --exclude='src/python/cocalc-api/.venv' \
  --exclude='*/.cache/*' \
  --exclude='*/.tmp/*' \
  --files-from -

log "wrote $OUTPUT"
