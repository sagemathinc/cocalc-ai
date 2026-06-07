#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/web-onboarding.sh"
STAR_CONFIG="${STAR_CONFIG:-/etc/cocalc/star/config.env}"
if [ -f "$STAR_CONFIG" ]; then
  # shellcheck disable=SC1090
  set -a
  source "$STAR_CONFIG"
  set +a
fi
STAR_API="${STAR_API:-http://127.0.0.1:9100}"
STAR_ROOT="${STAR_ROOT:-/var/lib/cocalc/star}"
STAR_USER="${STAR_USER:-cocalc-star}"
STAR_HOME="${STAR_HOME:-/home/${STAR_USER}}"
STAR_DEFAULT_ROOTFS_IMAGE="${STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
STAR_INSTALL_ROOT="${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
STAR_RELEASES_DIR="${STAR_RELEASES_DIR:-${STAR_INSTALL_ROOT}/releases}"
STAR_SOURCE_LINK="${STAR_SOURCE_LINK:-${STAR_INSTALL_ROOT}/source}"
STAR_PUBLIC_URL="${STAR_PUBLIC_URL:-}"
STAR_ACCESS_URL="${STAR_ACCESS_URL:-}"
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
  upgrade <url|tarball>  Install a new release artifact.
  rollback [release-id]  Roll back to a release. Defaults to previous release.
  restart [all|hub|rest|host]
                         Restart Star services. Default: all.
  logs [hub|host] [n]    Show recent service logs. Default: hub, 200 lines.
  access                 Print public/local access and bootstrap instructions.
  reconcile-runtime-state
                         Mark hub-side running project state stopped when the
                         corresponding project container is not running.
  bootstrap-link         Print the bootstrap registration link, if still present.
  https --domain <name>  Configure Caddy automatic HTTPS for a public domain.
  uninstall              Stop and remove Star service hooks; preserve data by default.

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
    rest | rest-server) printf 'cocalc-star-rest-server' ;;
    host | project-host) printf 'cocalc-star-project-host' ;;
    *) return 1 ;;
  esac
}

show_service() {
  local svc="$1"
  printf '%-26s %s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null || true)"
}

wait_for_url() {
  local desc="$1"
  local url="$2"
  local attempts="${3:-60}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  log "timed out waiting for ${desc}: ${url}"
  return 1
}

