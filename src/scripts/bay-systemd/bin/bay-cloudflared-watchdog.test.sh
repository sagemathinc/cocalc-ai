#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="${TMP}/bin"
mkdir -p "$FAKE_BIN"

cat > "${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${*: -1}"
case "$url" in
  *:20242/ready)
    printf '{"status":200,"readyConnections":%s}\n' "${FAKE_READY_2:-4}"
    ;;
  */ready)
    printf '{"status":200,"readyConnections":%s}\n' "${FAKE_READY:-4}"
    ;;
  */metrics)
    printf 'cloudflared_tunnel_server_locations{connection_id="0",edge_location="dfw08"} 1\n'
    printf 'cloudflared_tunnel_server_locations{connection_id="1",edge_location="dfw15"} 1\n'
    ;;
  *)
    [[ "${FAKE_FRONTDOOR_HEALTHY:-1}" == "1" ]]
    ;;
esac
EOF

cat > "${FAKE_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$WATCHDOG_SYSTEMCTL_LOG"
case "$1" in
  is-active)
    if [[ "${*: -1}" == cocalc-bay-cloudflared-2.service ]]; then
      [[ "${FAKE_UNIT2_ACTIVE:-1}" == "1" || -e "${WATCHDOG_SYSTEMCTL_LOG}.started-2" ]]
    else
      [[ "${FAKE_UNIT_ACTIVE:-1}" == "1" ]]
    fi
    ;;
  is-enabled)
    [[ "${*: -1}" != cocalc-bay-cloudflared-2.service || "${FAKE_UNIT2_ENABLED:-1}" == "1" ]]
    ;;
  start)
    if [[ "${*: -1}" == cocalc-bay-cloudflared-2.service && "${FAKE_UNIT2_STARTS:-1}" == "1" ]]; then
      touch "${WATCHDOG_SYSTEMCTL_LOG}.started-2"
    fi
    ;;
  show)
    printf 'Mon 2026-09-21 01:24:04 UTC\n'
    ;;
esac
EOF

cat > "${FAKE_BIN}/journalctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$WATCHDOG_JOURNALCTL_LOG"
since=0
unit=""
while (($#)); do
  case "$1" in
    --since) since="${2#@}"; shift 2 ;;
    --unit) unit="$2"; shift 2 ;;
    *) shift ;;
  esac
done
failures="${FAKE_FAILURES:-}"
if [[ "$unit" == cocalc-bay-cloudflared-2.service ]]; then
  failures="${FAKE_FAILURES_2:-}"
fi
# Failures are logged now unless a test pins them to an earlier burst.
ts="${FAKE_FAILURE_TS:-$(date +%s.%N)}"
if ((${ts%.*} < since)); then
  exit 0
fi
emit() {
  local conn="$1" count="$2" i
  for ((i = 0; i < count; i++)); do
    printf '%s prod-bay-0 bay-cloudflared[1]: 2026-10-07T20:27:31Z ERR  error="stream %s canceled by remote with error code 0" connIndex=%s event=1 ingressRule=0\n' "$ts" "$i" "$conn"
    printf '%s prod-bay-0 bay-cloudflared[1]: 2026-10-07T20:27:31Z ERR Request failed error="stream %s canceled by remote with error code 0" connIndex=%s dest=https://cocalc.ai/customize event=0\n' "$ts" "$i" "$conn"
  done
}
for spec in $failures; do
  emit "${spec%%:*}" "${spec##*:}"
done
EOF

# The watchdog runs as the bay user: the journal and restarts go through the
# root helper with sudo. Stand-ins that forward to the fakes above.
cat > "${FAKE_BIN}/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-n" ]] && shift
exec "$@"
EOF
cat > "${FAKE_BIN}/cocalc-bay-cloudflared-ctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
unit() {
  if [[ "${1:-1}" == 1 ]]; then
    printf 'cocalc-bay-cloudflared.service'
  else
    printf 'cocalc-bay-cloudflared-%s.service' "$1"
  fi
}
case "$1" in
  restart) exec systemctl restart "$(unit "${2:-1}")" ;;
  start) exec systemctl start "$(unit "${2:-1}")" ;;
  journal-since) exec journalctl --unit "$(unit "${3:-1}")" --since "@$2" --output short-unix --no-pager ;;
  *) exit 2 ;;
