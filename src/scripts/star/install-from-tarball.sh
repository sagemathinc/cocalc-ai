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
  STAR_USER=<existing Star user or cocalc-star>
  STAR_ASSUME_YES=0
  STAR_SSH_TARGET=<optional ssh target shown in access instructions>

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
  local existing_config="/etc/cocalc/star/config.env"
  if [ -f "$existing_config" ]; then
    local existing_star_user
    existing_star_user="$(bash -c 'set -euo pipefail; source "$1"; printf "%s" "${STAR_USER:-}"' _ "$existing_config" 2>/dev/null || true)"
    if [ -n "$existing_star_user" ] && getent passwd "$existing_star_user" >/dev/null; then
      STAR_USER="$existing_star_user"
      export STAR_USER
      return
    fi
  fi
  STAR_USER="cocalc-star"
  export STAR_USER
}

ensure_star_user() {
  case "$STAR_USER" in
    "" | *[!A-Za-z0-9._-]*) die "invalid STAR_USER: $STAR_USER" ;;
  esac
  if getent passwd "$STAR_USER" >/dev/null; then
    local star_home
    star_home="$(getent passwd "$STAR_USER" | cut -d: -f6)"
    [ -n "$star_home" ] || die "could not determine home directory for $STAR_USER"
    if [ ! -d "$star_home" ]; then
      log "creating Star runtime home $star_home"
      install -d -o "$STAR_USER" -g "$STAR_USER" -m 0750 "$star_home"
    else
      chown "$STAR_USER:$STAR_USER" "$star_home"
    fi
    return
  fi
  log "creating Star runtime user $STAR_USER"
  useradd --create-home --shell /bin/bash "$STAR_USER"
  chown "$STAR_USER:$STAR_USER" "$(getent passwd "$STAR_USER" | cut -d: -f6)"
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
ensure_star_user
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
release_dir_created=0

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
rollback_state_dir="$(mktemp -d "${STAR_RELEASES_DIR}/.rollback.${STAR_RELEASE_ID}.XXXXXX")"
rollback_missing_list="${rollback_state_dir}/missing-files"
touch "$rollback_missing_list"

snapshot_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    mkdir -p "${rollback_state_dir}${path%/*}"
    cp -a "$path" "${rollback_state_dir}${path}"
  else
    printf '%s\n' "$path" >>"$rollback_missing_list"
  fi
}

restore_path() {
  local path="$1"
  if [ -e "${rollback_state_dir}${path}" ] || [ -L "${rollback_state_dir}${path}" ]; then
    rm -rf "$path"
    mkdir -p "${path%/*}"
    cp -a "${rollback_state_dir}${path}" "$path"
  fi
}

snapshot_mutable_state() {
  snapshot_path /etc/cocalc/star/config.env
  snapshot_path /etc/cocalc/star/hub.env
  snapshot_path /etc/cocalc/project-host.env
  snapshot_path /etc/systemd/system/cocalc-star-hub.service
  snapshot_path /etc/systemd/system/cocalc-star-project-host.service
  snapshot_path /etc/caddy/Caddyfile
}

restore_mutable_state() {
  restore_path /etc/cocalc/star/config.env
  restore_path /etc/cocalc/star/hub.env
  restore_path /etc/cocalc/project-host.env
  restore_path /etc/systemd/system/cocalc-star-hub.service
  restore_path /etc/systemd/system/cocalc-star-project-host.service
  restore_path /etc/caddy/Caddyfile
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    rm -rf "$path"
  done <"$rollback_missing_list"
  systemctl daemon-reload >/dev/null 2>&1 || true
}

restore_previous_release() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "install failed; restoring previous source link"
    rm -rf "$tmp_release"
    if [ "$release_dir_created" = "1" ]; then
      rm -rf "$release_dir"
    fi
    if [ -n "$previous_source" ]; then
      replace_symlink "$previous_source" "$STAR_INSTALL_SOURCE"
    else
      rm -f "$STAR_INSTALL_SOURCE"
    fi
    restore_mutable_state
    if [ -n "$previous_source" ]; then
      systemctl start cocalc-star-hub.service cocalc-star-project-host.service >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$rollback_state_dir"
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
release_dir_created=1
replace_symlink "$release_source" "$STAR_INSTALL_SOURCE"

INSTALLER="${STAR_INSTALL_SOURCE}/src/scripts/star/install-star.sh"
[ -x "$INSTALLER" ] || die "missing installer in tarball: $INSTALLER"

log "running installer as STAR_USER=$STAR_USER release=$STAR_RELEASE_ID"
snapshot_mutable_state
export SRC_ROOT="${SRC_ROOT:-${STAR_INSTALL_SOURCE}/src}"
export STAR_ASSUME_YES=1
export STAR_INSTALL_ROOT
export STAR_INSTALL_SOURCE
export STAR_RELEASES_DIR
export STAR_RELEASE_ID
export STAR_USER
export STAR_SSH_TARGET="${STAR_SSH_TARGET:-}"
"$INSTALLER"

replace_symlink "$release_dir" "${STAR_INSTALL_ROOT}/current"
rm -rf "$rollback_state_dir"
trap - EXIT
log "installed release $STAR_RELEASE_ID"
if [ -x "${STAR_INSTALL_SOURCE}/src/scripts/star/star.sh" ]; then
  "${STAR_INSTALL_SOURCE}/src/scripts/star/star.sh" bootstrap-link || true
fi
