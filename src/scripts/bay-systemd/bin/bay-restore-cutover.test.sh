#!/usr/bin/env bash
# bay-restore cutover against a fake systemctl: the order in which it stops
# and starts units, and what it does when the bay does not come up healthy or
# the full backup cannot be started. Needs root (passwordless sudo), because
# bay-restore refuses to run otherwise. Run: bash bay-restore-cutover.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(id -u)" != 0 ]] && ! sudo -n true 2>/dev/null; then
  echo "note: needs root or passwordless sudo; skipped" >&2
  exit 0
fi
TMP_ROOT="$(mktemp -d)"
trap 'sudo -n rm -rf "$TMP_ROOT" 2>/dev/null || rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "${TMP_ROOT}/bin" "${TMP_ROOT}/fake"
cp "${SCRIPT_DIR}/bay-restore" "${SCRIPT_DIR}/lib.sh" "${TMP_ROOT}/bin/"
# bay-health passes once the "healthy" file exists.
cat > "${TMP_ROOT}/bin/bay-health" <<EOF
#!/usr/bin/env bash
[[ -e "${TMP_ROOT}/healthy" ]]
EOF
cat > "${TMP_ROOT}/fake/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "${TMP_ROOT}/fake/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${TMP_ROOT}/systemctl.log"
case "\$1" in
  list-units)
    if [[ "\$*" == *--type=timer* ]]; then
      echo "cocalc-bay-sqlite-backup.timer loaded active waiting SQLite backup"
      echo "cocalc-bay-pgbackrest-diff.timer loaded active waiting diff"
    else
      echo "cocalc-bay-sqlite-backup.service loaded activating start SQLite backup"
      echo "cocalc-bay-pgbackrest-status.service loaded inactive dead status"
    fi
    ;;
  is-active) exit 1 ;;
  start)
    if [[ "\$*" == *pgbackrest-backup@full* && -e "${TMP_ROOT}/fail-full" ]]; then
      echo "Unit cocalc-bay-pgbackrest-backup@full.service not found." >&2
      exit 5
    fi
    ;;
esac
exit 0
EOF
chmod 0755 "${TMP_ROOT}/bin/"* "${TMP_ROOT}/fake/"*

setup() {
  local work="$1"
  rm -rf "${TMP_ROOT}/bay" "$work"
  mkdir -p "${TMP_ROOT}/bay/postgres" "${TMP_ROOT}/bay/sync" "${work}/postgres" "${work}/sync"
  echo live > "${TMP_ROOT}/bay/postgres/marker"
  echo restored > "${work}/postgres/marker"
  printf '{"status": "passed", "postgres": {"cluster_state": "shut down"}}\n' > "${work}/result.json"
  : > "${TMP_ROOT}/systemctl.log"
}

cutover() {
  sudo -n env PATH="${TMP_ROOT}/fake:${PATH}" \
    COCALC_BAY_ENV_FILE=/nonexistent COCALC_BAY_WORKERS_ENV_FILE=/nonexistent \
    COCALC_BAY_OVERLAY_ENV_FILE=/nonexistent COCALC_BAY_TOPOLOGY_ENV_FILE=/nonexistent \
    COCALC_BAY_SECRETS_ENV_FILE=/nonexistent COCALC_BAY_LOCAL_ENV_FILE=/nonexistent \
    COCALC_BAY_NODE_BIN=/nonexistent COCALC_BAY_ID=bay-test COCALC_BAY_ROOT="${TMP_ROOT}/bay" \
    COCALC_BAY_POSTGRES_DATA_DIR="${TMP_ROOT}/bay/postgres" COCALC_BAY_SQLITE_SOURCE_DIR="${TMP_ROOT}/bay/sync" \
    COCALC_BAY_USER="$(id -un)" COCALC_BAY_GROUP="$(id -gn)" \
    bash "${TMP_ROOT}/bin/bay-restore" cutover --work-dir "$1" --yes > "${TMP_ROOT}/out" 2>&1
}

# Healthy: timers and running jobs stop before the bay; timers restart only
# after the bay is healthy; the full backup is queued.
work="${TMP_ROOT}/work1"
setup "$work"
touch "${TMP_ROOT}/healthy"
cutover "$work" || { cat "${TMP_ROOT}/out" >&2; fail "healthy cutover failed"; }
[[ "$(cat "${TMP_ROOT}/bay/postgres/marker")" == restored ]] || fail "data not swapped"
[[ "$(cat "${work}/pre-restore/postgres/marker")" == live ]] || fail "live data not kept"
grep -n '' "${TMP_ROOT}/systemctl.log" > "${TMP_ROOT}/order"
line() { { grep -F -- "$1" "${TMP_ROOT}/order" || true; } | head -1 | cut -d: -f1; }
stop_timers="$(line 'stop cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer')"
stop_jobs="$(line 'stop cocalc-bay-sqlite-backup.service')"
stop_target="$(line 'stop cocalc-bay.target')"
start_target="$(line 'start cocalc-bay.target')"
start_timers="$(line 'start cocalc-bay-sqlite-backup.timer cocalc-bay-pgbackrest-diff.timer')"
start_full="$(line 'start --no-block cocalc-bay-pgbackrest-backup@full.service')"
[[ -n "$stop_timers" && -n "$stop_jobs" && -n "$stop_target" && -n "$start_target" && -n "$start_timers" && -n "$start_full" ]] ||
  fail "missing systemctl calls: $(cat "${TMP_ROOT}/systemctl.log")"
(( stop_timers < stop_jobs && stop_jobs < stop_target && start_target < start_timers )) ||
  fail "wrong order: $(cat "${TMP_ROOT}/systemctl.log")"
! grep -q 'stop cocalc-bay-pgbackrest-status.service' "${TMP_ROOT}/systemctl.log" || fail "stopped an inactive job"

# Not healthy: timers stay stopped and are listed for the operator.
work="${TMP_ROOT}/work2"
setup "$work"
rm -f "${TMP_ROOT}/healthy"
cutover "$work" && fail "unhealthy cutover reported success"
grep -q 'left stopped' "${TMP_ROOT}/out" || fail "no stopped-timers message: $(cat "${TMP_ROOT}/out")"
grep -q 'start cocalc-bay-sqlite-backup.timer' "${TMP_ROOT}/systemctl.log" && fail "restarted timers on an unhealthy bay"
grep -qx 'cocalc-bay-pgbackrest-diff.timer' "${work}/stopped-timers" || fail "stopped timers not recorded"

# The full backup cannot be queued: exit status 2 and a warning.
work="${TMP_ROOT}/work3"
setup "$work"
touch "${TMP_ROOT}/healthy" "${TMP_ROOT}/fail-full"
set +e
cutover "$work"
code=$?
set -e
[[ "$code" == 2 ]] || fail "expected exit status 2, got $code: $(cat "${TMP_ROOT}/out")"
grep -q 'WARNING: could not start a full pgBackRest backup' "${TMP_ROOT}/out" || fail "no warning"
grep -q 'was started' "${TMP_ROOT}/out" && fail "claimed the full backup started"

echo "bay-restore cutover tests passed"
