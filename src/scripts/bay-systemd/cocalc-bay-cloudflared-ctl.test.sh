#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The helper calls fixed system paths (it runs as root through sudo); test a
# copy that calls fakes instead.
CTL="${TMP}/ctl"
sed -e "s#^SYSTEMCTL=.*#SYSTEMCTL=${TMP}/systemctl#" \
  -e "s#^JOURNALCTL=.*#JOURNALCTL=${TMP}/journalctl#" \
  -e "s#^CURL=.*#CURL=${TMP}/curl#" \
  -e "s#^READY_TIMEOUT_S=.*#READY_TIMEOUT_S=2#" \
  "${SCRIPT_DIR}/sbin/cocalc-bay-cloudflared-ctl" > "$CTL"
grep -q "^SYSTEMCTL=${TMP}/systemctl$" "$CTL" || { echo "could not redirect systemctl" >&2; exit 1; }
grep -q "^READY_TIMEOUT_S=2$" "$CTL" || { echo "could not shorten the ready timeout" >&2; exit 1; }
LOG="${TMP}/log"
export LOG

cat > "${TMP}/systemctl" <<'FAKE'
#!/usr/bin/env bash
args=("$@")
while [[ "${args[0]}" == --* ]]; do args=("${args[@]:1}"); done
echo "${args[*]}" >> "$LOG"
unit="${args[${#args[@]}-1]}"
case "${args[0]}" in
  list-unit-files)
    [[ "$unit" == cocalc-bay-cloudflared.service ]] && echo "$unit enabled enabled"
    [[ "$unit" == cocalc-bay-cloudflared-2.service && "${FAKE_REPLICA2_INSTALLED:-1}" == 1 ]] && echo "$unit enabled enabled"
    exit 0 ;;
  show)
    case "$unit" in
      cocalc-bay-cloudflared.service) echo "COCALC_BAY_CLOUDFLARED_REPLICA=1 COCALC_BAY_CLOUDFLARED_METRICS_ADDRESS=127.0.0.1:20241" ;;
      cocalc-bay-cloudflared-2.service) echo "COCALC_BAY_CLOUDFLARED_REPLICA=2 COCALC_BAY_CLOUDFLARED_METRICS_ADDRESS=127.0.0.1:20242" ;;
    esac ;;
  restart)
    [[ "$unit" == cocalc-bay-cloudflared-2.service && "${FAKE_RESTART2_FAILS:-0}" == 1 ]] && exit 1
    touch "${LOG}.restarted.${unit}"
    exit 0 ;;
  is-active)
    # FAKE_UNIT1_INACTIVE: replica 1 stopped or failed until restarted.
    [[ "$unit" == cocalc-bay-cloudflared.service && "${FAKE_UNIT1_INACTIVE:-0}" == 1 && ! -e "${LOG}.restarted.${unit}" ]] && exit 3
    exit 0 ;;
esac
exit 0
FAKE
cat > "${TMP}/journalctl" <<'FAKE'
#!/usr/bin/env bash
echo "journalctl $*" >> "$LOG"
FAKE
cat > "${TMP}/curl" <<'FAKE'
#!/usr/bin/env bash
# FAKE_READY*_AFTER_RESTART: the ready count once the unit was restarted.
case "${*: -1}" in
  *:20242/ready)
    ready="${FAKE_READY_2:-4}"
    [[ -e "${LOG}.restarted.cocalc-bay-cloudflared-2.service" && -n "${FAKE_READY_2_AFTER_RESTART:-}" ]] && ready="$FAKE_READY_2_AFTER_RESTART"
    ;;
  *)
    ready="${FAKE_READY:-4}"
    [[ -e "${LOG}.restarted.cocalc-bay-cloudflared.service" && -n "${FAKE_READY_AFTER_RESTART:-}" ]] && ready="$FAKE_READY_AFTER_RESTART"
    ;;
esac
printf '{"status":200,"readyConnections":%s}\n' "$ready"
FAKE
chmod 0755 "$CTL" "${TMP}/systemctl" "${TMP}/journalctl" "${TMP}/curl"

fail() {
  echo "$*" >&2
  cat "$LOG" >&2
  exit 1
}
restarts() {
  grep '^restart ' "$LOG" | tr '\n' ' ' || true
}
reset() {
  : > "$LOG"
  rm -f "${LOG}".restarted.*
  export FAKE_READY=4 FAKE_READY_2=4 FAKE_RESTART2_FAILS=0 FAKE_REPLICA2_INSTALLED=1
  unset FAKE_READY_AFTER_RESTART FAKE_READY_2_AFTER_RESTART FAKE_UNIT1_INACTIVE
}