wait_for_runtime_health() {
  wait_for_url "hub customize endpoint" "${STAR_API}/customize"
  if [ -f /etc/cocalc/project-host.env ]; then
    # shellcheck disable=SC1091
    set -a
    source /etc/cocalc/project-host.env
    set +a
    local conat_health_host="${COCALC_PROJECT_HOST_CONAT_ROUTER_HOST:-127.0.0.1}"
    if [ "$conat_health_host" = "0.0.0.0" ] || [ "$conat_health_host" = "::" ]; then
      conat_health_host="127.0.0.1"
    fi
    wait_for_url "project-host conat router" "http://${conat_health_host}:${COCALC_PROJECT_HOST_CONAT_ROUTER_PORT:-}/healthz"
    wait_for_url "project-host conat persist" "http://${COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_HOST:-127.0.0.1}:${COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT:-}/healthz"
  fi
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
  check "REST server service is active" systemctl is-active --quiet cocalc-star-rest-server
  check "project-host service is active" systemctl is-active --quiet cocalc-star-project-host
  check "hub systemd unit is installed" grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-hub.service
  check "REST server systemd unit is installed" grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-rest-server.service
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
  check "project-host data directory is on btrfs" bash -lc \
    "test \"\$(findmnt -n -o FSTYPE --target '${COCALC_DATA:-${DATA:-/mnt/cocalc/data}}' 2>/dev/null)\" = btrfs"
  check "shared scratch mount is active" mountpoint -q /mnt/cocalc-scratch
  check "shared scratch shared directory exists" test -d /mnt/cocalc-scratch/shared
  check "shared scratch shared directory is writable" as_star_user bash -lc 'test -w /mnt/cocalc-scratch/shared'
  check "runtime storage wrapper is installed" test -x /usr/local/sbin/cocalc-runtime-storage
  check "project-host rootctl wrapper is installed" test -x /usr/local/sbin/cocalc-project-host-rootctl
  check "project bundle exists" test -d "${SRC_ROOT}/packages/project/build"

  local project_host_data="${COCALC_DATA:-${DATA:-/mnt/cocalc/data}}"
  local rootfs_cache_dir="${COCALC_IMAGE_CACHE:-${project_host_data}/cache/images}"
  local rootfs_path
  rootfs_path="$(find "$rootfs_cache_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -1 || true)"
  if [ -n "$rootfs_path" ]; then
    ok "cached rootfs exists"
    check "cached rootfs has /home/user" test -d "${rootfs_path}/home/user"
    check "cached rootfs has /scratch" test -d "${rootfs_path}/scratch"
    check "cached rootfs has project secrets mountpoint" test -d "${rootfs_path}/run/secrets/cocalc"
    check "rootless podman can run cached rootfs" as_star_user podman run --rm --runtime /usr/bin/crun --userns=keep-id:uid=2001,gid=2001 --user 0:0 --rootfs "$rootfs_path" /bin/true
    check "cached rootfs preserves root-owned sudo files" as_star_user podman run --rm --runtime /usr/bin/crun --userns=keep-id:uid=2001,gid=2001 --user 0:0 --rootfs "$rootfs_path" /bin/bash -lc 'test "$(stat -c %u /etc/sudo.conf)" = 0 && test "$(stat -c %u /etc/sudoers)" = 0 && test "$(stat -c %u /etc/sudoers.d)" = 0 && test -z "$(find /etc/sudoers.d -mindepth 1 -maxdepth 1 ! -uid 0 -print -quit)" && test "$(stat -Lc %u /usr/bin/sudo)" = 0 && test -u /usr/bin/sudo'
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
  show_service cocalc-star-rest-server
  show_service cocalc-star-project-host

  printf '\nAPI customize:\n'
  if curl -fsS "${STAR_API}/customize" >"$customize_json"; then
    if command -v jq >/dev/null 2>&1; then
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
      printf 'customize endpoint is reachable at %s/customize\n' "$STAR_API"
      log "jq is not installed; skipping formatted customize output"
    fi
  else
    log "customize endpoint is not reachable at ${STAR_API}"
  fi

  printf '\nAccess:\n'
  print_access_summary

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

  local bootstrap_result="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}"
  local bootstrap_url=""
  if [ -f "$bootstrap_result" ]; then
    bootstrap_url="$(json_string_field "$bootstrap_result" bootstrap_url || true)"
    if [ -n "$bootstrap_url" ]; then
      print_access_instructions "$bootstrap_url"
    fi
  fi
}

smoke() {
  local smoke_state
  smoke_state="${STAR_SMOKE_STATE:-${STAR_ROOT}/smoke}"
  if [ "$(id -un)" = "$STAR_USER" ]; then
    install -d -m 700 "$smoke_state"
    exec env \
      STAR_API="$STAR_API" \
      STAR_ROOT="$STAR_ROOT" \
      SRC_ROOT="$SRC_ROOT" \
      STAR_SMOKE_STATE="$smoke_state" \
      STAR_BOOTSTRAP_RESULT="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}" \
      STAR_SMOKE_ROOTFS_IMAGE="${STAR_SMOKE_ROOTFS_IMAGE:-$STAR_DEFAULT_ROOTFS_IMAGE}" \
      STAR_SMOKE_REUSE_PROJECT="${STAR_SMOKE_REUSE_PROJECT:-0}" \
      "${SCRIPT_DIR}/smoke-star-poc.sh"
  fi
  sudo install -d -o "$STAR_USER" -g "$STAR_USER" -m 700 "$smoke_state"
  exec sudo -Hiu "$STAR_USER" env \
    STAR_API="$STAR_API" \
    STAR_ROOT="$STAR_ROOT" \
    SRC_ROOT="$SRC_ROOT" \
    STAR_SMOKE_STATE="$smoke_state" \
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
  sudo systemctl restart cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host
  wait_for_runtime_health
  printf 'rolled back to %s\n' "$release_id"
}

