#!/usr/bin/env bash
# bay-restore against a fake systemctl and a fake engine: the bay is stopped
# (and its processes gone) before the restore engine runs, restarted on its
# old data when the restore fails or with --no-cutover, and cutover stops and
# starts units in the right order, also when the bay does not come up healthy
# or the full backup cannot be started. On a fresh VM the enabled frontdoor
# and tunnel start only with restored data: not after a failed restore or with
# --no-cutover. Needs root (passwordless sudo),
# because bay-restore refuses to run otherwise. Run: bash bay-restore-cutover.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(id -u)" != 0 ]] && ! sudo -n true 2>/dev/null; then
  echo "note: needs root or passwordless sudo; skipped" >&2
  exit 0
fi
TMP_ROOT="$(mktemp -d)"
# bay-restore refuses to run as root unless it, lib.sh and the engine are
# root-owned, as installed in /usr/local/libexec/cocalc-bay; and its work
# directories must be root-owned, in a directory the bay account cannot change.
TRUSTED="$(sudo -n mktemp -d)"
FAKE_ENGINE_DIR="$(sudo -n mktemp -d)"
WORKS="$(sudo -n mktemp -d)"
# Containers may have a / that is not root's; stop the ownership walk there.
ASSUME_TRUSTED_DIR=""
[[ "$(stat -c %u /)" == 0 ]] || ASSUME_TRUSTED_DIR=/
trap 'sudo -n rm -rf "$TMP_ROOT" "$TRUSTED" "$FAKE_ENGINE_DIR" "$WORKS" 2>/dev/null || rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

LOG="${TMP_ROOT}/systemctl.log"
mkdir -p "${TMP_ROOT}/bin" "${TMP_ROOT}/current/bin" "${TMP_ROOT}/fake"
sudo -n install -m 0755 "${SCRIPT_DIR}/bay-restore" "${SCRIPT_DIR}/bay-restore-engine.py" "${TRUSTED}/"
sudo -n install -m 0644 "${SCRIPT_DIR}/../bin/lib.sh" "${TRUSTED}/"
cp "${SCRIPT_DIR}/bay-restore" "${SCRIPT_DIR}/../bin/lib.sh" "${TMP_ROOT}/bin/"
# The engine stand-in records when it ran and leaves a restore that passed
# (or, with fail-engine, one that failed).
sudo -n install -m 0755 "${SCRIPT_DIR}/bay-restore" "${FAKE_ENGINE_DIR}/"
sudo -n install -m 0644 "${SCRIPT_DIR}/../bin/lib.sh" "${FAKE_ENGINE_DIR}/"
sudo -n tee "${FAKE_ENGINE_DIR}/bay-restore-engine.py" > /dev/null <<EOF
import json, os, sys
config = json.load(open(sys.argv[2]))
work = config["work_dir"]
open("${LOG}", "a").write("engine\n")
os.makedirs(os.path.join(work, "postgres"))
os.makedirs(os.path.join(work, "sync"))
open(os.path.join(work, "postgres", "marker"), "w").write("restored\n")
failed = os.path.exists("${TMP_ROOT}/fail-engine")
json.dump({"status": "failed" if failed else "passed", "stage": "restore-pgbackrest",
           "error": "fake failure", "postgres": {"cluster_state": "shut down"}},
          open(config["result_path"], "w"))
