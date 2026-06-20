#!/usr/bin/env bash
set -euo pipefail

# Consumer Docker runs should fail on hard incompatibilities, but warnings such
# as a small data volume should not prevent first boot by default.
ALLOW_DEGRADED="${COCALC_STAR_DOCKER_ALLOW_DEGRADED:-1}"
STATUS_DIR="${COCALC_STAR_DOCKER_PREFLIGHT_DIR:-/run/cocalc-star-docker}"
failures=0
warnings=0

mkdir -p "$STATUS_DIR"

ok() {
  printf 'ok       %s\n' "$*"
}

warn() {
  warnings=$((warnings + 1))
  printf 'degraded %s\n' "$*" >&2
}

fail() {
  failures=$((failures + 1))
  printf 'failed   %s\n' "$*" >&2
}

has_word() {
  local word="$1"
  shift
  printf ' %s ' "$*" | grep -q " ${word} "
}

check_systemd_pid1() {
  local comm
  comm="$(tr -d '\0' </proc/1/comm 2>/dev/null || true)"
  if [ "$comm" = "systemd" ]; then
    ok "systemd is PID 1"
  else
    fail "systemd must be PID 1; got '${comm:-unknown}'"
  fi
}

check_cgroup_v2() {
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    ok "cgroup v2 is mounted"
  else
    fail "cgroup v2 is required; run with --cgroupns=host and mount /sys/fs/cgroup"
    return
  fi

  local controllers
  controllers="$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || true)"
  for controller in cpu memory pids; do
    if has_word "$controller" "$controllers"; then
      ok "cgroup controller '${controller}' is available"
    else
      fail "missing cgroup controller '${controller}'"
    fi
  done

  local test_dir="/sys/fs/cgroup/cocalc-star-preflight.$$"
  if mkdir "$test_dir" 2>/dev/null; then
    rmdir "$test_dir" 2>/dev/null || true
    ok "cgroup filesystem is writable"
  else
    fail "cgroup filesystem is not writable; run with -v /sys/fs/cgroup:/sys/fs/cgroup:rw"
  fi
}

check_devices() {
  [ -e /dev/fuse ] && ok "/dev/fuse is available" || warn "/dev/fuse is unavailable; fuse-overlayfs may fail"
  [ -e /dev/loop-control ] && ok "/dev/loop-control is available" || fail "/dev/loop-control is required for the btrfs data image"
}

check_storage() {
  mkdir -p /var/lib/cocalc
  if touch /var/lib/cocalc/.cocalc-star-write-test 2>/dev/null; then
    rm -f /var/lib/cocalc/.cocalc-star-write-test
    ok "/var/lib/cocalc is writable"
  else
    fail "/var/lib/cocalc must be writable"
  fi

  local available_kb
  available_kb="$(df -Pk /var/lib/cocalc | awk 'NR == 2 { print $4 }')"
  if [ -n "$available_kb" ] && [ "$available_kb" -ge $((20 * 1024 * 1024)) ]; then
    ok "/var/lib/cocalc has at least 20GiB available"
  else
    warn "/var/lib/cocalc has less than 20GiB available; rootfs builds may fail"
  fi
}

check_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    fail "podman is not installed in the image"
    return
  fi
  if podman info >/dev/null 2>&1; then
    ok "podman info succeeds"
  else
    fail "podman cannot run in this container; use --privileged and seccomp=unconfined"
  fi
}

check_memory() {
  local mem_kb
  mem_kb="$(awk '/MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || true)"
  if [ -n "$mem_kb" ] && [ "$mem_kb" -ge $((8 * 1024 * 1024)) ]; then
    ok "host reports at least 8GiB memory"
  else
    warn "host reports less than 8GiB memory; project startup may be slow or fail"
  fi
}

write_status() {
  local status="ok"
  if [ "$failures" -gt 0 ]; then
    status="failed"
  elif [ "$warnings" -gt 0 ]; then
    status="degraded"
  fi
  cat >"${STATUS_DIR}/preflight.json" <<EOF
{
  "status": "${status}",
  "failures": ${failures},
  "warnings": ${warnings},
  "checked_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

main() {
  check_systemd_pid1
  check_cgroup_v2
  check_devices
  check_storage
  check_memory
  check_podman
  write_status

  if [ "$failures" -gt 0 ]; then
    printf 'preflight: failed (%s failure(s), %s warning(s))\n' "$failures" "$warnings" >&2
    exit 1
  fi
  if [ "$warnings" -gt 0 ] && [ "$ALLOW_DEGRADED" != "1" ]; then
    printf 'preflight: degraded; set COCALC_STAR_DOCKER_ALLOW_DEGRADED=1 to continue\n' >&2
    exit 2
  fi
  printf 'preflight: ok\n'
}

main "$@"