upgrade_release() {
  local release="${1:-}"
  [ -n "$release" ] || {
    log "missing release URL or tarball"
    usage
    exit 2
  }
  local installer="${SRC_ROOT}/scripts/star/install-release.sh"
  [ -x "$installer" ] || {
    log "missing release installer: $installer"
    exit 1
  }
  sudo STAR_ASSUME_YES=1 \
    STAR_INSTALL_ROOT="$STAR_INSTALL_ROOT" \
    STAR_USER="$STAR_USER" \
    "$installer" "$release"
}

restart() {
  local target="${1:-all}"
  case "$target" in
    all)
      sudo systemctl restart cocalc-star-hub cocalc-star-rest-server cocalc-star-project-host
      ;;
    hub | rest | rest-server | host | project-host)
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

reconcile_runtime_state() {
  [ -f /etc/cocalc/star/hub.env ] || {
    log "missing /etc/cocalc/star/hub.env"
    exit 1
  }
  local star_uid live_file
  star_uid="$(id -u "$STAR_USER" 2>/dev/null || true)"
  [ -n "$star_uid" ] || {
    log "missing Star runtime user: $STAR_USER"
    exit 1
  }
  live_file="$(mktemp -t cocalc-star-live-projects.XXXXXX)"
  trap 'rm -f "$live_file"' RETURN
  sudo -Hiu "$STAR_USER" env XDG_RUNTIME_DIR="/run/user/${star_uid}" \
    podman ps --filter label=role=project --format '{{.Names}}' 2>/dev/null |
    sed -n 's/^project-\([0-9a-fA-F-]\{36\}\)$/\1/p' >"$live_file"

  # shellcheck disable=SC1091
  set -a
  source /etc/cocalc/star/hub.env
  set +a

  psql -v ON_ERROR_STOP=1 -v live_file="$live_file" <<'SQL'
CREATE TEMP TABLE star_live_project_containers(project_id uuid PRIMARY KEY);
\copy star_live_project_containers(project_id) FROM :'live_file'

CREATE TEMP TABLE star_stale_runtime_projects AS
  SELECT p.project_id
    FROM projects p
    LEFT JOIN star_live_project_containers live USING (project_id)
   WHERE COALESCE(p.state->>'state', '') IN ('running', 'starting')
     AND COALESCE(p.deleted, false) IS NOT TRUE
     AND live.project_id IS NULL;

WITH updated AS (
  UPDATE projects p
     SET state = jsonb_build_object(
           'state', 'opened',
           'time', now()::text,
           'error', 'CoCalc Star runtime reconciliation: project container was not running'
         )
    FROM star_stale_runtime_projects stale
   WHERE p.project_id = stale.project_id
   RETURNING p.project_id
)
SELECT 'projects_marked_opened' AS metric, count(*)::text AS value FROM updated;

WITH updated AS (
  UPDATE project_runtime_slots s
     SET state = 'expired',
         heartbeat_at = now(),
         expires_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object('expired_by', 'star-runtime-reconcile')
    FROM star_stale_runtime_projects stale
   WHERE s.project_id = stale.project_id
     AND s.state IN ('starting', 'running')
   RETURNING s.project_id
)
SELECT 'runtime_slots_expired' AS metric, count(*)::text AS value FROM updated;

DO $$
BEGIN
  IF to_regclass('public.project_active_operations') IS NOT NULL THEN
    DELETE FROM project_active_operations a
      USING star_stale_runtime_projects stale
      WHERE a.project_id = stale.project_id;
  END IF;
END $$;

SELECT 'live_project_containers' AS metric, count(*)::text AS value
  FROM star_live_project_containers;
SELECT 'stale_runtime_projects' AS metric, count(*)::text AS value
  FROM star_stale_runtime_projects;
SQL
}