EOF
sudo -n chmod 0755 "$TRUSTED" "$FAKE_ENGINE_DIR"
sudo -n chmod 0711 "$WORKS"
# bay-health (bay code, run as the bay user) passes once "healthy" exists.
cat > "${TMP_ROOT}/current/bin/bay-health" <<EOF
#!/usr/bin/env bash
[[ -e "${TMP_ROOT}/healthy" ]]
EOF
cat > "${TMP_ROOT}/fake/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
# The bay account has processes while "bay-procs" exists (pkill ends them)
# and while any of its services in units/ runs: systemd would restart those,
# so pkill does not end them; only stopping the unit does.
UNITS="${TMP_ROOT}/units"
cat > "${TMP_ROOT}/fake/pgrep" <<EOF
#!/usr/bin/env bash
echo "pgrep \$*" >> "${LOG}"
[[ -e "${TMP_ROOT}/bay-procs" ]] || [[ -n "\$(ls -A "${UNITS}")" ]]
EOF
cat > "${TMP_ROOT}/fake/pkill" <<EOF
#!/usr/bin/env bash
echo "pkill \$*" >> "${LOG}"
rm -f "${TMP_ROOT}/bay-procs"
EOF
cat > "${TMP_ROOT}/fake/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${LOG}"
case "\$1" in
  list-units)
    if [[ "\${@: -1}" == "cocalc-bay*" ]]; then
      # Bay services running outside cocalc-bay.target.
      for unit in \$(ls "${UNITS}"); do echo "\$unit loaded active running \$unit"; done
    elif [[ "\$*" == *--type=timer* ]]; then
      echo "cocalc-bay-sqlite-backup.timer loaded active waiting SQLite backup"
      echo "cocalc-bay-pgbackrest-diff.timer loaded active waiting diff"
    else
      echo "cocalc-bay-sqlite-backup.service loaded activating start SQLite backup"
      echo "cocalc-bay-pgbackrest-status.service loaded inactive dead status"
    fi
    ;;
  is-enabled)
    grep -qx -- "\${@: -1}" "${TMP_ROOT}/enabled-units" 2>/dev/null
    exit
    ;;
  # Only the target is ever active once stopped (or never started).
  is-active)
    [[ "\${@: -1}" == cocalc-bay.target && -e "${TMP_ROOT}/target-active" ]]
    exit
    ;;
  stop)
    shift
    for unit in "\$@"; do
      rm -f "${UNITS}/\$unit"
      [[ "\$unit" != cocalc-bay.target ]] || rm -f "${TMP_ROOT}/target-active"
    done
    ;;
  start)
    if [[ "\$*" == *pgbackrest-backup@full* && -e "${TMP_ROOT}/fail-full" ]]; then
      echo "Unit cocalc-bay-pgbackrest-backup@full.service not found." >&2
      exit 5
    fi
    shift
    for unit in "\$@"; do
      case "\$unit" in
        cocalc-bay-frontdoor.service|cocalc-bay-cloudflared.service) touch "${UNITS}/\$unit" ;;
        cocalc-bay.target) touch "${TMP_ROOT}/target-active" ;;
      esac
    done
    ;;
esac
exit 0
EOF
chmod 0755 "${TMP_ROOT}/bin/"* "${TMP_ROOT}/current/bin/"* "${TMP_ROOT}/fake/"*

# Live data, and a finished restore in a root-owned work directory.
setup() {
  local work="$1"
  rm -rf "${TMP_ROOT}/bay"
  mkdir -p "${TMP_ROOT}/bay/postgres" "${TMP_ROOT}/bay/sync"
  echo live > "${TMP_ROOT}/bay/postgres/marker"
  : > "$LOG"
  rm -f "${TMP_ROOT}/fail-engine" "${TMP_ROOT}/fail-full" "${TMP_ROOT}/bay-procs"
  # The bay runs: its target, and the frontdoor and the tunnel outside it
  # (enabled, as installed). The fake systemctl runs as root and may own
  # target-active, so it is replaced rather than touched.
  rm -f "${TMP_ROOT}/target-active"
  touch "${TMP_ROOT}/target-active"
  printf '%s\n' cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service > "${TMP_ROOT}/enabled-units"
  rm -rf "$UNITS"
  mkdir -p "$UNITS"
  touch "${UNITS}/cocalc-bay-frontdoor.service" "${UNITS}/cocalc-bay-cloudflared.service"
  [[ -n "$work" ]] || return 0
  sudo -n rm -rf "$work"
  sudo -n mkdir -m 0711 "$work"
  sudo -n mkdir -p "${work}/postgres" "${work}/sync"
  echo restored | sudo -n tee "${work}/postgres/marker" > /dev/null
  printf '{"status": "passed", "postgres": {"cluster_state": "shut down"}}\n' |
    sudo -n tee "${work}/result.json" > /dev/null
}