esac
EOF
export COCALC_BAY_CLOUDFLARED_CTL="${FAKE_BIN}/cocalc-bay-cloudflared-ctl"

cat > "${FAKE_BIN}/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
EOF
chmod 0755 "${FAKE_BIN}/"*

export PATH="${FAKE_BIN}:${PATH}"
export COCALC_BAY_ENV_FILE="${TMP}/missing-bay.env"
export COCALC_BAY_WORKERS_ENV_FILE="${TMP}/missing-workers.env"
export COCALC_BAY_OVERLAY_ENV_FILE="${TMP}/missing-overlay.env"
export COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP}/missing-topology.env"
export COCALC_BAY_SECRETS_ENV_FILE="${TMP}/missing-secrets.env"
export COCALC_BAY_RUN_DIR="${TMP}/run"
export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=3
export COCALC_BAY_CLOUDFLARED_WATCHDOG_MIN_FAILURES=20
export COCALC_BAY_CLOUDFLARED_WATCHDOG_READY_TIMEOUT_S=0
# The single-replica cases below; the replica cases come at the end.
export COCALC_BAY_CLOUDFLARED_REPLICAS=1
export WATCHDOG_SYSTEMCTL_LOG="${TMP}/systemctl.log"
export WATCHDOG_JOURNALCTL_LOG="${TMP}/journalctl.log"
STDERR_LOG="${TMP}/stderr.log"

run_watchdog() {
  bash "${SCRIPT_DIR}/bay-cloudflared-watchdog" 2>>"$STDERR_LOG"
}

reset_state() {
  : > "$WATCHDOG_SYSTEMCTL_LOG"
  : > "$STDERR_LOG"
  rm -rf "$COCALC_BAY_RUN_DIR"
  rm -f "${WATCHDOG_SYSTEMCTL_LOG}.started-2"
  export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=3
  export FAKE_READY=4 FAKE_FRONTDOOR_HEALTHY=1 FAKE_UNIT_ACTIVE=1
  export FAKE_READY_2=4 FAKE_UNIT2_ACTIVE=1 FAKE_FAILURES_2=""
  export FAKE_UNIT2_ENABLED=1 FAKE_UNIT2_STARTS=1
  unset FAKE_FAILURE_TS
}

restart_count() {
  grep -c '^restart cocalc-bay-cloudflared.service$' "$WATCHDOG_SYSTEMCTL_LOG" || true
}

restart_count_2() {
  grep -c '^restart cocalc-bay-cloudflared-2.service$' "$WATCHDOG_SYSTEMCTL_LOG" || true
}

fail() {
  echo "$*" >&2
  cat "$STDERR_LOG" >&2
  exit 1
}

# Root-only operations go through the helper, never directly.
if grep -En '^[^#]*(systemctl (restart|reset-failed)|journalctl)' "${SCRIPT_DIR}/bay-cloudflared-watchdog"; then
  echo "the watchdog calls systemctl restart or journalctl directly" >&2
  exit 1
fi

# One connection failing every stream while the others work: restart after the
# threshold, include the edge locations, then respect the cooldown.
reset_state
export FAKE_FAILURES="0:120 2:3"
run_watchdog
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "restarted before reaching the threshold"
run_watchdog
[[ "$(restart_count)" == "1" ]] || fail "did not restart a tunnel with one failing connection"
grep -q 'connIndex=0 failed 120 of 123' "$STDERR_LOG" || fail "restart reason missing failure counts"
grep -q 'edges: 0=dfw08 1=dfw15' "$STDERR_LOG" || fail "restart log missing edge locations"
grep -q -- '--since @' "$WATCHDOG_JOURNALCTL_LOG" || fail "journal query is not time bounded"
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "restarted again during cooldown"

# One short burst stays in the journal window for several checks, but each
# line is evidence for only one check.
reset_state
export FAKE_FAILURE_TS="$(date +%s).250000" FAKE_FAILURES="0:120"
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted after re-reading one stale burst"

# Strikes belong to one degradation: a different dominant connection in each
# check, or switching from one connection to no-ready, starts over.
reset_state
for conn in 0 1 2 3; do
  export FAKE_FAILURES="${conn}:120"
  run_watchdog
