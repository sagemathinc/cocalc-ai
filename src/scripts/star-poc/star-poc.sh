#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAR_API="${STAR_API:-http://127.0.0.1:9100}"
STAR_ROOT="${STAR_ROOT:-/var/lib/cocalc/star}"
STAR_USER="${STAR_USER:-user}"
STAR_HOME="${STAR_HOME:-/home/${STAR_USER}}"
STAR_DEFAULT_ROOTFS_IMAGE="${STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
STAR_INSTALL_ROOT="${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
STAR_RELEASES_DIR="${STAR_RELEASES_DIR:-${STAR_INSTALL_ROOT}/releases}"
STAR_SOURCE_LINK="${STAR_SOURCE_LINK:-${STAR_INSTALL_ROOT}/source}"
if [ -z "${SRC_ROOT:-}" ]; then
  if [ -d "${STAR_SOURCE_LINK}/src" ]; then
    SRC_ROOT="${STAR_SOURCE_LINK}/src"
  else
    SRC_ROOT="${STAR_HOME}/cocalc-ai/src"
  fi
fi

usage() {
  cat <<'EOF'
Usage: star.sh <command>

Commands:
  status                 Show service, API, project-host, and podman state.
  doctor                 Check Star runtime invariants.
  smoke                  Run the Star smoke test.
  current-release        Print the active release, if installed from a release.
  releases               List installed releases.
  rollback [release-id]  Roll back to a release. Defaults to previous release.
  restart [all|hub|host] Restart Star services. Default: all.
  logs [hub|host] [n]    Show recent service logs. Default: hub, 200 lines.
  bootstrap-link         Print the bootstrap registration link, if still present.

This is intentionally small and operator-oriented. It manages a CoCalc Star
single-VM install.
EOF
}

log() {
  printf '[star] %s\n' "$*" >&2
}

