#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAR_API="${STAR_API:-http://127.0.0.1:9100}"
STAR_ROOT="${STAR_ROOT:-/var/lib/cocalc/star}"

usage() {
  cat <<'EOF'
Usage: star-poc.sh <command>

Commands:
  status                 Show service, API, project-host, and podman state.
  smoke                  Run the Star POC smoke test.
  restart [all|hub|host] Restart Star services. Default: all.
  logs [hub|host] [n]    Show recent service logs. Default: hub, 200 lines.
  bootstrap-link         Print the bootstrap registration link, if still present.

This is intentionally small and operator-oriented. It is for the current
CoCalc Star proof of concept VM, not a stable product CLI.
EOF
}

log() {
  printf '[star-poc] %s\n' "$*" >&2
}

service_name() {
  case "${1:-}" in
    hub) printf 'cocalc-star-hub' ;;
    host | project-host) printf 'cocalc-star-project-host' ;;
    *) return 1 ;;
  esac
}

show_service() {
  local svc="$1"
  printf '%-26s %s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null || true)"
}

status() {
  local customize_json
  customize_json="$(mktemp -t cocalc-star-customize.XXXXXX.json)"
  trap 'rm -f "$customize_json"' RETURN

  show_service cocalc-star-hub
  show_service cocalc-star-project-host

  printf '\nAPI customize:\n'
  if curl -fsS "${STAR_API}/customize" >"$customize_json"; then
    jq '.configuration | {
      site_name,
      is_launchpad,
      project_hosts_local_enabled,
      project_hosts_self_host_alpha_enabled,
      project_rootfs_default_image,
      project_rootfs_prepull_images,
      cloudflare_mode,
      launchpad_cloudflare_tunnel_status
    }' "$customize_json"
  else
    log "customize endpoint is not reachable at ${STAR_API}"
  fi

  printf '\nDatabase:\n'
  if [ -f /etc/cocalc/star/hub.env ]; then
    grep -E '^(COCALC_DB|COCALC_LOCAL_POSTGRES|COCALC_LOCAL_PG_SOCKET_DIR|COCALC_LOCAL_PG_ENV_FILE)=' /etc/cocalc/star/hub.env || true
  else
    log "missing /etc/cocalc/star/hub.env"
  fi

  printf '\nProject host files:\n'
  ls -ld "${STAR_ROOT}/project-host/0" "${STAR_ROOT}/project-host/0/secrets" 2>/dev/null || true
  if [ -d "${STAR_ROOT}/project-host/0/cache/images" ]; then
    printf 'cached rootfs images: %s\n' "$(
      find "${STAR_ROOT}/project-host/0/cache/images" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l
    )"
  fi

  printf '\nPodman images:\n'
  if command -v podman >/dev/null 2>&1; then
    printf 'XDG_RUNTIME_DIR=%s\n' "${XDG_RUNTIME_DIR:-}"
    ls -ld "/run/user/$(id -u)" 2>/dev/null || true
    podman images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}' 2>/dev/null || true
  else
    log "podman is not installed"
  fi
}

smoke() {
  exec "${SCRIPT_DIR}/smoke-star-poc.sh"
}

restart() {
  local target="${1:-all}"
  case "$target" in
    all)
      sudo systemctl restart cocalc-star-hub cocalc-star-project-host
      ;;
    hub | host | project-host)
      sudo systemctl restart "$(service_name "$target")"
      ;;
    *)
      log "unknown restart target: $target"
      usage
      exit 2
      ;;
  esac
}

logs() {
  local target="${1:-hub}"
  local lines="${2:-200}"
  local svc
  svc="$(service_name "$target")" || {
    log "unknown log target: $target"
    usage
    exit 2
  }
  sudo journalctl -u "$svc" -n "$lines" --no-pager
}

bootstrap_link() {
  local result="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}"
  [ -f "$result" ] || {
    log "missing bootstrap result: $result"
    exit 1
  }
  jq -r '.bootstrap_url // empty' "$result"
}

case "${1:-}" in
  status)
    status
    ;;
  smoke)
    smoke
    ;;
  restart)
    shift
    restart "$@"
    ;;
  logs)
    shift
    logs "$@"
    ;;
  bootstrap-link)
    bootstrap_link
    ;;
  -h | --help | help | '')
    usage
    ;;
  *)
    log "unknown command: $1"
    usage
    exit 2
    ;;
esac