local_bootstrap_url() {
  local url="$1"
  local local_port="${2:-9100}"
  case "$url" in
    *://*/*)
      printf 'http://127.0.0.1:%s/%s' "$local_port" "${url#*://*/}"
      ;;
    *://*)
      printf 'http://127.0.0.1:%s/' "$local_port"
      ;;
    *)
      printf 'http://127.0.0.1:%s/' "$local_port"
      ;;
  esac
}

url_with_base() {
  local url="$1"
  local base="$2"
  local path
  base="${base%/}"
  case "$url" in
    *://*/*)
      path="/${url#*://*/}"
      ;;
    *://*)
      path="/"
      ;;
    /*)
      path="$url"
      ;;
    *)
      path="/"
      ;;
  esac
  printf '%s%s' "$base" "$path"
}

json_string_field() {
  local file="$1"
  local field="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg field "$field" '.[$field] // empty' "$file"
    return
  fi
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -1
}

print_access_instructions() {
  local bootstrap_url="$1"
  local local_port="${2:-9100}"
  local ssh_target="${STAR_SSH_TARGET:-}"
  local access_url="${STAR_ACCESS_URL:-}"
  local localhost_url public_url=""

  [ -n "$bootstrap_url" ] || return 0
  localhost_url="$(local_bootstrap_url "$bootstrap_url" "$local_port")"
  if [ -n "${STAR_PUBLIC_URL:-}" ]; then
    public_url="$(url_with_base "$bootstrap_url" "$STAR_PUBLIC_URL")"
  fi

  if [ -n "$access_url" ]; then
    cat <<EOF

Open this URL to create the first admin account:
  $(url_with_base "$bootstrap_url" "$access_url")

EOF
    return 0
  fi

  cat <<EOF

CoCalc Star is running.
EOF

  if [ -n "$public_url" ]; then
    cat <<EOF

Open this HTTPS URL to create the first admin account:
  ${public_url}

EOF
  fi

  cat <<EOF

From your laptop, open an SSH tunnel to this VM:
EOF

  if [ -n "$ssh_target" ]; then
    cat <<EOF
  ssh -L ${local_port}:127.0.0.1:9100 ${ssh_target}
EOF
  else
    cat <<EOF
  ssh -L ${local_port}:127.0.0.1:9100 <ssh-user>@<vm-ip-or-hostname>
EOF
  fi

  cat <<EOF

Then open this local URL to create the first admin account:
  ${localhost_url}

If port ${local_port} is already in use on your laptop, choose another local port,
for example:
EOF

  if [ -n "$ssh_target" ]; then
    cat <<EOF
  ssh -L 9500:127.0.0.1:9100 ${ssh_target}
EOF
  else
    cat <<EOF
  ssh -L 9500:127.0.0.1:9100 <ssh-user>@<vm-ip-or-hostname>
EOF
  fi

  cat <<EOF
  $(local_bootstrap_url "$bootstrap_url" 9500)

You can reprint this later with:
  sudo /opt/cocalc-star/source/src/scripts/star/star.sh bootstrap-link
EOF
}

print_invite_instructions() {
  local invite_url="$1"
  local access_url="${STAR_ACCESS_URL:-}"
  local public_url=""

  [ -n "$invite_url" ] || return 0
  if [ -n "$access_url" ]; then
    public_url="$(url_with_base "$invite_url" "$access_url")"
  fi
  if [ -n "${STAR_PUBLIC_URL:-}" ]; then
    public_url="$(url_with_base "$invite_url" "$STAR_PUBLIC_URL")"
  fi

  cat <<EOF

Invite another user with this signup URL:
  ${public_url:-$invite_url}
EOF
}

print_access_summary() {
  local public="${STAR_PUBLIC_URL:-}"
  local access="${STAR_ACCESS_URL:-}"
  printf 'local control plane: %s\n' "$STAR_API"
  if [ -n "$access" ]; then
    printf 'browser access URL: %s\n' "$access"
  fi
  if [ -n "$public" ]; then
    printf 'public HTTPS URL:   %s\n' "$public"
  else
    printf 'public HTTPS URL:   not configured\n'
    if [ -z "$access" ]; then
      printf 'configure HTTPS:    sudo %s https --domain <dns-name> [--email <email>]\n' "$0"
    fi
  fi
  if systemctl is-active --quiet caddy 2>/dev/null; then
    printf 'caddy service:      active\n'
  else
    printf 'caddy service:      %s\n' "$(systemctl is-active caddy 2>/dev/null || true)"
  fi
}

bootstrap_link() {
  local result="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}"
  local url
  [ -f "$result" ] || {
    log "missing bootstrap result: $result"
    exit 1
  }
  url="$(json_string_field "$result" bootstrap_url)"
  [ -n "$url" ] || {
    log "bootstrap link is not present in $result"
    exit 1
  }
  print_access_instructions "$url"
}

access() {
  local result="${STAR_BOOTSTRAP_RESULT:-${STAR_ROOT}/bootstrap-result.json}"
  local url=""
  local invite_url=""
  print_access_summary
  if [ -f "$result" ]; then
    url="$(json_string_field "$result" bootstrap_url || true)"
    invite_url="$(json_string_field "$result" invite_url || true)"
  fi
  if [ -n "$url" ]; then
    print_access_instructions "$url"
  fi
  if [ -n "$invite_url" ]; then
    print_invite_instructions "$invite_url"
  fi
}

validate_https_domain() {
  local domain="$1"
  case "$domain" in
    "" | *://* | */* | *:* | *[!A-Za-z0-9.-]* | .* | *..* | *.)
      return 1
      ;;
  esac
  [[ "$domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$ ]]
}

validate_https_email() {
  local email="$1"
  [ -z "$email" ] || [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]]
}

