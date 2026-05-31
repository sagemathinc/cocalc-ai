#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
BUILD_TARBALL="${SCRIPT_DIR}/build-star-tarball.sh"

git_revision="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
if [ -z "$git_revision" ]; then
  git_revision="nogit"
fi

STAR_RELEASE_ID="${STAR_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${git_revision}}"
OUTPUT="${1:-${STAR_RELEASE_ARTIFACT:-${REPO_ROOT}/dist/star/cocalc-star-${STAR_RELEASE_ID}.tar.gz}}"

log() {
  printf '[star-release] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-star-release.sh [output.tar.gz]

Build a CoCalc Star release artifact.

The artifact extracts to a directory with:
  install.sh
  cocalc-star-src.tar.gz
  release.json
  SHA256SUMS

Install on a fresh Ubuntu 24.04 VM with:
  tar -xzf cocalc-star-<release>.tar.gz
  cd cocalc-star-<release>
  sudo STAR_ASSUME_YES=1 ./install.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

case "$STAR_RELEASE_ID" in
  "" | *[!A-Za-z0-9._-]*) die "invalid STAR_RELEASE_ID: $STAR_RELEASE_ID" ;;
esac

command -v git >/dev/null 2>&1 || die "git is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
[ -x "$BUILD_TARBALL" ] || die "missing source tarball builder: $BUILD_TARBALL"

artifact_name="cocalc-star-${STAR_RELEASE_ID}"
tmp_parent="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_parent"
}
trap cleanup EXIT

staging="${tmp_parent}/${artifact_name}"
mkdir -p "$staging"

source_tarball="${staging}/cocalc-star-src.tar.gz"
log "building source tarball"
"$BUILD_TARBALL" "$source_tarball"

source_sha256="$(sha256sum "$source_tarball" | awk '{print $1}')"
dirty="false"
if ! git -C "$REPO_ROOT" diff --quiet -- src || ! git -C "$REPO_ROOT" diff --cached --quiet -- src; then
  dirty="true"
fi

cat >"${staging}/release.json" <<EOF
{
  "product": "cocalc-star",
  "release_id": "${STAR_RELEASE_ID}",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_revision": "${git_revision}",
  "git_dirty": ${dirty},
  "source_tarball": "cocalc-star-src.tar.gz",
  "source_tarball_sha256": "${source_sha256}"
}
EOF

cat >"${staging}/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARBALL="${SCRIPT_DIR}/cocalc-star-src.tar.gz"
CHECKSUMS="${SCRIPT_DIR}/SHA256SUMS"
INSTALLER_TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$INSTALLER_TMP"
}
trap cleanup EXIT

[ -f "$TARBALL" ] || {
  echo "[star-release-install] missing source tarball: $TARBALL" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1 && [ -f "$CHECKSUMS" ]; then
  (cd "$SCRIPT_DIR" && sha256sum -c SHA256SUMS --ignore-missing)
fi

tar -xzf "$TARBALL" -C "$INSTALLER_TMP" src/scripts/star/install-from-tarball.sh
export STAR_RELEASE_ID="${STAR_RELEASE_ID:-__STAR_RELEASE_ID__}"
bash "$INSTALLER_TMP/src/scripts/star/install-from-tarball.sh" "$TARBALL"
EOF
sed -i "s/__STAR_RELEASE_ID__/${STAR_RELEASE_ID}/g" "${staging}/install.sh"
chmod 0755 "${staging}/install.sh"

(
  cd "$staging"
  sha256sum install.sh release.json cocalc-star-src.tar.gz >SHA256SUMS
)

mkdir -p "$(dirname "$OUTPUT")"
log "creating $OUTPUT"
tar -czf "$OUTPUT" -C "$tmp_parent" "$artifact_name"

log "wrote $OUTPUT"