# The original forms still mean replica 1; a replica argument selects another.
reset
bash "$CTL" restart
bash "$CTL" restart 2
bash "$CTL" journal-since 1793300000 2
bash "$CTL" journal-since 1793300000
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restart forms: $(restarts)"
grep -q -- 'journalctl --unit cocalc-bay-cloudflared-2.service --since @1793300000' "$LOG" || fail "journal for replica 2"
grep -q -- 'journalctl --unit cocalc-bay-cloudflared.service --since @1793300000' "$LOG" || fail "journal for replica 1"
for bad in "restart x" "restart 0" "restart 10" "status 2 3" "journal-since x 2" "journal-since 1 x"; do
  # shellcheck disable=SC2086
  if bash "$CTL" $bad 2>/dev/null; then fail "accepted: $bad"; fi
done

# restart-all: replica 1 first (it refreshes the tunnel state replica 2
# loads), while replica 2 serves; then replica 2 once replica 1 is ready.
reset
bash "$CTL" restart-all || fail "restart-all failed with healthy replicas"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restart-all order: $(restarts)"

# Replica 2 restarts but never gets a ready connection: the roll stops and
# reports it (replica 1 is back and serving).
reset
export FAKE_READY_2_AFTER_RESTART=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 2 not ready"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "replica 2 did not come back: $(restarts)"

# Replica 1 does not come back: replica 2, then the only one serving, is
# left alone.
reset
export FAKE_READY_AFTER_RESTART=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 1 not ready"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service " ]] ||
  fail "restarted replica 2 after replica 1 did not come back: $(restarts)"

# Only replica 2 serves: replica 1 (no ready connection) is recovered first,
# and replica 2 is restarted only once replica 1 is ready.
reset
export FAKE_READY=0 FAKE_READY_AFTER_RESTART=4
bash "$CTL" restart-all || fail "restart-all failed recovering replica 1 first"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "did not recover the non-serving replica first: $(restarts)"

# Only replica 2 serves and replica 1 does not come back: replica 2, the last
# serving replica, is never restarted.
reset
export FAKE_READY=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 1 not recovering"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service " ]] ||
  fail "restarted the only serving replica: $(restarts)"

# No replica ready at all: there is nothing to keep serving, so restarting
# is how ingress comes back.
reset
export FAKE_READY=0 FAKE_READY_2=0 FAKE_READY_AFTER_RESTART=4 FAKE_READY_2_AFTER_RESTART=4
bash "$CTL" restart-all || fail "restart-all failed with no replica ready"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "no replica ready: $(restarts)"

# Readiness that cannot be read is not "none": replica 1 answers garbage
# (it may well be serving) and replica 2 has none. Replica 2 is recovered
# first; if it does not come back, replica 1 is left alone.
reset
export FAKE_READY=garbage FAKE_READY_2=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 2 not recovering"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restarted a replica of unknown readiness without another ready: $(restarts)"
# ...and once replica 2 is ready, replica 1 is restarted, then replica 2
# again, to load the tunnel state replica 1 refreshed.
reset
export FAKE_READY=garbage FAKE_READY_2=0 FAKE_READY_2_AFTER_RESTART=4 FAKE_READY_AFTER_RESTART=4
bash "$CTL" restart-all || fail "restart-all failed after replica 2 recovered"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "unknown readiness, replica 2 recovered: $(restarts)"
# Neither readable: nothing is known to be ready, so nothing is restarted.
reset
export FAKE_READY=garbage FAKE_READY_2=garbage
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with no readiness known"; fi
[[ -z "$(restarts)" ]] || fail "restarted with no readiness known: $(restarts)"

# Replica 1 is stopped or failed (its metrics do not answer) while replica 2
# serves: it is recovered first, then replica 2.
reset
export FAKE_UNIT1_INACTIVE=1 FAKE_READY=garbage FAKE_READY_AFTER_RESTART=4
bash "$CTL" restart-all || fail "restart-all failed recovering an inactive replica 1"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "did not recover the inactive replica first: $(restarts)"

# A bay with only replica 1 installed.
reset
export FAKE_REPLICA2_INSTALLED=0
bash "$CTL" restart-all || fail "restart-all failed with one replica"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service " ]] || fail "single replica: $(restarts)"