write_star_caddyfile() {
  local domain="$1"
  local email="$2"
  local tmp="$3"
  {
    printf '# cocalc-star managed caddyfile v1\n'
    if [ -n "$email" ]; then
      cat <<EOF

{
  email ${email}
}
EOF
    fi
    cat <<EOF

${domain} {
$(star_web_onboarding_caddy_routes)
  handle {
    reverse_proxy 127.0.0.1:${STAR_API##*:}
  }
}
EOF
  } >"$tmp"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="$4"
  local owner="$5"
  local tmp
  tmp="$(mktemp)"
  if [ -f "$file" ]; then
    grep -v -E "^${key}=" "$file" >"$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  sudo install -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$tmp" "$file"
  rm -f "$tmp"
}

configure_https() {
  local domain="" email="" tmp public_url port
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)
        [ $# -ge 2 ] || {
          log "missing value for --domain"
          exit 2
        }
        domain="${2:-}"
        shift 2
        ;;
      --email)
        [ $# -ge 2 ] || {
          log "missing value for --email"
          exit 2
        }
        email="${2:-}"
        shift 2
        ;;
      -h | --help)
        cat <<'EOF'
Usage: star.sh https --domain <dns-name> [--email <email>]

Configure Caddy automatic HTTPS for CoCalc Star.

Prerequisites:
  - the DNS name resolves to this VM's public IP,
  - inbound TCP ports 80 and 443 are open to the VM,
  - no other service owns /etc/caddy/Caddyfile unless it is Star-managed.
