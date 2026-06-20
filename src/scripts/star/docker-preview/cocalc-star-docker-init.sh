#!/usr/bin/env bash
set -euo pipefail

RELEASE_ARTIFACT="${COCALC_STAR_DOCKER_RELEASE_ARTIFACT:-/usr/local/share/cocalc-star-docker/cocalc-star-release.tar.gz}"
PREBUILT_ROOTFS_CACHE="${COCALC_STAR_DOCKER_PREBUILT_ROOTFS_CACHE:-/usr/local/share/cocalc-star-docker/cocalc-star-rootfs-cache.tar.gz}"
STATE_DIR="${COCALC_STAR_DOCKER_STATE_DIR:-/var/lib/cocalc/star-docker}"
INSTALL_MARKER="${STATE_DIR}/installed-release"
DEFAULT_ACCESS_URL="http://${COCALC_STAR_HOSTNAME:-localhost}:${COCALC_STAR_HTTP_PORT:-8170}"
LOG_FILE="${COCALC_STAR_DOCKER_LOG_FILE:-/var/log/cocalc-star-docker-init.log}"

install -d -m 0755 "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 0644 "$LOG_FILE"
if [ "${COCALC_STAR_DOCKER_TEE_STDOUT:-1}" = "1" ]; then
  exec > >(tee -a "$LOG_FILE") 2> >(tee -a "$LOG_FILE" >&2)
else
  exec >>"$LOG_FILE" 2>&1
fi

log() {
  printf '[star-docker-init] %s\n' "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

star_installed() {
  [ -x /opt/cocalc-star/source/src/scripts/star/star.sh ] &&
    [ -f /etc/cocalc/star/config.env ]
}

run_install() {
  [ -f "$RELEASE_ARTIFACT" ] || die "missing embedded Star release artifact: $RELEASE_ARTIFACT"

  local tmp release_dir
  tmp="$(mktemp -d)"
  cleanup() {
    rm -rf "${tmp:-}"
  }
  trap cleanup RETURN

  log "extracting embedded release artifact"
  tar -xzf "$RELEASE_ARTIFACT" -C "$tmp"
  release_dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | sort | head -1)"
  [ -n "$release_dir" ] || die "release artifact did not contain a release directory"
  [ -x "${release_dir}/install.sh" ] || die "release artifact is missing install.sh"

  mkdir -p "$STATE_DIR"

  export STAR_ASSUME_YES=1
  export STAR_USER="${COCALC_STAR_USER:-cocalc-star}"
  export STAR_ACCESS_URL="${COCALC_STAR_ACCESS_URL:-$DEFAULT_ACCESS_URL}"
  export STAR_WEB_ONBOARDING="${COCALC_STAR_WEB_ONBOARDING:-0}"
  export STAR_BUILD="${COCALC_STAR_BUILD:-0}"
  if [ -s "$PREBUILT_ROOTFS_CACHE" ]; then
    export STAR_BUILD_DEFAULT_ROOTFS="${COCALC_STAR_BUILD_DEFAULT_ROOTFS:-0}"
    export STAR_PREBUILT_ROOTFS_CACHE_TARBALL="$PREBUILT_ROOTFS_CACHE"
  else
    export STAR_BUILD_DEFAULT_ROOTFS="${COCALC_STAR_BUILD_DEFAULT_ROOTFS:-1}"
  fi
  export STAR_BTRFS_IMAGE="${COCALC_STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}"
  export STAR_BTRFS_SIZE="${COCALC_STAR_BTRFS_SIZE:-40G}"
  export STAR_DEFAULT_ROOTFS_IMAGE="${COCALC_STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
  export STAR_DEFAULT_ROOTFS_BASE_IMAGE="${COCALC_STAR_DEFAULT_ROOTFS_BASE_IMAGE:-docker.io/buildpack-deps:26.04}"
  export STAR_PROJECT_HOST_REGION="${COCALC_STAR_PROJECT_HOST_REGION:-local}"
  export STAR_PROJECT_ROOTFS_MODE="${COCALC_STAR_PROJECT_ROOTFS_MODE:-copy}"
  export STAR_SSH_TARGET="${COCALC_STAR_SSH_TARGET:-}"

  log "installing Star runtime as STAR_USER=${STAR_USER}"
  "${release_dir}/install.sh"

  basename "$release_dir" >"$INSTALL_MARKER"
  chmod 0644 "$INSTALL_MARKER"
}

start_services() {
  if ! star_installed; then
    die "Star is not installed after first-boot initializer"
  fi
  systemctl daemon-reload
  systemctl enable caddy cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host >/dev/null
  systemctl restart caddy cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host
}

print_access() {
  /opt/cocalc-star/source/src/scripts/star/star.sh access || true
  /opt/cocalc-star/source/src/scripts/star/star.sh bootstrap-link || true
}

main() {
  /usr/local/sbin/cocalc-star-docker-preflight

  if star_installed; then
    log "Star is already installed; ensuring services are running"
  else
    run_install
  fi

  start_services
  print_access
}

main "$@"