bay_restore() {
  local script="$1"
  shift
  sudo -n env PATH="${TMP_ROOT}/fake:${PATH}" \
    COCALC_BAY_ENV_FILE=/nonexistent COCALC_BAY_WORKERS_ENV_FILE=/nonexistent \
    COCALC_BAY_OVERLAY_ENV_FILE=/nonexistent COCALC_BAY_TOPOLOGY_ENV_FILE=/nonexistent \
    COCALC_BAY_SECRETS_ENV_FILE=/nonexistent COCALC_BAY_LOCAL_ENV_FILE=/nonexistent \
    COCALC_BAY_NODE_BIN=/nonexistent COCALC_BAY_ID=bay-test COCALC_BAY_ROOT="${TMP_ROOT}/bay" \
    COCALC_BAY_POSTGRES_DATA_DIR="${TMP_ROOT}/bay/postgres" COCALC_BAY_SQLITE_SOURCE_DIR="${TMP_ROOT}/bay/sync" \
    COCALC_BAY_USER="$(id -un)" COCALC_BAY_GROUP="$(id -gn)" \
    COCALC_BAY_CURRENT_LINK="${TMP_ROOT}/current" \
    COCALC_BAY_RESTORE_ASSUME_TRUSTED_DIR="${ASSUME_TRUSTED_DIR}" \
    COCALC_BAY_PGBACKREST_S3_BUCKET=b COCALC_BAY_PGBACKREST_S3_ENDPOINT=https://r2.invalid \
    COCALC_BAY_PGBACKREST_S3_ACCESS_KEY=k COCALC_BAY_PGBACKREST_S3_SECRET_KEY=s \
    COCALC_BAY_PGBACKREST_CIPHER_PASS=c COCALC_BAY_SQLITE_RUSTIC_PASSWORD=p \
    bash "$script" "$@" > "${TMP_ROOT}/out" 2>&1
}

cutover() {
  bay_restore "${TRUSTED}/bay-restore" cutover --work-dir "$1" --yes
}

restore() {
  bay_restore "${FAKE_ENGINE_DIR}/bay-restore" restore --latest --yes "$@"
}

line() { { grep -n -F -- "$1" "$LOG" || true; } | head -1 | cut -d: -f1; }
count() { grep -c -F -x -- "$1" "$LOG" || true; }

# Root does not run a copy the bay account could have replaced.
work="${WORKS}/work0"
setup "$work"
bay_restore "${TMP_ROOT}/bin/bay-restore" cutover --work-dir "$work" --yes && fail "ran a copy not owned by root"
grep -q "refusing to run as root" "${TMP_ROOT}/out" || fail "no refusal message: $(cat "${TMP_ROOT}/out")"
[[ ! -s "$LOG" ]] || fail "a refused run touched systemd"

# Nor a work directory where the bay account could replace it.
mkdir -p "${TMP_ROOT}/bay-owned-work"
cutover "${TMP_ROOT}/bay-owned-work" && fail "cut over from a work directory the bay controls"
grep -q "not a work directory bay-restore made" "${TMP_ROOT}/out" || fail "no work-dir refusal: $(cat "${TMP_ROOT}/out")"
restore --work-dir "${TMP_ROOT}/bay-owned-work/r" && fail "restored into a directory the bay controls"
grep -q "root-owned directory the bay account cannot change" "${TMP_ROOT}/out" ||
  fail "no work-dir parent refusal: $(cat "${TMP_ROOT}/out")"
[[ ! -s "$LOG" ]] || fail "a refused restore touched systemd"

# Healthy: timers and running jobs stop before the bay, then any process the
# bay account has left; timers restart only after the bay is healthy; the
# full backup is queued.
work="${WORKS}/work1"
setup "$work"
touch "${TMP_ROOT}/healthy" "${TMP_ROOT}/bay-procs"
cutover "$work" || { cat "${TMP_ROOT}/out" >&2; fail "healthy cutover failed"; }
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == restored ]] || fail "data not swapped"
[[ "$(sudo -n cat "${work}/pre-restore/postgres/marker")" == live ]] || fail "live data not kept"
stop_timers="$(line 'stop cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer')"
stop_jobs="$(line 'stop cocalc-bay-sqlite-backup.service')"
stop_target="$(line 'stop cocalc-bay.target')"
kill_procs="$(line "pkill -KILL -u $(id -un)")"
start_target="$(line 'start cocalc-bay.target')"
start_timers="$(line 'start cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer')"
start_full="$(line 'start --no-block cocalc-bay-pgbackrest-backup@full.service')"
stop_services="$(line 'stop cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service')"
start_services="$(line 'start cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service')"
[[ -n "$stop_timers" && -n "$stop_jobs" && -n "$stop_target" && -n "$stop_services" && -n "$kill_procs" &&
   -n "$start_target" && -n "$start_services" && -n "$start_timers" && -n "$start_full" ]] ||
  fail "missing calls: $(cat "$LOG")"
