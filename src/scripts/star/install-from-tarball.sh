#!/usr/bin/env bash
set -euo pipefail

TARBALL="${1:-}"
STAR_INSTALL_ROOT="${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
STAR_INSTALL_SOURCE="${STAR_INSTALL_SOURCE:-${STAR_INSTALL_ROOT}/source}"

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

This removes and recreates ${STAR_INSTALL_SOURCE}, then runs the whole-machine
Star installer. Run this only on a dedicated VM.
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

require_root
resolve_star_user
getent passwd "$STAR_USER" >/dev/null || die "STAR_USER does not exist: $STAR_USER"
confirm_destructive_install

log "extracting $TARBALL to $STAR_INSTALL_SOURCE"
rm -rf "$STAR_INSTALL_SOURCE"
mkdir -p "$STAR_INSTALL_SOURCE"
tar -xzf "$TARBALL" -C "$STAR_INSTALL_SOURCE"
chown -R "$STAR_USER:$STAR_USER" "$STAR_INSTALL_SOURCE"

INSTALLER="${STAR_INSTALL_SOURCE}/src/scripts/star/install-star.sh"
[ -x "$INSTALLER" ] || die "missing installer in tarball: $INSTALLER"

log "running installer as STAR_USER=$STAR_USER"
export SRC_ROOT="${SRC_ROOT:-${STAR_INSTALL_SOURCE}/src}"
export STAR_ASSUME_YES=1
exec "$INSTALLER"
