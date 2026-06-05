#!/usr/bin/env bash
set -euo pipefail

DEFAULT_RELEASE_BASE_URL="https://github.com/sagemathinc/cocalc-ai/releases/latest/download"
RELEASE_BASE_URL="${COCALC_STAR_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
RELEASE_URL="${COCALC_STAR_RELEASE_URL:-${1:-}}"
if [ -z "${STAR_ASSUME_YES+x}" ]; then
  if [ -t 0 ]; then
    STAR_ASSUME_YES=0
  else
    STAR_ASSUME_YES=1
  fi
fi
STAR_PUBLIC_URL="${STAR_PUBLIC_URL:-}"
STAR_PUBLIC_URL_AUTO="${STAR_PUBLIC_URL_AUTO:-1}"

log() {
  printf '[star-install-release] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install-release.sh <cocalc-star-release.tar.gz-url-or-path>

Download or read a CoCalc Star release artifact, verify its internal checksums,
and run the versioned installer included in the artifact.

Examples:
  sudo STAR_ASSUME_YES=1 ./install-release.sh https://example.com/cocalc-star.tar.gz

  curl -fsSL https://example.com/install-release.sh \
    | sudo bash -s -- https://example.com/cocalc-star.tar.gz

  curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh \
    | sudo bash

Environment:
  COCALC_STAR_RELEASE_URL   Alternative to the positional release URL/path.
  COCALC_STAR_RELEASE_BASE_URL
                            Base URL used when no explicit release URL is
                            provided. Default:
                            https://github.com/sagemathinc/cocalc-ai/releases/latest/download
  COCALC_STAR_RELEASE_ARCH  Override auto-detected Linux arch: x64 or arm64.
  COCALC_STAR_RELEASE_ASSET Override default asset name.
  STAR_ASSUME_YES=1         Skip destructive install confirmation. Defaults to
                            1 for piped non-interactive installs and 0 for
                            interactive local script runs.
  STAR_PUBLIC_URL           Public https:// URL. Defaults to
                            https://<detected-public-ip>.sslip.io when possible.
  STAR_PUBLIC_URL_AUTO=0    Disable automatic sslip.io public URL detection.
  STAR_INSTALL_ROOT         Passed through to the release installer.
  STAR_USER                 Passed through to the release installer.
  STAR_SSH_TARGET           Optional SSH target to show in post-install tunnel
                            instructions, e.g. ubuntu@1.2.3.4.

Run only on a dedicated Ubuntu VM. The release installer changes system
packages, systemd services, sudoers, mounts, and local runtime data.
EOF
}

detect_release_arch() {
  if [ -n "${COCALC_STAR_RELEASE_ARCH:-}" ]; then
    printf '%s\n' "$COCALC_STAR_RELEASE_ARCH"
    return
  fi
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    *) die "unsupported architecture $(uname -m); set COCALC_STAR_RELEASE_URL explicitly" ;;
  esac
}

default_release_url() {
  local arch asset
  arch="$(detect_release_arch)"
  case "$arch" in
    x64 | arm64) ;;
    *) die "unsupported COCALC_STAR_RELEASE_ARCH=$arch; expected x64 or arm64" ;;
  esac
  asset="${COCALC_STAR_RELEASE_ASSET:-cocalc-star-runtime-linux-${arch}.tar.gz}"
  printf '%s/%s\n' "${RELEASE_BASE_URL%/}" "$asset"
}

valid_ipv4() {
  local ip="$1"
  case "$ip" in
    *[!0-9.]* | *.*.*.*.* | .* | *. | *..*) return 1 ;;
  esac
  IFS=. read -r a b c d extra <<EOF
$ip
EOF
  [ -z "${extra:-}" ] || return 1
  for part in "$a" "$b" "$c" "$d"; do
    [ -n "$part" ] || return 1
    [ "$part" -ge 0 ] 2>/dev/null && [ "$part" -le 255 ] || return 1
  done
}

detect_public_url() {
  if [ -n "${STAR_PUBLIC_URL:-}" ]; then
    export STAR_PUBLIC_URL
    return
  fi
  case "$STAR_PUBLIC_URL_AUTO" in
    0 | false | no | off) return ;;
  esac
  local ip
  ip="$(curl -4fsSL --connect-timeout 5 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if valid_ipv4 "$ip"; then
    STAR_PUBLIC_URL="https://${ip}.sslip.io"
    export STAR_PUBLIC_URL
    if [ -z "${STAR_WEB_ONBOARDING_REQUIRE_OPEN+x}" ]; then
      STAR_WEB_ONBOARDING_REQUIRE_OPEN=1
      export STAR_WEB_ONBOARDING_REQUIRE_OPEN
    fi
    log "detected public URL ${STAR_PUBLIC_URL}"
  else
    log "could not detect public IPv4 address; continuing without public HTTPS onboarding"
  fi
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run as root, e.g. sudo STAR_ASSUME_YES=1 $0 <release-url>"
  fi
}

confirm_destructive_install() {
  if [ "$STAR_ASSUME_YES" = "1" ]; then
    return
  fi
  if [ ! -t 0 ]; then
    die "refusing non-interactive install without STAR_ASSUME_YES=1"
  fi

  cat >&2 <<EOF
CoCalc Star will install from:
  ${RELEASE_URL}

This is a whole-machine install for a dedicated VM.
EOF
  read -r -p "Type 'install cocalc star' to continue: " answer
  if [ "$answer" != "install cocalc star" ]; then
    die "confirmation did not match"
  fi
}

download_release() {
  local source="$1"
  local dest="$2"
  case "$source" in
    http://* | https://*)
      command -v curl >/dev/null 2>&1 || die "curl is required to download releases"
      curl -fL "$source" -o "$dest"
      ;;
    *)
      [ -f "$source" ] || die "release artifact does not exist: $source"
      cp "$source" "$dest"
      ;;
  esac
}

find_release_dir() {
  local extract_dir="$1"
  local candidate count
  count="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | wc -l)"
  [ "$count" = "1" ] || die "release artifact must contain exactly one top-level directory"
  candidate="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -x "${candidate}/install.sh" ] || die "release artifact is missing executable install.sh"
  printf '%s\n' "$candidate"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

[ -n "$RELEASE_URL" ] || {
  RELEASE_URL="$(default_release_url)"
}

require_root
detect_public_url
confirm_destructive_install

command -v tar >/dev/null 2>&1 || die "tar is required"
command -v mktemp >/dev/null 2>&1 || die "mktemp is required"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

release_archive="${tmp_dir}/cocalc-star-release.tar.gz"
extract_dir="${tmp_dir}/extract"
mkdir -p "$extract_dir"

log "fetching release ${RELEASE_URL}"
download_release "$RELEASE_URL" "$release_archive"

log "extracting release"
tar -xzf "$release_archive" -C "$extract_dir"
release_dir="$(find_release_dir "$extract_dir")"

log "running release installer"
cd "$release_dir"
export STAR_ASSUME_YES
export STAR_PUBLIC_URL="${STAR_PUBLIC_URL:-}"
export STAR_WEB_ONBOARDING_REQUIRE_OPEN="${STAR_WEB_ONBOARDING_REQUIRE_OPEN:-}"
exec ./install.sh