(( stop_timers < stop_jobs && stop_jobs < stop_target && stop_target < stop_services && stop_services < kill_procs &&
   kill_procs < start_target && start_target < start_services && start_services < start_timers )) ||
  fail "wrong order: $(cat "$LOG")"
[[ -e "${UNITS}/cocalc-bay-frontdoor.service" && -e "${UNITS}/cocalc-bay-cloudflared.service" ]] ||
  fail "the frontdoor and tunnel were not restarted"
! grep -q 'stop cocalc-bay-pgbackrest-status.service' "$LOG" || fail "stopped an inactive job"

# Not healthy: timers stay stopped and are listed for the operator.
work="${WORKS}/work2"
setup "$work"
rm -f "${TMP_ROOT}/healthy"
cutover "$work" && fail "unhealthy cutover reported success"
grep -q 'left stopped' "${TMP_ROOT}/out" || fail "no stopped-timers message: $(cat "${TMP_ROOT}/out")"
grep -q 'start cocalc-bay-sqlite-backup.timer' "$LOG" && fail "restarted timers on an unhealthy bay"
sudo -n grep -qx 'cocalc-bay-pgbackrest-diff.timer' "${work}/stopped-timers" || fail "stopped timers not recorded"

# The full backup cannot be queued: exit status 2 and a warning.
work="${WORKS}/work3"
setup "$work"
touch "${TMP_ROOT}/healthy" "${TMP_ROOT}/fail-full"
set +e
cutover "$work"
code=$?
set -e
[[ "$code" == 2 ]] || fail "expected exit status 2, got $code: $(cat "${TMP_ROOT}/out")"
grep -q 'WARNING: could not start a full pgBackRest backup' "${TMP_ROOT}/out" || fail "no warning"
grep -q 'was started' "${TMP_ROOT}/out" && fail "claimed the full backup started"

# A restore stops the bay, and ends the bay account's processes, before the
# engine runs; a failed one restarts the bay on its unchanged data.
setup ""
touch "${TMP_ROOT}/healthy" "${TMP_ROOT}/fail-engine" "${TMP_ROOT}/bay-procs"
restore --work-dir "${WORKS}/r1" && fail "a failed restore reported success"
grep -q 'restore failed at stage restore-pgbackrest: fake failure' "${TMP_ROOT}/out" ||
  fail "no failure message: $(cat "${TMP_ROOT}/out")"
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == live ]] || fail "a failed restore changed the live data"
(( $(line 'stop cocalc-bay.target') < $(line "pkill -KILL -u $(id -un)") &&
   $(line "pkill -KILL -u $(id -un)") < $(line engine) &&
   $(line engine) < $(line 'start cocalc-bay.target') &&
   $(line engine) < $(line 'start cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer') &&
   $(line 'stop cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service') < $(line engine) &&
   $(line engine) < $(line 'start cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service') )) ||
  fail "failed restore: wrong order: $(cat "$LOG")"
# Before restarting the bay it checked for anything the restore left running.
last_check="$(grep -n -F "pgrep -u $(id -un)" "$LOG" | tail -1 | cut -d: -f1)"
(( last_check > $(line engine) && last_check < $(line 'start cocalc-bay.target') )) ||
  fail "restart_bay did not check for bay processes first: $(cat "$LOG")"

# --no-cutover: the bay runs on its old data again; cutover works later.
setup ""
restore --work-dir "${WORKS}/r2" --no-cutover || { cat "${TMP_ROOT}/out" >&2; fail "restore --no-cutover failed"; }
(( $(line engine) < $(line 'start cocalc-bay.target') )) || fail "--no-cutover did not restart the bay: $(cat "$LOG")"
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == live ]] || fail "--no-cutover changed the live data"
: > "$LOG"
cutover "${WORKS}/r2" || { cat "${TMP_ROOT}/out" >&2; fail "cutover after --no-cutover failed"; }
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == restored ]] || fail "later cutover did not swap"

