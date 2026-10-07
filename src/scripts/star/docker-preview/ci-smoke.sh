#!/usr/bin/env bash
set -euo pipefail

# Boot a CoCalc Star image on a fresh volume exactly as users do, then check
# that it works: doctor, smoke (create/start a project, exec, Jupyter, LaTeX),
# the first-admin link surviving the smoke run, and a container restart.
#
# Usage: ci-smoke.sh <image> [--upgrade-from <older-image>]
#
# With --upgrade-from, the volume is first initialized by the older image and
# then taken over by <image>, which is how users upgrade.

IMAGE="${1:?usage: ci-smoke.sh <image> [--upgrade-from <older-image>]}"
shift
FROM_IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --upgrade-from)
      FROM_IMAGE="${2:?missing image for --upgrade-from}"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

DOCKER="${DOCKER:-docker}"
NAME="${COCALC_STAR_SMOKE_CONTAINER:-cocalc-star-ci-smoke}"
VOLUME="${NAME}-data"
PORT="${COCALC_STAR_SMOKE_PORT:-18170}"
READY_TIMEOUT="${COCALC_STAR_SMOKE_READY_TIMEOUT:-1200}"
STAR_SH=/opt/cocalc-star/source/src/scripts/star/star.sh

log() {
  printf '[star-ci-smoke] %s\n' "$*" >&2
}

dump_diagnostics() {
  log "--- init log ---"
  $DOCKER exec "$NAME" grep 'star-docker-init\]' /var/log/cocalc-star-docker-init.log 2>&1 | tail -20 || true
  log "--- container root propagation, AppArmor ---"
  $DOCKER exec "$NAME" findmnt -no PROPAGATION / 2>&1 || true
  $DOCKER exec "$NAME" grep cocalc-star-podman /sys/kernel/security/apparmor/profiles 2>&1 || true
  sysctl kernel.apparmor_restrict_unprivileged_userns 2>&1 || true
  sudo -n dmesg 2>/dev/null | grep -i 'apparmor="DENIED"' | tail -5 || true
  log "--- docker logs ---"
  $DOCKER logs --tail 300 "$NAME" 2>&1 || true
  log "--- failed units ---"
  $DOCKER exec "$NAME" systemctl --failed --no-pager 2>&1 || true
  for unit in cocalc-star-docker-init cocalc-star-hub cocalc-star-project-host; do
    log "--- journal: $unit ---"
    $DOCKER exec "$NAME" journalctl -u "$unit" -n 150 --no-pager 2>&1 || true
  done
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    dump_diagnostics
  fi
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER volume rm "$VOLUME" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

run_container() {
  local image="$1"
  $DOCKER rm -f "$NAME" >/dev/null 2>&1 || true
  $DOCKER run -d --name "$NAME" \
    --privileged --cgroupns=host \
    -v "${VOLUME}:/var/lib/cocalc" \
    -p "${PORT}:80" -e COCALC_STAR_HTTP_PORT="$PORT" \
    "$image" >/dev/null
}

# The init service reports ready once per boot; count the "is ready" lines in
# the persistent init log to detect this boot's completion.
ready_count() {
  local count
  count="$($DOCKER exec "$NAME" grep -c '\[star-docker-init\] CoCalc Star .* is ready' \
    /var/log/cocalc-star-docker-init.log 2>/dev/null || true)"
  printf '%s\n' "${count:-0}"
}

wait_ready() {
  local want="$1" started=$SECONDS state
  while [ $((SECONDS - started)) -lt "$READY_TIMEOUT" ]; do
    if [ "$(ready_count)" -ge "$want" ]; then
      log "ready after $((SECONDS - started))s"
      return 0
    fi
    state="$($DOCKER exec "$NAME" systemctl show -p Result --value cocalc-star-docker-init 2>/dev/null || true)"
    if [ -n "$state" ] && [ "$state" != "success" ]; then
      log "init service failed: $state"
      return 1
    fi
    sleep 10
  done
  log "timed out waiting for CoCalc Star"
  return 1
}

check() {
  log "smoke"
  $DOCKER exec "$NAME" "$STAR_SH" smoke
  # After smoke, so the RootFS cache is prepared and every doctor check runs.
  log "doctor"
  $DOCKER exec "$NAME" "$STAR_SH" doctor
  log "HTTP on the published port"
  curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/"
}

$DOCKER volume rm "$VOLUME" >/dev/null 2>&1 || true

if [ -n "$FROM_IMAGE" ]; then
  log "initializing the volume with $FROM_IMAGE"
  run_container "$FROM_IMAGE"
  wait_ready 1
  log "upgrading to $IMAGE"
  $DOCKER rm -f "$NAME" >/dev/null
  run_container "$IMAGE"
  wait_ready 1
  $DOCKER exec "$NAME" grep -q 'upgrading CoCalc Star from' \
    /var/log/cocalc-star-docker-init.log
  check
  log "upgrade from $FROM_IMAGE ok"
  exit 0
fi

log "first boot of $IMAGE on a fresh volume"
run_container "$IMAGE"
wait_ready 1
check

log "the first-admin link must survive the smoke run"
$DOCKER exec "$NAME" "$STAR_SH" bootstrap-link | grep -q 'registrationToken='

log "admin-link creates a new admin link"
$DOCKER exec "$NAME" "$STAR_SH" admin-link | grep -q 'registrationToken='

log "restart"
$DOCKER restart "$NAME" >/dev/null
wait_ready 2
check

log "ok"