# ---- The whole state table ----
# Each replica is ready (a degraded replica still reports ready connections,
# which is all restart-all sees), none (running, no ready connection),
# unknown (running, readiness unreadable) or inactive (stopped or failed);
# restarted replicas either come back ready or never do. In every cell,
# every restart of a replica that may be serving happens while the other
# replica is ready; a violation is recorded by the fake systemctl.
M="${TMP}/matrix"
mkdir -p "$M"
cat > "${M}/state.sh" <<'FAKE'
# The readiness of unit $1 now: a number, "unknown" or "inactive".
m_state() {
  local unit="$1" var state
  if [[ -e "${MLOG}.restarted.${unit}" ]]; then
    ((M_RECOVERS)) && echo 4 || echo 0
    return
  fi
  var=M_STATE_1
  [[ "$unit" == cocalc-bay-cloudflared-2.service ]] && var=M_STATE_2
  state="${!var}"
  case "$state" in
    ready) echo 4 ;;
    none) echo 0 ;;
    *) echo "$state" ;;
  esac
}
FAKE
cat > "${M}/systemctl" <<'FAKE'
#!/usr/bin/env bash
source "${MDIR}/state.sh"
args=("$@")
while [[ "${args[0]}" == --* ]]; do args=("${args[@]:1}"); done
unit="${args[${#args[@]}-1]}"
case "${args[0]}" in
  list-unit-files)
    [[ "$unit" == cocalc-bay-cloudflared.service || "$unit" == cocalc-bay-cloudflared-2.service ]] &&
      echo "$unit enabled enabled" ;;
  show)
    case "$unit" in
      cocalc-bay-cloudflared.service) echo "COCALC_BAY_CLOUDFLARED_METRICS_ADDRESS=127.0.0.1:20241" ;;
      *) echo "COCALC_BAY_CLOUDFLARED_METRICS_ADDRESS=127.0.0.1:20242" ;;
    esac ;;
  is-active) [[ "$(m_state "$unit")" != inactive ]]; exit $? ;;
  restart)
    other=cocalc-bay-cloudflared-2.service
    [[ "$unit" == "$other" ]] && other=cocalc-bay-cloudflared.service
    mine="$(m_state "$unit")"
    theirs="$(m_state "$other")"
    serving=0
    [[ "$mine" == unknown || ("$mine" =~ ^[0-9]+$ && "$mine" -gt 0) ]] && serving=1
    if ((serving)) && ! [[ "$theirs" =~ ^[0-9]+$ && "$theirs" -gt 0 ]]; then
      echo "VIOLATION restart ${unit} (${mine}) while ${other} is ${theirs}" >> "$MLOG"
    fi
    echo "restart ${unit}" >> "$MLOG"
    touch "${MLOG}.restarted.${unit}" ;;
esac
exit 0
FAKE
cat > "${M}/curl" <<'FAKE'
#!/usr/bin/env bash
source "${MDIR}/state.sh"
unit=cocalc-bay-cloudflared.service
[[ "${*: -1}" == *:20242/ready ]] && unit=cocalc-bay-cloudflared-2.service
state="$(m_state "$unit")"
case "$state" in
  inactive) exit 7 ;;
  unknown) echo garbage ;;
  *) printf '{"status":200,"readyConnections":%s}\n' "$state" ;;
esac
FAKE
chmod 0755 "${M}/systemctl" "${M}/curl"
MCTL="${M}/ctl"
sed -e "s#^SYSTEMCTL=.*#SYSTEMCTL=${M}/systemctl#" \
  -e "s#^CURL=.*#CURL=${M}/curl#" \
  -e "s#^READY_TIMEOUT_S=.*#READY_TIMEOUT_S=1#" \
  "${SCRIPT_DIR}/sbin/cocalc-bay-cloudflared-ctl" > "$MCTL"
export MDIR="$M" MLOG="${M}/log"
for M_RECOVERS in 1 0; do
  for M_STATE_1 in ready none unknown inactive; do
    for M_STATE_2 in ready none unknown inactive; do
      export M_RECOVERS M_STATE_1 M_STATE_2
      : > "$MLOG"
      rm -f "${MLOG}".restarted.*
      bash "$MCTL" restart-all >/dev/null 2>&1 && code=0 || code=$?
      cell="replica 1 ${M_STATE_1}, replica 2 ${M_STATE_2}, restarts recover=${M_RECOVERS}"
      if grep -q VIOLATION "$MLOG"; then
        cat "$MLOG" >&2
        fail "restart-all dropped ingress: ${cell}"
      fi
      # Restarts that come back ready finish the whole roll.
      if ((M_RECOVERS)) && [[ "$M_STATE_1/$M_STATE_2" != unknown/unknown ]] && ((code != 0)); then
        cat "$MLOG" >&2
        fail "restart-all did not finish: ${cell}"
      fi
      printf '  %-58s exit %s: %s\n' "$cell" "$code" "$(grep -c '^restart' "$MLOG") restarts" >> "${TMP}/matrix.txt"
    done
  done
done
if [[ -n "${CTL_MATRIX_OUT:-}" ]]; then cp "${TMP}/matrix.txt" "$CTL_MATRIX_OUT"; fi

echo "cocalc-bay-cloudflared-ctl tests passed"