EOF
        return 0
        ;;
      *)
        log "unknown https option: $1"
        exit 2
        ;;
    esac
  done
  if ! validate_https_domain "$domain"; then
    log "invalid domain: ${domain:-<missing>}; pass a DNS name such as star.example.com"
    exit 2
  fi
  if ! validate_https_email "$email"; then
    log "invalid email: $email"
    exit 2
  fi
  if [ "$(id -u)" -ne 0 ]; then
    log "run as root, e.g. sudo $0 https --domain $domain"
    exit 1
  fi
  if [ -f /etc/caddy/Caddyfile ] && ! is_generated_star_caddyfile /etc/caddy/Caddyfile; then
    log "refusing to replace non-Star Caddyfile at /etc/caddy/Caddyfile"
    exit 1
  fi
  port="${STAR_API##*:}"
  case "$port" in
    '' | *[!0-9]*)
      log "cannot infer local Star port from STAR_API=$STAR_API"
      exit 1
      ;;
  esac
  tmp="$(mktemp)"
  write_star_caddyfile "$domain" "$email" "$tmp"
  if command -v caddy >/dev/null 2>&1; then
    caddy fmt --overwrite "$tmp" >/dev/null || true
    caddy adapt --config "$tmp" >/dev/null
  fi
  sudo install -m 0644 -o root -g root "$tmp" /etc/caddy/Caddyfile
  rm -f "$tmp"

  public_url="https://${domain}"
  sudo install -d -m 0755 -o root -g root /etc/cocalc/star
  set_env_value /etc/cocalc/star/config.env STAR_PUBLIC_URL "$public_url" 0644 root:root
  if [ -f /etc/cocalc/star/hub.env ]; then
    set_env_value /etc/cocalc/star/hub.env COCALC_SETTING_DNS "$public_url" 0600 "$STAR_USER:$STAR_USER"
  fi

  sudo systemctl enable caddy >/dev/null
  sudo systemctl reload caddy >/dev/null 2>&1 || sudo systemctl restart caddy
  sudo systemctl restart cocalc-star-hub

  STAR_PUBLIC_URL="$public_url"
  export STAR_PUBLIC_URL
  cat <<EOF
Configured CoCalc Star HTTPS.

Public URL:
  ${public_url}

Caddy will obtain and renew the certificate automatically once DNS resolves to
this VM and inbound TCP ports 80 and 443 are open.
EOF
  access
}

