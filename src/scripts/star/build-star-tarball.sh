#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
OUTPUT="${1:-${STAR_TARBALL:-/tmp/cocalc-star-src.tar.gz}}"

log() {
  printf '[star-build] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-star-tarball.sh [output.tar.gz]

Build a CoCalc Star source tarball from tracked repository files. The archive
extracts to a directory containing src/, so a fresh Ubuntu VM can install with:

  tar -xzf cocalc-star-src.tar.gz -C /opt/cocalc-star
  sudo STAR_ASSUME_YES=1 SRC_ROOT=/opt/cocalc-star/src \
    /opt/cocalc-star/src/scripts/star/install-star.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

mkdir -p "$(dirname "$OUTPUT")"
log "creating $OUTPUT"
(
  cd "$REPO_ROOT"
  {
    git ls-files -z src
    git ls-files -z --others --exclude-standard src
  } | tar --null -czf "$OUTPUT" --files-from -
)

log "wrote $OUTPUT"
