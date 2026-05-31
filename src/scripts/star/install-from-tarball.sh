#!/usr/bin/env bash
set -euo pipefail

TARBALL="${1:-}"
STAR_INSTALL_ROOT="${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
STAR_INSTALL_SOURCE="${STAR_INSTALL_SOURCE:-${STAR_INSTALL_ROOT}/source}"
STAR_RELEASES_DIR="${STAR_RELEASES_DIR:-${STAR_INSTALL_ROOT}/releases}"
STAR_RELEASE_ID="${STAR_RELEASE_ID:-}"

log() {
  printf '[star-install] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-from-tarball.sh /path/to/cocalc-star-src.tar.gz

Extract a CoCalc Star source tarball onto a dedicated Ubuntu VM and run the
whole-machine installer.

Defaults:
  STAR_INSTALL_ROOT=/opt/cocalc-star
  STAR_INSTALL_SOURCE=$STAR_INSTALL_ROOT/source
  STAR_RELEASES_DIR=$STAR_INSTALL_ROOT/releases
  STAR_RELEASE_ID=<utc timestamp>-<tarball sha256 prefix>
  STAR_USER=<sudo caller>
  STAR_ASSUME_YES=0

Set STAR_ASSUME_YES=1 for non-interactive installs.
EOF
}

confirm_destructive_install() {
  if [ "${STAR_ASSUME_YES:-0}" = "1" ]; then
    return
  fi
  if [ ! -t 0 ]; then
    die "refusing non-interactive install without STAR_ASSUME_YES=1"
  fi

  cat >&2 <<EOF
CoCalc Star will be installed from:
  ${TARBALL}

Install root:
  ${STAR_INSTALL_ROOT}

This creates a new versioned release and points ${STAR_INSTALL_SOURCE} at it,
then runs the whole-machine Star installer. Run this only on a dedicated VM.
EOF
  read -r -p "Type 'install cocalc star' to continue: " answer
  if [ "$answer" != "install cocalc star" ]; then
    die "confirmation did not match"
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run as root, e.g. sudo STAR_ASSUME_YES=1 $0 $TARBALL"
  fi
}

resolve_star_user() {
  if [ -n "${STAR_USER:-}" ]; then
    return
  fi
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    STAR_USER="$SUDO_USER"
  else
    STAR_USER="${USER:-root}"
  fi
  export STAR_USER
}

replace_symlink() {
  local target="$1"
  local link="$2"
  rm -f "$link"
  ln -s "$target" "$link"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[ -n "$TARBALL" ] || {
  usage
  exit 2
}
[ -f "$TARBALL" ] || die "tarball does not exist: $TARBALL"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

require_root
resolve_star_user
getent passwd "$STAR_USER" >/dev/null || die "STAR_USER does not exist: $STAR_USER"
confirm_destructive_install

tarball_sha256="$(sha256sum "$TARBALL" | awk '{print $1}')"
if [ -z "$STAR_RELEASE_ID" ]; then
  STAR_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${tarball_sha256:0:12}"
fi

case "$STAR_RELEASE_ID" in
  "" | *[!A-Za-z0-9._-]*) die "invalid STAR_RELEASE_ID: $STAR_RELEASE_ID" ;;
esac

release_dir="${STAR_RELEASES_DIR}/${STAR_RELEASE_ID}"
release_source="${release_dir}/source"
previous_source=""

[ ! -e "$release_dir" ] || die "release already exists: $release_dir"
mkdir -p "$STAR_RELEASES_DIR"

if [ -e "$STAR_INSTALL_SOURCE" ] && [ ! -L "$STAR_INSTALL_SOURCE" ]; then
  legacy_id="legacy-$(date -u +%Y%m%dT%H%M%SZ)"
  legacy_dir="${STAR_RELEASES_DIR}/${legacy_id}"
  [ ! -e "$legacy_dir" ] || die "legacy release already exists: $legacy_dir"
  log "preserving existing source directory as $legacy_id"
  mkdir -p "$legacy_dir"
  mv "$STAR_INSTALL_SOURCE" "$legacy_dir/source"
  cat >"$legacy_dir/release.json" <<EOF
{
  "release_id": "${legacy_id}",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "legacy": true,
  "source_path": "${legacy_dir}/source"
}
EOF
  chown -R "$STAR_USER:$STAR_USER" "$legacy_dir"
  replace_symlink "$legacy_dir/source" "$STAR_INSTALL_SOURCE"
  replace_symlink "$legacy_dir" "${STAR_INSTALL_ROOT}/current"
fi

if [ -e "$STAR_INSTALL_SOURCE" ] || [ -L "$STAR_INSTALL_SOURCE" ]; then
  previous_source="$(readlink -f "$STAR_INSTALL_SOURCE" || true)"
fi

tmp_release="$(mktemp -d "${STAR_RELEASES_DIR}/.install.${STAR_RELEASE_ID}.XXXXXX")"

restore_previous_release() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "install failed; restoring previous source link"
    rm -rf "$tmp_release"
    if [ -n "$previous_source" ]; then
      replace_symlink "$previous_source" "$STAR_INSTALL_SOURCE"
    else
      rm -f "$STAR_INSTALL_SOURCE"
    fi
  fi
  exit "$status"
}
trap restore_previous_release EXIT

log "extracting $TARBALL to $release_source"
mkdir -p "$tmp_release/source"
tar -xzf "$TARBALL" -C "$tmp_release/source"
cat >"$tmp_release/release.json" <<EOF
{
  "release_id": "${STAR_RELEASE_ID}",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "tarball_sha256": "${tarball_sha256}",
  "source_path": "${release_source}"
}
EOF
chown -R "$STAR_USER:$STAR_USER" "$tmp_release"
mv "$tmp_release" "$release_dir"
replace_symlink "$release_source" "$STAR_INSTALL_SOURCE"

INSTALLER="${STAR_INSTALL_SOURCE}/src/scripts/star/install-star.sh"
[ -x "$INSTALLER" ] || die "missing installer in tarball: $INSTALLER"

log "running installer as STAR_USER=$STAR_USER release=$STAR_RELEASE_ID"
export SRC_ROOT="${SRC_ROOT:-${STAR_INSTALL_SOURCE}/src}"
export STAR_ASSUME_YES=1
"$INSTALLER"

replace_symlink "$release_dir" "${STAR_INSTALL_ROOT}/current"
trap - EXIT
log "installed release $STAR_RELEASE_ID"
