#!/usr/bin/env bash
set -euo pipefail

# First-boot and upgrade initializer for the CoCalc Star Docker image.
#
# Everything that must survive an image upgrade lives in the /var/lib/cocalc
# volume. The container filesystem (/opt, /etc, ...) is disposable: a new
# container, e.g. after `docker pull` of a newer image, starts with an empty
# install and this script reinstalls the embedded release over the existing
# volume. The Star installer is idempotent and reuses the database, secrets,
# btrfs project storage and RootFS cache it finds there.

RELEASE_ARTIFACT="${COCALC_STAR_DOCKER_RELEASE_ARTIFACT:-/usr/local/share/cocalc-star-docker/cocalc-star-release.tar.gz}"
PREBUILT_ROOTFS_CACHE="${COCALC_STAR_DOCKER_PREBUILT_ROOTFS_CACHE:-/usr/local/share/cocalc-star-docker/cocalc-star-rootfs-cache.tar.gz}"
IMAGE_RELEASE_ID="${COCALC_STAR_IMAGE_RELEASE_ID:-$(cat /usr/local/share/cocalc-star-docker/release-id 2>/dev/null || printf unknown)}"
STATE_DIR="${COCALC_STAR_DOCKER_STATE_DIR:-/var/lib/cocalc/star-docker}"
INSTALL_MARKER="${STATE_DIR}/installed-release"
CONTAINER_MARKER="/etc/cocalc-star-docker-installed-release"
DOMAIN="${COCALC_STAR_DOMAIN:-}"
LOG_FILE="${COCALC_STAR_DOCKER_LOG_FILE:-/var/log/cocalc-star-docker-init.log}"
STAR_SH=/opt/cocalc-star/source/src/scripts/star/star.sh

if [ -n "$DOMAIN" ]; then
  DEFAULT_ACCESS_URL="https://${DOMAIN}"
elif [ -n "${COCALC_STAR_HTTP_PORT:-}" ] && [ "${COCALC_STAR_HTTP_PORT}" != "80" ]; then
  DEFAULT_ACCESS_URL="http://${COCALC_STAR_HOSTNAME:-localhost}:${COCALC_STAR_HTTP_PORT}"
else
  DEFAULT_ACCESS_URL="http://${COCALC_STAR_HOSTNAME:-localhost}"
fi

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

# Keep a directory of the disposable container filesystem in the volume by
# replacing it with a symlink. On the first boot of a new volume, the image's
# initial contents are moved into the volume.
persist_dir() {
  local path="$1"
  local target="$2"
  local owner="${3:-}"
  mkdir -p "$(dirname "$target")"
  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
    :
  else
    if [ ! -d "$target" ]; then
      if [ -d "$path" ]; then
        cp -a "$path" "$target"
      else
        mkdir -p "$target"
      fi
    fi
    rm -rf "$path"
    mkdir -p "$(dirname "$path")"
    ln -s "$target" "$path"
  fi
  if [ -n "$owner" ]; then
    chown -R "$owner" "$target"
  fi
}

persist_state() {
  mkdir -p "$STATE_DIR"
  # Images before this layout kept configuration and certificates in the
  # container filesystem. Once that container is removed they are gone; the
  # README documents copying them into the volume before upgrading.
  if [ -d /var/lib/cocalc/star/launchpad ] && [ ! -d "${STATE_DIR}/etc-cocalc-star" ]; then
    log "warning: this volume was created by an older image that kept Star configuration and TLS certificates outside the volume"
    log "warning: set COCALC_STAR_DOMAIN to restore HTTPS; a new certificate will be requested once"
  fi
  # Star configuration, including the public URL chosen by `star.sh https`.
  persist_dir /etc/cocalc/star "${STATE_DIR}/etc-cocalc-star"
  # Caddy's ACME account and TLS certificates; without this every upgrade
  # would request new certificates and could hit Let's Encrypt rate limits.
  persist_dir /var/lib/caddy "${STATE_DIR}/caddy" caddy:caddy
}

load_apparmor_profile() {
  # AppArmor policy is global to the host kernel and does not survive a host
  # reboot, so load it on every boot. Hosts without AppArmor do not restrict
  # user namespaces this way and need nothing.
  local profile=/etc/apparmor.d/cocalc-star-podman
  if [ ! -d /sys/kernel/security/apparmor ]; then
    return 0
  fi
  if ! command -v apparmor_parser >/dev/null 2>&1 || [ ! -f "$profile" ]; then
    log "warning: cannot load ${profile}; project containers may fail on hosts that restrict user namespaces"
    return 0
  fi
  if apparmor_parser -r -W "$profile" 2>/dev/null; then
    log "loaded AppArmor profile for the managed Podman runtime"
  else
    log "warning: failed to load ${profile}; project containers may fail on hosts that restrict user namespaces"
  fi
}

