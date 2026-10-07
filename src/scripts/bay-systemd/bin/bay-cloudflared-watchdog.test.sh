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
    [[ "${FAKE_UNIT_ACTIVE:-1}" == "1" ]]
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
while (($#)); do
  case "$1" in
    --since) since="${2#@}"; shift 2 ;;
    *) shift ;;
  esac
done
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
for spec in ${FAKE_FAILURES:-}; do
  emit "${spec%%:*}" "${spec##*:}"
done
EOF

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
  export COCALC_BAY_CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=3
  export FAKE_READY=4 FAKE_FRONTDOOR_HEALTHY=1 FAKE_UNIT_ACTIVE=1
  unset FAKE_FAILURE_TS
}

restart_count() {
  grep -c '^restart cocalc-bay-cloudflared.service$' "$WATCHDOG_SYSTEMCTL_LOG" || true
}

fail() {
  echo "$*" >&2
  cat "$STDERR_LOG" >&2
  exit 1
}

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

echo "bay cloudflared watchdog tests passed"