replace_symlink() {
  local target="$1"
  local link="$2"
  rm -f "$link"
  ln -s "$target" "$link"
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

doctor() {
  local failures=0
  local star_uid

  star_uid="$(id -u "$STAR_USER" 2>/dev/null || true)"

  ok() {
    printf 'ok     %s\n' "$*"
  }

  fail() {
    printf 'FAIL   %s\n' "$*" >&2
    failures=$((failures + 1))
  }

  check() {
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
      ok "$desc"
    else
      fail "$desc"
    fi
  }

  as_star_user() {
    if [ "$(id -u)" = "$star_uid" ]; then
      env XDG_RUNTIME_DIR="/run/user/${star_uid}" "$@"
    else
      sudo -Hiu "$STAR_USER" env XDG_RUNTIME_DIR="/run/user/${star_uid}" "$@"
    fi
  }

  check "hub service is active" systemctl is-active --quiet cocalc-star-hub
  check "project-host service is active" systemctl is-active --quiet cocalc-star-project-host
  check "hub systemd unit is installed" grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-hub.service
  check "project-host systemd unit is installed" grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-project-host.service
  check "customize endpoint is reachable" curl -fsS "${STAR_API}/customize"
  [ -n "$star_uid" ] && ok "Star runtime user exists" || fail "Star runtime user exists"

  if [ -f /etc/cocalc/star/hub.env ]; then
    ok "hub env exists"
    # shellcheck disable=SC1091
    set -a
    source /etc/cocalc/star/hub.env
    set +a
    [ "${COCALC_DB:-}" = "postgres" ] && ok "hub uses local postgres" || fail "hub uses local postgres"
    check "postgres answers queries" psql -tAc "select 1"
  else
    fail "hub env exists"
  fi

  if [ -f /etc/cocalc/project-host.env ]; then
    ok "project-host env exists"
    # shellcheck disable=SC1091
    set -a
    source /etc/cocalc/project-host.env
    set +a
    if grep -q '^COCALC_PODMAN_RUNTIME_DIR=' /etc/cocalc/project-host.env; then
      fail "project-host does not force COCALC_PODMAN_RUNTIME_DIR"
    else
      ok "project-host does not force COCALC_PODMAN_RUNTIME_DIR"
    fi
    check "project-host tools bundle exists" test -d "${COCALC_PROJECT_TOOLS:-}"
    check "project-host tools bundle has dropbear" test -x "${COCALC_PROJECT_TOOLS:-}/dropbear"
    local conat_health_host="${COCALC_PROJECT_HOST_CONAT_ROUTER_HOST:-127.0.0.1}"
    if [ "$conat_health_host" = "0.0.0.0" ] || [ "$conat_health_host" = "::" ]; then
      conat_health_host="127.0.0.1"
    fi
    check "project-host conat router is healthy" \
      curl -fsS "http://${conat_health_host}:${COCALC_PROJECT_HOST_CONAT_ROUTER_PORT:-}/healthz"
    check "project-host conat persist is healthy" \
      curl -fsS "http://${COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST:-127.0.0.1}:${COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT:-}/healthz"
  else
    fail "project-host env exists"
  fi

  check "user linger is enabled" bash -lc "loginctl show-user '$STAR_USER' -p Linger | grep -qx 'Linger=yes'"
  check "user systemd manager is active" systemctl is-active --quiet "user@${star_uid}.service"
  check "standard podman runtime dir exists" test -d "/run/user/${star_uid}"
  check "btrfs data mount is active" mountpoint -q /mnt/cocalc
  check "shared scratch mount is active" mountpoint -q /mnt/cocalc-scratch
  check "runtime storage wrapper is installed" test -x /usr/local/sbin/cocalc-runtime-storage
  check "project-host rootctl wrapper is installed" test -x /usr/local/sbin/cocalc-project-host-rootctl
  check "project bundle exists" test -d "${SRC_ROOT}/packages/project/build"

  local rootfs_cache_dir="${STAR_ROOT}/project-host/0/cache/images"
  local rootfs_path
  rootfs_path="$(find "$rootfs_cache_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -1 || true)"
  if [ -n "$rootfs_path" ]; then
    ok "cached rootfs exists"
    check "cached rootfs has /home/user" test -d "${rootfs_path}/home/user"
    check "cached rootfs has /scratch" test -d "${rootfs_path}/scratch"
    check "cached rootfs has project secrets mountpoint" test -d "${rootfs_path}/run/secrets/cocalc"
    check "rootless podman can run cached rootfs" as_star_user podman run --rm --runtime /usr/bin/crun --userns=keep-id:uid=2001,gid=2001 --user 0:0 --rootfs "$rootfs_path" /bin/true
    check "cached rootfs preserves root-owned sudo files" as_star_user podman run --rm --runtime /usr/bin/crun --userns=keep-id:uid=2001,gid=2001 --user 0:0 --rootfs "$rootfs_path" /bin/bash -lc 'test "$(stat -c %u /etc/sudo.conf)" = 0 && test "$(stat -c %u /etc/sudoers)" = 0 && test "$(stat -c %u /etc/sudoers.d)" = 0 && test "$(stat -c %u /usr/bin/sudo)" = 0 && test -u /usr/bin/sudo'
  else
    local image_name="$STAR_DEFAULT_ROOTFS_IMAGE"
    case "$image_name" in
      containers-storage:*) image_name="${image_name#containers-storage:}" ;;
    esac
    if as_star_user podman image exists "$image_name" >/dev/null 2>&1; then
      ok "default rootfs image exists before cache extraction"
      check "rootless podman can run default rootfs image" as_star_user podman run --rm --runtime /usr/bin/crun --userns=keep-id:uid=2001,gid=2001 --user 0:0 "$image_name" /bin/true
    else
      fail "cached rootfs or default rootfs image exists"
    fi
  fi

  if [ "$failures" -eq 0 ]; then
    printf 'doctor: ok\n'
  else
    printf 'doctor: %s failure(s)\n' "$failures" >&2
    return 1
  fi
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
  sudo install -d -o "$STAR_USER" -g "$STAR_USER" -m 700 "${STAR_ROOT}/smoke"
  exec sudo -Hiu "$STAR_USER" env \
    STAR_API="$STAR_API" \
    STAR_ROOT="$STAR_ROOT" \
    SRC_ROOT="$SRC_ROOT" \
    STAR_SMOKE_STATE="${STAR_SMOKE_STATE:-${STAR_ROOT}/smoke}" \
    STAR_BOOTSTRAP_RESULT="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}" \
    STAR_SMOKE_ROOTFS_IMAGE="${STAR_SMOKE_ROOTFS_IMAGE:-$STAR_DEFAULT_ROOTFS_IMAGE}" \
    STAR_SMOKE_REUSE_PROJECT="${STAR_SMOKE_REUSE_PROJECT:-0}" \
    "${SCRIPT_DIR}/smoke-star-poc.sh"
}

