#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEGACY_INSTALLER="${SCRIPT_DIR}/../star-poc/bootstrap-star-poc.sh"

log() {
  printf '[star-install] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-star.sh [env overrides]

Install CoCalc Star onto a dedicated Ubuntu 24.04 VM.

This is intentionally a whole-machine installer. It installs system packages,
builds CoCalc, configures local Postgres, configures rootless Podman project
execution, creates a local project host, installs systemd services, and starts
the Star control plane on port 9100 behind Caddy on port 80.

Important defaults:
  STAR_USER=<sudo caller>       Linux user that owns the Star runtime
  SRC_ROOT=$STAR_HOME/cocalc-ai/src
  STAR_ROOT=/var/lib/cocalc/star
  STAR_BASE_URL=http://127.0.0.1:9100
  STAR_PUBLIC_URL=              optional public https://... URL
  STAR_ACCESS_URL=              optional browser-facing URL, e.g. http://localhost:8170
  STAR_WEB_ONBOARDING=auto      serve /star-install/<nonce>/ when public URL is set
  STAR_WEB_ONBOARDING_REQUIRE_OPEN=auto
                                require opening the HTTPS page for interactive installs
  STAR_BTRFS_IMAGE=/var/lib/cocalc/btrfs.img
  STAR_BTRFS_SIZE=100G
  STAR_BUILD=1
  STAR_BUILD_DEFAULT_ROOTFS=1
  STAR_DEFAULT_ROOTFS_IMAGE=containers-storage:localhost/cocalc-star-rootfs:latest
  STAR_DEFAULT_ROOTFS_BASE_IMAGE=docker.io/buildpack-deps:26.04

Safety:
  Set STAR_ASSUME_YES=1 for non-interactive installs. Without it, this script
  asks for confirmation because it changes system packages, systemd services,
  sudoers, mounts, and local runtime data.

After install, configure direct HTTPS with:
  sudo /opt/cocalc-star/source/src/scripts/star/star.sh https --domain star.example.com
EOF
}

confirm_destructive_install() {
  if [ "${STAR_ASSUME_YES:-0}" = "1" ]; then
    return
  fi
  if [ ! -t 0 ]; then
    die "refusing non-interactive install without STAR_ASSUME_YES=1"
  fi

  cat >&2 <<'EOF'
CoCalc Star is a whole-machine installer.

It will install packages, configure mounts, write /etc/cocalc, install systemd
services, configure sudoers for the Star runtime user, and start local CoCalc
services. Run this only on a dedicated VM.
EOF
  read -r -p "Type 'install cocalc star' to continue: " answer
  if [ "$answer" != "install cocalc star" ]; then
    die "confirmation did not match"
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[ -x "$LEGACY_INSTALLER" ] || die "missing installer implementation: $LEGACY_INSTALLER"
confirm_destructive_install
exec "$LEGACY_INSTALLER" "$@"