done
[[ "$(restart_count)" == "0" ]] || fail "restarted when the failing connection rotated"
reset_state
export FAKE_FAILURES="0:120"
run_watchdog
run_watchdog
export FAKE_READY=0 FAKE_FAILURES=""
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "no-ready check inherited per-connection strikes"
run_watchdog
run_watchdog
[[ "$(restart_count)" == "1" ]] || fail "did not restart after three no-ready checks"

# A check where the origin is unhealthy breaks the run of strikes.
reset_state
export FAKE_FAILURES="0:120"
run_watchdog
run_watchdog
export FAKE_FRONTDOOR_HEALTHY=0
run_watchdog
export FAKE_FRONTDOOR_HEALTHY=1
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "strikes survived a check with an unhealthy frontdoor"

# Failures spread across connections point at the origin or clients.
reset_state
export FAKE_FAILURES="0:40 1:40 2:40 3:40"
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted for failures spread over all connections"

# A few failures are normal client cancellations.
reset_state
export FAKE_FAILURES="0:10"
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted below the minimum failure count"

# A healthy pass clears accumulated strikes.
reset_state
export FAKE_FAILURES="0:120"
run_watchdog
run_watchdog
export FAKE_FAILURES=""
run_watchdog
export FAKE_FAILURES="0:120"
run_watchdog
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "strikes were not reset by a healthy pass"

# With one connection, concentration says nothing about the edge.
reset_state
export FAKE_READY=1 FAKE_FAILURES="0:120"
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted with a single ready connection"

# Never restart the tunnel because of a broken origin.
reset_state
export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=1
export FAKE_FRONTDOOR_HEALTHY=0 FAKE_FAILURES="0:120"
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "restarted while the frontdoor was unhealthy"
grep -q 'frontdoor is unhealthy' "$STDERR_LOG" || fail "missing frontdoor gate log"

# No ready tunnel connections at all.
reset_state
export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=1
export FAKE_READY=0 FAKE_FAILURES=""
run_watchdog
[[ "$(restart_count)" == "1" ]] || fail "did not restart with zero ready connections"

# Inactive or disabled units are left alone.
reset_state
export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=1
export FAKE_UNIT_ACTIVE=0 FAKE_READY=0
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "restarted an inactive unit"
reset_state
export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=1
export COCALC_BAY_CLOUDFLARED_WATCHDOG_ENABLED=0 FAKE_READY=0
run_watchdog
[[ "$(restart_count)" == "0" ]] || fail "restarted while the watchdog was disabled"

# ---- Two replicas of the tunnel ----
export COCALC_BAY_CLOUDFLARED_REPLICAS="1 2"
unset COCALC_BAY_CLOUDFLARED_WATCHDOG_ENABLED

# Only the degraded replica is restarted; the healthy one keeps serving.
reset_state
export FAKE_FAILURES="0:120" FAKE_FAILURES_2=""
for _ in 1 2 3; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not restart the degraded replica 1"
[[ "$(restart_count_2)" == "0" ]] || fail "restarted the healthy replica 2"
reset_state
export FAKE_FAILURES="" FAKE_FAILURES_2="1:120"
for _ in 1 2 3; do run_watchdog; done
[[ "$(restart_count_2)" == "1" ]] || fail "did not restart the degraded replica 2"
[[ "$(restart_count)" == "0" ]] || fail "restarted the healthy replica 1"
grep -q 'restarting cocalc-bay-cloudflared-2.service' "$STDERR_LOG" || fail "restart log does not name replica 2"
grep -q -- '--unit cocalc-bay-cloudflared-2.service' "$WATCHDOG_JOURNALCTL_LOG" || fail "replica 2 was not judged on its own journal"

# Both degraded at once: one restart, then the other only after the gap.
reset_state
export FAKE_FAILURES="0:120" FAKE_FAILURES_2="1:120"
for _ in 1 2 3 4 5; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not restart replica 1 when both were degraded"
[[ "$(restart_count_2)" == "0" ]] || fail "restarted both replicas within the gap"
grep -q 'will not restart cocalc-bay-cloudflared-2.service yet (replica 1 was restarted' "$STDERR_LOG" || fail "missing replica gap log"
printf '%s\n' "$(($(date +%s) - 300))" > "${COCALC_BAY_RUN_DIR}/cloudflared-watchdog/last-restart"
run_watchdog
[[ "$(restart_count_2)" == "1" ]] || fail "replica 2 was not restarted after the gap (its strikes were lost)"

