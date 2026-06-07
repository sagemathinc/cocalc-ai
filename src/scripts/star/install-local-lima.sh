#!/usr/bin/env bash
set -euo pipefail

DEFAULT_RELEASE_BASE_URL="https://github.com/sagemathinc/cocalc-ai/releases/latest/download"

LIMA_INSTANCE="${COCALC_STAR_LIMA_INSTANCE:-cocalc-star}"
LIMA_HOST_PORT="${COCALC_STAR_LIMA_HOST_PORT:-8170}"
LIMA_GUEST_PORT="${COCALC_STAR_LIMA_GUEST_PORT:-80}"
LIMA_CPUS="${COCALC_STAR_LIMA_CPUS:-}"
LIMA_MEMORY="${COCALC_STAR_LIMA_MEMORY:-}"
LIMA_DISK="${COCALC_STAR_LIMA_DISK:-100GiB}"
LIMA_TEMPLATE="${COCALC_STAR_LIMA_TEMPLATE:-template:ubuntu-24.04}"
RELEASE_BASE_URL="${COCALC_STAR_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
INSTALLER_URL="${COCALC_STAR_INSTALLER_URL:-${RELEASE_BASE_URL%/}/install-cocalc-star.sh}"
ACCESS_URL="${COCALC_STAR_ACCESS_URL:-http://localhost:${LIMA_HOST_PORT}}"
OPEN_BROWSER="${COCALC_STAR_LIMA_OPEN_BROWSER:-1}"

log() {
  printf '[star-lima] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star-local-lima.sh | bash

Create or start a Lima Ubuntu VM, install CoCalc Star inside it, and expose the
site on a localhost URL such as http://localhost:8170/.

Environment:
  COCALC_STAR_LIMA_INSTANCE      Lima instance name. Default: cocalc-star
  COCALC_STAR_LIMA_HOST_PORT     Host localhost port. Default: 8170
  COCALC_STAR_LIMA_CPUS          VM CPUs. Default: Lima default
  COCALC_STAR_LIMA_MEMORY        VM memory, e.g. 16GiB. Default: host-aware
  COCALC_STAR_LIMA_DISK          VM disk size. Default: 100GiB
  COCALC_STAR_LIMA_TEMPLATE      Lima template. Default: template:ubuntu-24.04
  COCALC_STAR_RELEASE_BASE_URL   Release base URL. Default: GitHub latest
  COCALC_STAR_RELEASE_URL        Explicit runtime asset URL passed to the guest
  COCALC_STAR_LIMA_OPEN_BROWSER  Open browser after install. Default: 1

Install Lima first:
  macOS:  brew install lima
  Linux:  install Lima from your distro, Homebrew on Linux, or lima-vm.io
EOF
}

shell_quote() {
  printf '%q' "$1"
}

host_memory_gib() {
  local bytes=""
  if command -v sysctl >/dev/null 2>&1; then
    bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  fi
  if [ -z "$bytes" ] && command -v getconf >/dev/null 2>&1; then
    local pages page_size
    pages="$(getconf _PHYS_PAGES 2>/dev/null || true)"
    page_size="$(getconf PAGE_SIZE 2>/dev/null || true)"
    if [ -n "$pages" ] && [ -n "$page_size" ]; then
      bytes=$((pages * page_size))
    fi
  fi
  if [ -n "$bytes" ] && [ "$bytes" -gt 0 ] 2>/dev/null; then
    printf '%s\n' $((bytes / 1024 / 1024 / 1024))
  fi
}

default_memory() {
  local host_gib half
  host_gib="$(host_memory_gib || true)"
  if [ -z "$host_gib" ] || [ "$host_gib" -le 0 ] 2>/dev/null; then
    printf '8GiB\n'
    return
  fi
  half=$((host_gib / 2))
  if [ "$host_gib" -lt 12 ]; then
    printf '4GiB\n'
  elif [ "$half" -lt 8 ]; then
    printf '8GiB\n'
  elif [ "$half" -gt 64 ]; then
    printf '64GiB\n'
  else
    printf '%sGiB\n' "$half"
  fi
}

instance_exists() {
  limactl list --format '{{.Name}}' 2>/dev/null | grep -Fx "$LIMA_INSTANCE" >/dev/null
}