confirm_uninstall() {
  local prompt="$1"
  if [ "${STAR_ASSUME_YES:-0}" = "1" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    log "refusing non-interactive uninstall without STAR_ASSUME_YES=1"
    exit 1
  fi
  printf '%s\n' "$prompt" >&2
  read -r -p "Type 'uninstall cocalc star' to continue: " answer
  if [ "$answer" != "uninstall cocalc star" ]; then
    log "confirmation did not match"
    exit 1
  fi
}

confirm_purge_data() {
  if [ "${STAR_ASSUME_YES:-0}" = "1" ] && [ "${STAR_PURGE_DATA_CONFIRM:-}" = "purge cocalc star data" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    log "refusing non-interactive data purge without STAR_PURGE_DATA_CONFIRM='purge cocalc star data'"
    exit 1
  fi
  cat >&2 <<EOF
WARNING: this removes CoCalc Star data from this VM.

It removes:
  ${STAR_ROOT}
  ${STAR_INSTALL_ROOT}
  ${STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}

This can delete users, projects, database state, RootFS caches, secrets, and
local backups. Create and copy an off-VM backup before continuing.
EOF
  read -r -p "Type 'purge cocalc star data' to permanently remove data: " answer
  if [ "$answer" != "purge cocalc star data" ]; then
    log "data purge confirmation did not match"
    exit 1
  fi
}

remove_fstab_marker_lines() {
  local tmp
  [ -f /etc/fstab ] || return 0
  if ! grep -q '# cocalc-star' /etc/fstab; then
    return 0
  fi
  tmp="$(mktemp)"
  grep -v '# cocalc-star' /etc/fstab >"$tmp"
  install -m 0644 -o root -g root "$tmp" /etc/fstab
  rm -f "$tmp"
}

backup_and_remove_file() {
  local path="$1"
  local backup_dir="$2"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  mkdir -p "${backup_dir}${path%/*}"
  cp -a "$path" "${backup_dir}${path}"
  rm -f "$path"
}

is_generated_star_caddyfile() {
  local path="${1:-/etc/caddy/Caddyfile}"
  [ -f "$path" ] || return 1
  if grep -q '^# cocalc-star managed caddyfile v1$' "$path"; then
    grep -q "^[[:space:]]*reverse_proxy[[:space:]]\\+127.0.0.1:${STAR_API##*:}[[:space:]]*$" "$path"
    return
  fi
  grep -q '^:80[[:space:]]*{' "$path" || return 1
  grep -q "^[[:space:]]*reverse_proxy[[:space:]]\\+127.0.0.1:${STAR_API##*:}[[:space:]]*$" "$path" || return 1
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    { n += 1 }
    END { exit n == 3 ? 0 : 1 }
  ' "$path"
}

stop_star_project_containers() {
  local star_uid
  star_uid="$(id -u "$STAR_USER" 2>/dev/null || true)"
  [ -n "$star_uid" ] || return 0
  command -v podman >/dev/null 2>&1 || return 0
  sudo -Hiu "$STAR_USER" env XDG_RUNTIME_DIR="/run/user/${star_uid}" bash -lc '
    ids="$(podman ps -aq --filter label=role=project 2>/dev/null || true)"
    [ -z "$ids" ] || podman rm -f $ids >/dev/null 2>&1 || true
  ' || true
}

uninstall_star() {
  local purge_data=0
  local purge_user=0
  local yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge-data)
        purge_data=1
        shift
        ;;
      --purge-user)
        purge_user=1
        shift
        ;;
      --yes)
        yes=1
        STAR_ASSUME_YES=1
        export STAR_ASSUME_YES
        shift
        ;;
      -h | --help)
        cat <<'EOF'
Usage: star.sh uninstall [--yes] [--purge-data] [--purge-user]

Default behavior is conservative:
  - stop and disable CoCalc Star services,
  - remove Star systemd units, sudoers entries, wrappers, and active env files,
  - preserve releases, database state, project data, RootFS caches, secrets, and mounts.

Options:
  --purge-data  also remove Star install/data trees and Star btrfs image.
  --purge-user  also remove the Star Linux user. This requires --purge-data.
  --yes         skip the basic uninstall prompt.

Non-interactive data purge requires:
  STAR_ASSUME_YES=1 STAR_PURGE_DATA_CONFIRM='purge cocalc star data'