current_release() {
  local current source release
  current="$(readlink -f "${STAR_INSTALL_ROOT}/current" 2>/dev/null || true)"
  source="$(readlink -f "$STAR_SOURCE_LINK" 2>/dev/null || true)"
  if [ -n "$current" ] && [ "$current/source" = "$source" ]; then
    basename "$current"
    return
  fi
  case "$source" in
    "${STAR_RELEASES_DIR}"/*/source)
      release="${source%/source}"
      basename "$release"
      ;;
  esac
}

list_releases() {
  local active release metadata installed_at sha
  active="$(current_release || true)"
  if [ ! -d "$STAR_RELEASES_DIR" ]; then
    return
  fi
  for release in "$STAR_RELEASES_DIR"/*; do
    [ -d "$release/source" ] || continue
    metadata="$release/release.json"
    installed_at=""
    sha=""
    if [ -f "$metadata" ]; then
      installed_at="$(jq -r '.installed_at // ""' "$metadata" 2>/dev/null || true)"
      sha="$(jq -r '.tarball_sha256 // ""' "$metadata" 2>/dev/null || true)"
      sha="${sha:0:12}"
    fi
    if [ "$(basename "$release")" = "$active" ]; then
      printf '* %s %s %s\n' "$(basename "$release")" "$installed_at" "$sha"
    else
      printf '  %s %s %s\n' "$(basename "$release")" "$installed_at" "$sha"
    fi
  done | sort
}

previous_release() {
  local active
  active="$(current_release || true)"
  list_releases | awk -v active="$active" '
    {
      name = $1 == "*" ? $2 : $1
      if (name != active) last = name
    }
    END {
      if (last != "") print last
    }
  '
}

rollback_release() {
  local release_id="${1:-}" release_dir
  if [ -z "$release_id" ]; then
    release_id="$(previous_release || true)"
  fi
  [ -n "$release_id" ] || {
    log "No previous release found."
    exit 1
  }
  case "$release_id" in
    "" | *[!A-Za-z0-9._-]*)
      log "Invalid release id: $release_id"
      exit 2
      ;;
  esac
  release_dir="${STAR_RELEASES_DIR}/${release_id}"
  [ -d "$release_dir/source/src" ] || {
    log "Release does not exist or is incomplete: $release_id"
    exit 1
  }
  replace_symlink "$release_dir/source" "$STAR_SOURCE_LINK"
  replace_symlink "$release_dir" "${STAR_INSTALL_ROOT}/current"
  sudo systemctl restart cocalc-star-hub cocalc-star-project-host
  printf 'rolled back to %s\n' "$release_id"
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
  doctor)
    doctor
    ;;
  smoke)
    smoke
    ;;
  current-release)
    current_release
    ;;
  releases)
    list_releases
    ;;
  rollback)
    shift
    rollback_release "$@"
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