# A full restore stops the bay once, before the engine, and starts it once,
# on the restored data.
setup ""
restore --work-dir "${WORKS}/r3" || { cat "${TMP_ROOT}/out" >&2; fail "restore failed"; }
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == restored ]] || fail "restore did not cut over"
[[ "$(count 'stop cocalc-bay.target')" == 1 && "$(count 'start cocalc-bay.target')" == 1 ]] ||
  fail "bay stopped or started more than once: $(cat "$LOG")"
(( $(line 'stop cocalc-bay.target') < $(line engine) && $(line engine) < $(line 'start cocalc-bay.target') )) ||
  fail "full restore: wrong order: $(cat "$LOG")"
(( $(line 'start cocalc-bay.target') < $(line 'start cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer') )) ||
  fail "timers restarted before the bay: $(cat "$LOG")"

# A fresh VM (mode B): nothing of the bay has run, but the frontdoor and the
# tunnel are enabled, with the production tunnel's credentials. Another
# enabled bay unit is not ingress, and is not started by a restore.
fresh_vm() {
  setup ""
  rm -f "${TMP_ROOT}/target-active"
  rm -rf "$UNITS"
  mkdir -p "$UNITS"
  printf '%s\n' cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service \
    cocalc-bay-sqlite-backup.service > "${TMP_ROOT}/enabled-units"
}
ingress_down() {
  [[ -z "$(ls -A "$UNITS")" ]] && ! grep -E -q '^start .*(frontdoor|cloudflared)' "$LOG"
}

# A failed restore leaves the fresh VM as it was: no bay and no ingress, so
# the tunnel's traffic does not reach an empty bay.
fresh_vm
touch "${TMP_ROOT}/fail-engine"
restore --work-dir "${WORKS}/r4" && fail "a failed fresh-VM restore reported success"
ingress_down || fail "a failed fresh-VM restore started the frontdoor or tunnel: $(cat "$LOG")"
! grep -q '^start cocalc-bay.target' "$LOG" || fail "a failed fresh-VM restore started the bay: $(cat "$LOG")"

# --no-cutover likewise; the cutover later starts the ingress with the bay.
fresh_vm
restore --work-dir "${WORKS}/r5" --no-cutover || { cat "${TMP_ROOT}/out" >&2; fail "fresh-VM --no-cutover failed"; }
ingress_down || fail "fresh-VM --no-cutover started the frontdoor or tunnel: $(cat "$LOG")"
: > "$LOG"
cutover "${WORKS}/r5" || { cat "${TMP_ROOT}/out" >&2; fail "fresh-VM cutover after --no-cutover failed"; }
[[ -e "${UNITS}/cocalc-bay-frontdoor.service" && -e "${UNITS}/cocalc-bay-cloudflared.service" ]] ||
  fail "the cutover did not start the frontdoor and tunnel: $(cat "$LOG")"

# A successful restore starts the enabled ingress, after the restore, and
# nothing else that is enabled.
fresh_vm
restore --work-dir "${WORKS}/r6" || { cat "${TMP_ROOT}/out" >&2; fail "fresh-VM restore failed"; }
[[ -e "${UNITS}/cocalc-bay-frontdoor.service" && -e "${UNITS}/cocalc-bay-cloudflared.service" ]] ||
  fail "the enabled frontdoor and tunnel were not started on a fresh VM: $(cat "$LOG")"
! grep -q '^start .*cocalc-bay-sqlite-backup.service' "$LOG" ||
  fail "started an enabled unit that is not ingress: $(cat "$LOG")"
(( $(line engine) < $(line 'start cocalc-bay-cloudflared.service cocalc-bay-frontdoor.service') )) ||
  fail "fresh VM: started the frontdoor and tunnel before the restore: $(cat "$LOG")"

# --target-time keeps its microseconds.
setup ""
bay_restore "${FAKE_ENGINE_DIR}/bay-restore" restore --yes --work-dir "${WORKS}/r7" \
  --target-time "2026-10-08 03:00:00.123456+00" ||
  { cat "${TMP_ROOT}/out" >&2; fail "restore --target-time failed"; }
grep -q 'to 2026-10-08 03:00:00.123456+00' "${TMP_ROOT}/out" ||
  fail "--target-time lost its fraction: $(cat "${TMP_ROOT}/out")"

echo "bay-restore tests passed"