warn_existing_project_host_forward() {
  local config="${HOME}/.lima/${LIMA_INSTANCE}/lima.yaml"
  [ -f "$config" ] || return 0
  grep -Eq "hostPort:[[:space:]]*9002\\b" "$config" || return 0
  cat >&2 <<EOF
[star-lima] WARNING: existing Lima instance ${LIMA_INSTANCE} forwards
[star-lima]          the project-host port 9002.
[star-lima]
[star-lima]          Current CoCalc Star routes project traffic through
[star-lima]          http://localhost:${LIMA_HOST_PORT}/<project-id> so the hub
[star-lima]          can inject project-host authentication. A direct 9002
[star-lima]          forward is no longer needed and can keep stale browser tabs
[star-lima]          trying the wrong route.
[star-lima]
[star-lima]          To remove it, stop the instance, delete the guestPort 9002
[star-lima]          block from:
[star-lima]            ${config}
[star-lima]
[star-lima]          Then run:
[star-lima]            limactl stop ${LIMA_INSTANCE}
[star-lima]            limactl start ${LIMA_INSTANCE}
EOF
}

open_browser() {
  [ "$OPEN_BROWSER" = "1" ] || return 0
  if command -v open >/dev/null 2>&1; then
    open "$ACCESS_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$ACCESS_URL" >/dev/null 2>&1 || true
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "$ACCESS_URL" >/dev/null 2>&1 || true
  fi
}

write_lima_config() {
  local path="$1"
  cat >"$path" <<EOF
base:
- ${LIMA_TEMPLATE}

cpus: ${LIMA_CPUS:-null}
memory: "${LIMA_MEMORY}"
disk: "${LIMA_DISK}"
mounts: []

containerd:
  system: false
  user: false

portForwards:
- guestPort: ${LIMA_GUEST_PORT}
  hostPort: ${LIMA_HOST_PORT}
  hostIP: "127.0.0.1"
EOF
}

start_instance() {
  if instance_exists; then
    warn_existing_project_host_forward
    log "starting existing Lima instance ${LIMA_INSTANCE}"
    limactl start "$LIMA_INSTANCE"
    return
  fi

  local config
  config="$(mktemp -t cocalc-star-lima.XXXXXX.yaml)"
  write_lima_config "$config"
  log "creating Lima instance ${LIMA_INSTANCE}"
  log "memory=${LIMA_MEMORY} disk=${LIMA_DISK} localhost=${ACCESS_URL}"
  if ! limactl start --tty=false --name="$LIMA_INSTANCE" "$config"; then
    rm -f "$config"
    return 1
  fi
  rm -f "$config"
}

install_star_in_guest() {
  local installer_url release_base_url access_url release_url_env release_url_value
  installer_url="$(shell_quote "$INSTALLER_URL")"
  release_base_url="$(shell_quote "$RELEASE_BASE_URL")"
  access_url="$(shell_quote "$ACCESS_URL")"
  release_url_env=""
  if [ -n "${COCALC_STAR_RELEASE_URL:-}" ]; then
    release_url_value="$(shell_quote "$COCALC_STAR_RELEASE_URL")"
    release_url_env="COCALC_STAR_RELEASE_URL=${release_url_value}"
  fi

  log "installing CoCalc Star inside Lima instance ${LIMA_INSTANCE}"
  limactl shell "$LIMA_INSTANCE" bash -s <<EOF
set -euo pipefail
if command -v cloud-init >/dev/null 2>&1; then
  sudo cloud-init status --wait >/dev/null 2>&1 || true
fi
if ! command -v curl >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
fi
curl -fsSL ${installer_url} | sudo env \\
  STAR_ASSUME_YES=1 \\
  STAR_PUBLIC_URL_AUTO=0 \\
  STAR_WEB_ONBOARDING=0 \\
  STAR_WEB_ONBOARDING_REQUIRE_OPEN=0 \\
  STAR_ACCESS_URL=${access_url} \\
  COCALC_STAR_RELEASE_BASE_URL=${release_base_url} \\
  ${release_url_env} \\
  bash
EOF
}

print_done() {
  cat <<EOF

CoCalc Star local VM is installed.

Open:
  ${ACCESS_URL}

Useful commands:
  limactl shell ${LIMA_INSTANCE}
  limactl stop ${LIMA_INSTANCE}
  limactl start ${LIMA_INSTANCE}
  limactl shell ${LIMA_INSTANCE} sudo /opt/cocalc-star/source/src/scripts/star/star.sh access

EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v limactl >/dev/null 2>&1 || die "limactl is required. Install Lima first."
command -v curl >/dev/null 2>&1 || die "curl is required."

case "$LIMA_HOST_PORT" in
  '' | *[!0-9]*) die "invalid COCALC_STAR_LIMA_HOST_PORT=$LIMA_HOST_PORT" ;;
esac
case "$LIMA_GUEST_PORT" in
  '' | *[!0-9]*) die "invalid COCALC_STAR_LIMA_GUEST_PORT=$LIMA_GUEST_PORT" ;;
esac
if [ -z "$LIMA_MEMORY" ]; then
  LIMA_MEMORY="$(default_memory)"
fi

start_instance
install_star_in_guest
print_done
open_browser