# A degraded replica is not restarted while the other replica is up but has
# no ready connection: it is the one carrying the traffic. The other one,
# having nothing ready, is restarted instead.
reset_state
export FAKE_FAILURES="0:120" FAKE_READY_2=0 FAKE_FAILURES_2=""
for _ in 1 2 3; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted replica 1 while it was the only replica serving"
grep -q 'will not restart cocalc-bay-cloudflared.service yet (no other replica has a ready tunnel connection)' "$STDERR_LOG" || fail "missing no-other-ready log"
[[ "$(restart_count_2)" == "1" ]] || fail "did not restart replica 2 with no ready connections"

# Only replica 2 serves (replica 1 has no ready connection): replica 1 is
# recovered, replica 2 is left alone.
reset_state
export FAKE_READY=0 FAKE_READY_2=4 FAKE_FAILURES="" FAKE_FAILURES_2=""
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not recover replica 1 while replica 2 served"
[[ "$(restart_count_2)" == "0" ]] || fail "restarted replica 2, the only serving replica"

# No replica serving at all: restarting one is the only way back, and the gap
# keeps the other from restarting at the same time.
reset_state
export FAKE_READY=0 FAKE_READY_2=0 FAKE_FAILURES="" FAKE_FAILURES_2=""
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not restart a replica when none had a ready connection"
[[ "$(restart_count_2)" == "0" ]] || fail "restarted both replicas when none was ready"

# A bay running a single replica (the other unit disabled) still recovers.
reset_state
export FAKE_FAILURES="0:120" FAKE_UNIT2_ACTIVE=0 FAKE_UNIT2_ENABLED=0
for _ in 1 2 3; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not restart the only configured replica"
grep -q '^start ' "$WATCHDOG_SYSTEMCTL_LOG" && fail "started a disabled replica"

# Replica 2 is enabled but stopped or failed, and replica 1 is degraded but
# still serving: replica 2 is started first, and replica 1 restarted only
# once replica 2 is ready.
reset_state
export FAKE_FAILURES="0:120" FAKE_UNIT2_ACTIVE=0
for _ in 1 2 3; do run_watchdog; done
grep -q '^start cocalc-bay-cloudflared-2.service$' "$WATCHDOG_SYSTEMCTL_LOG" || fail "did not start the failed replica 2"
[[ "$(restart_count)" == "1" ]] || fail "did not restart replica 1 once replica 2 was back"
# ...and when replica 2 cannot be started, replica 1 (degraded, but the only
# one serving) is left alone: a degraded tunnel beats none.
reset_state
export FAKE_FAILURES="0:120" FAKE_UNIT2_ACTIVE=0 FAKE_UNIT2_STARTS=0
for _ in 1 2 3 4; do run_watchdog; done
[[ "$(restart_count)" == "0" ]] || fail "restarted the only serving replica while replica 2 could not start"
grep -q 'replica 2 could not be started' "$STDERR_LOG" || fail "missing could-not-start log"
# ...but a replica 1 with nothing ready is still restarted.
reset_state
export FAKE_READY=0 FAKE_FAILURES="" FAKE_UNIT2_ACTIVE=0 FAKE_UNIT2_STARTS=0
for _ in 1 2 3; do run_watchdog; done
[[ "$(restart_count)" == "1" ]] || fail "did not restart replica 1 with nothing ready"