star_installed() {
  [ -x "$STAR_SH" ] &&
    [ -f /etc/cocalc/star/config.env ] &&
    [ "$(cat "$CONTAINER_MARKER" 2>/dev/null || true)" = "$IMAGE_RELEASE_ID" ]
}

run_install() {
  [ -f "$RELEASE_ARTIFACT" ] || die "missing embedded Star release artifact: $RELEASE_ARTIFACT"

  local previous=""
  previous="$(cat "$INSTALL_MARKER" 2>/dev/null || true)"
  if [ -z "$previous" ]; then
    log "first boot: installing CoCalc Star ${IMAGE_RELEASE_ID} into a new data volume"
  elif [ "$previous" = "$IMAGE_RELEASE_ID" ]; then
    log "new container for CoCalc Star ${IMAGE_RELEASE_ID}: reinstalling over the existing data volume"
  else
    log "upgrading CoCalc Star from ${previous} to ${IMAGE_RELEASE_ID}; existing data is preserved"
  fi

  local tmp release_dir
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  log "extracting embedded release artifact"
  tar -xzf "$RELEASE_ARTIFACT" -C "$tmp"
  release_dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | sort | head -1)"
  [ -n "$release_dir" ] || die "release artifact did not contain a release directory"
  [ -x "${release_dir}/install.sh" ] || die "release artifact is missing install.sh"

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
  export STAR_DEFAULT_ROOTFS_BUILD_ISOLATION="${COCALC_STAR_DEFAULT_ROOTFS_BUILD_ISOLATION:-chroot}"
  export STAR_PROJECT_HOST_REGION="${COCALC_STAR_PROJECT_HOST_REGION:-local}"
  export STAR_PROJECT_ROOTFS_MODE="${COCALC_STAR_PROJECT_ROOTFS_MODE:-copy}"
  export STAR_SSH_TARGET="${COCALC_STAR_SSH_TARGET:-}"

  log "installing Star runtime as STAR_USER=${STAR_USER}"
  "${release_dir}/install.sh"

  printf '%s\n' "$IMAGE_RELEASE_ID" >"$INSTALL_MARKER"
  printf '%s\n' "$IMAGE_RELEASE_ID" >"$CONTAINER_MARKER"
  chmod 0644 "$INSTALL_MARKER" "$CONTAINER_MARKER"
}

start_services() {
  systemctl daemon-reload
  systemctl enable caddy cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host >/dev/null
  systemctl restart caddy cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host
}

configure_domain() {
  [ -n "$DOMAIN" ] || return 0
  local current=""
  current="$(env -i bash -c 'source /etc/cocalc/star/config.env 2>/dev/null; printf "%s" "${STAR_PUBLIC_URL:-}"')"
  if [ "$current" = "https://${DOMAIN}" ] && grep -q "^${DOMAIN//./\\.} {" /etc/caddy/Caddyfile 2>/dev/null; then
    return 0
  fi
  log "configuring HTTPS for ${DOMAIN}"
  local -a args=(https --domain "$DOMAIN")
  if [ -n "${COCALC_STAR_ACME_EMAIL:-}" ]; then
    args+=(--email "$COCALC_STAR_ACME_EMAIL")
  fi
  "$STAR_SH" "${args[@]}"
}

reconcile_projects() {
  # Project containers do not survive a container restart; projects the
  # database still considers running must be marked stopped so users can
  # start them again.
  # The hub starts the local database, so retry while it comes up.
  local output attempt
  for attempt in $(seq 1 24); do
    if output="$("$STAR_SH" reconcile-runtime-state 2>&1)"; then
      return 0
    fi
    sleep 5
  done
  log "warning: project runtime reconciliation failed:"
  printf '%s\n' "$output" | tail -n 20
}

print_access() {
  "$STAR_SH" access || true
  "$STAR_SH" bootstrap-link || true
}

main() {
  /usr/local/sbin/cocalc-star-docker-preflight
  persist_state
  load_apparmor_profile

  if star_installed; then
    log "CoCalc Star ${IMAGE_RELEASE_ID} is installed; starting services"
  else
    run_install
  fi

  start_services
  configure_domain
  reconcile_projects
  print_access
  log "CoCalc Star ${IMAGE_RELEASE_ID} is ready"
}

main "$@"