EOF
        return 0
        ;;
      *)
        log "unknown uninstall option: $1"
        exit 2
        ;;
    esac
  done

  if [ "$(id -u)" -ne 0 ]; then
    log "run uninstall as root, e.g. sudo $0 uninstall"
    exit 1
  fi
  if [ "$purge_user" = "1" ] && [ "$purge_data" != "1" ]; then
    log "--purge-user requires --purge-data"
    exit 2
  fi

  if [ "$yes" != "1" ]; then
    confirm_uninstall "CoCalc Star will be stopped and service hooks removed. Data is preserved unless --purge-data is also specified."
  fi
  if [ "$purge_data" = "1" ]; then
    confirm_purge_data
  fi

  local timestamp backup_dir generated_caddy=0 star_uid
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ "$purge_data" = "1" ]; then
    backup_dir="/tmp/cocalc-star-uninstall-backups/${timestamp}"
  else
    backup_dir="${STAR_ROOT}/uninstall-backups/${timestamp}"
  fi

  log "stopping Star services"
  systemctl stop cocalc-star-project-host.service >/dev/null 2>&1 || true
  stop_star_project_containers
  systemctl stop cocalc-star-rest-server.service >/dev/null 2>&1 || true
  systemctl stop cocalc-star-hub.service >/dev/null 2>&1 || true

  log "disabling Star services"
  systemctl disable cocalc-star-project-host.service >/dev/null 2>&1 || true
  systemctl disable cocalc-star-rest-server.service >/dev/null 2>&1 || true
  systemctl disable cocalc-star-hub.service >/dev/null 2>&1 || true

  if is_generated_star_caddyfile /etc/caddy/Caddyfile; then
    generated_caddy=1
    systemctl disable --now caddy >/dev/null 2>&1 || true
  fi

  log "removing Star service/config hooks"
  install -d -m 0700 "$backup_dir"
  backup_and_remove_file /etc/systemd/system/cocalc-star-hub.service "$backup_dir"
  backup_and_remove_file /etc/systemd/system/cocalc-star-rest-server.service "$backup_dir"
  backup_and_remove_file /etc/systemd/system/cocalc-star-project-host.service "$backup_dir"
  backup_and_remove_file /etc/cocalc/star/hub.env "$backup_dir"
  backup_and_remove_file /etc/cocalc/star/config.env "$backup_dir"
  backup_and_remove_file /etc/cocalc/project-host.env "$backup_dir"
  backup_and_remove_file /etc/sudoers.d/cocalc-project-host-runtime "$backup_dir"
  backup_and_remove_file /etc/sudoers.d/cocalc-star-admin "$backup_dir"
  backup_and_remove_file /usr/local/sbin/cocalc-runtime-storage "$backup_dir"
  backup_and_remove_file /usr/local/sbin/cocalc-mount-data "$backup_dir"
  backup_and_remove_file /usr/local/sbin/cocalc-project-host-rootctl "$backup_dir"
  backup_and_remove_file /usr/local/sbin/cocalc-nvidia-cdi-normalize "$backup_dir"
  if [ "$generated_caddy" = "1" ]; then
    backup_and_remove_file /etc/caddy/Caddyfile "$backup_dir"
  fi
  systemctl daemon-reload

  if [ "$purge_data" = "1" ]; then
    log "purging Star data"
    star_uid="$(id -u "$STAR_USER" 2>/dev/null || true)"
    if [ -n "$star_uid" ]; then
      systemctl stop "user@${star_uid}.service" >/dev/null 2>&1 || true
    fi
    umount /mnt/cocalc-scratch >/dev/null 2>&1 || true
    umount /mnt/cocalc >/dev/null 2>&1 || true
    remove_fstab_marker_lines
    rm -rf "$STAR_ROOT" "$STAR_INSTALL_ROOT" /mnt/cocalc-scratch /mnt/cocalc/shared-scratch
    rm -f "${STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}"
    if [ "$purge_user" = "1" ] && getent passwd "$STAR_USER" >/dev/null; then
      userdel -r "$STAR_USER" >/dev/null 2>&1 || userdel "$STAR_USER" >/dev/null 2>&1 || true
    fi
  fi

  cat <<EOF
CoCalc Star uninstall complete.

Removed active service hooks. Backups of removed config files, if any, are in:
  ${backup_dir}
EOF

  if [ "$purge_data" != "1" ]; then
    cat <<EOF

Preserved Star data and releases:
  ${STAR_ROOT}
  ${STAR_INSTALL_ROOT}
  ${STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}
  /mnt/cocalc
  /mnt/cocalc-scratch

To remove data too, first create and copy an off-VM backup, then run:
  sudo ${STAR_SOURCE_LINK}/src/scripts/star/star.sh uninstall --purge-data
EOF
  fi
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
  upgrade)
    shift
    upgrade_release "$@"
    ;;
  restart)
    shift
    restart "$@"
    ;;
  logs)
    shift
    logs "$@"
    ;;
  access)
    access
    ;;
  reconcile-runtime-state)
    reconcile_runtime_state
    ;;
  bootstrap-link)
    bootstrap_link
    ;;
  https)
    shift
    configure_https "$@"
    ;;
  uninstall)
    shift
    uninstall_star "$@"
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