# ---- The whole state table ----
# Each replica is ready, degraded (ready connections, one failing every
# stream), none (running, no ready connection), unknown (running, readiness
# unreadable), failed (enabled but not running) or disabled; a failed
# replica either starts again or never does. One watchdog pass at a time
# (threshold 1), five passes per cell. Every restart of a replica that is
# serving must happen while the other replica is ready, except on a bay
# configured with one replica (the other disabled), where restarting the
# degraded replica is the only way to recover, as before replicas.
M="${TMP}/matrix"
mkdir -p "$M"
cat > "${M}/state.sh" <<'FAKE'
m_unit_replica() { [[ "$1" == cocalc-bay-cloudflared-2.service ]] && echo 2 || echo 1; }
# Replica $1's state now: ready, degraded, none, unknown, failed or disabled.
m_state() {
  local replica="$1" var="M_STATE_$1"
  if [[ -e "${MLOG}.restarted.${replica}" || -e "${MLOG}.started.${replica}" ]]; then
    echo ready
  else
    echo "${!var}"
  fi
}
# Its ready connections, or nothing when it does not answer.
m_ready() {
  case "$(m_state "$1")" in
    ready|degraded) echo 4 ;;
    none) echo 0 ;;
  esac
}
FAKE
cat > "${M}/systemctl" <<'FAKE'
#!/usr/bin/env bash
source "${MDIR}/state.sh"
replica="$(m_unit_replica "${*: -1}")"
state="$(m_state "$replica")"
case "$1" in
  is-active) [[ "$state" != failed && "$state" != disabled ]]; exit $? ;;
  is-enabled) [[ "$state" != disabled ]]; exit $? ;;
  show) printf 'Mon 2026-09-21 01:24:04 UTC\n' ;;
  start)
    [[ "$state" == failed && "${M_STARTS}" == 1 ]] && touch "${MLOG}.started.${replica}"
    echo "start ${replica}" >> "$MLOG" ;;
  restart)
    other=$((3 - replica))
    if [[ -n "$(m_ready "$replica")" && "$(m_ready "$replica")" != 0 || "$state" == unknown ]] &&
        ! [[ "$(m_ready "$other")" =~ ^[1-9] ]] && [[ "$(m_state "$other")" != disabled ]]; then
      echo "VIOLATION restart ${replica} (${state}) while replica ${other} is $(m_state "$other")" >> "$MLOG"
    fi
    echo "restart ${replica}" >> "$MLOG"
    touch "${MLOG}.restarted.${replica}" ;;
esac
exit 0
FAKE
cat > "${M}/curl" <<'FAKE'
#!/usr/bin/env bash
source "${MDIR}/state.sh"
url="${*: -1}"
case "$url" in
  *:20241/ready|*:20242/ready)
    replica=1
    [[ "$url" == *:20242/ready ]] && replica=2
    ready="$(m_ready "$replica")"
    [[ -n "$ready" ]] || exit 7
    printf '{"status":200,"readyConnections":%s}\n' "$ready" ;;
  */metrics) ;;
  *) exit 0 ;;
esac
FAKE
cat > "${M}/journalctl" <<'FAKE'
#!/usr/bin/env bash
source "${MDIR}/state.sh"
replica=1
[[ "$*" == *cocalc-bay-cloudflared-2.service* ]] && replica=2
[[ "$(m_state "$replica")" == degraded ]] || exit 0
ts="$(date +%s.%N)"
for ((i = 0; i < 120; i++)); do
  printf '%s bay cloudflared[1]: ERR Request failed error="stream %s canceled by remote" connIndex=0 event=0\n' "$ts" "$i"
done
FAKE
cp "${FAKE_BIN}/cocalc-bay-cloudflared-ctl" "${FAKE_BIN}/sudo" "${FAKE_BIN}/timeout" "$M/"
chmod 0755 "$M"/*
export MDIR="$M" MLOG="${M}/log"
for M_STARTS in 1 0; do
  for M_STATE_1 in ready degraded none unknown failed disabled; do
    for M_STATE_2 in ready degraded none unknown failed disabled; do
      export M_STARTS M_STATE_1 M_STATE_2
      : > "$MLOG"
      rm -f "${MLOG}".restarted.* "${MLOG}".started.*
      rm -rf "$COCALC_BAY_RUN_DIR"
      for _ in 1 2 3 4 5; do
        PATH="${M}:${PATH}" COCALC_BAY_CLOUDFLARED_CTL="${M}/cocalc-bay-cloudflared-ctl" \
          COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=1 \
          COCALC_BAY_CLOUDFLARED_METRICS_URL=http://127.0.0.1:20241 run_watchdog
      done
      cell="replica 1 ${M_STATE_1}, replica 2 ${M_STATE_2}, failed replicas start=${M_STARTS}"
      if grep -q VIOLATION "$MLOG"; then
        cat "$MLOG" >&2
        fail "watchdog dropped ingress: ${cell}"
      fi
      printf '  %-62s %s\n' "$cell" "$(grep -E '^(start|restart) ' "$MLOG" | tr '\n' ' ')" >> "${TMP}/matrix.txt"
    done
  done
done
if [[ -n "${WATCHDOG_MATRIX_OUT:-}" ]]; then cp "${TMP}/matrix.txt" "$WATCHDOG_MATRIX_OUT"; fi

echo "bay cloudflared watchdog tests passed"
