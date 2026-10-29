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
  unset FAKE_READY_AFTER_RESTART FAKE_READY_2_AFTER_RESTART
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

# restart-all: replica 2 first, then replica 1 once replica 2 is ready.
reset
bash "$CTL" restart-all || fail "restart-all failed with healthy replicas"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service restart cocalc-bay-cloudflared.service " ]] ||
  fail "restart-all order: $(restarts)"

# Replica 2 restarts but never gets a ready connection: replica 1 is left
# alone (it may be the only one serving).
reset
export FAKE_READY_2=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 2 not ready"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restarted replica 1 after replica 2 did not come back: $(restarts)"

# Replica 2's restart fails outright: same.
reset
export FAKE_RESTART2_FAILS=1
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded after a failed restart"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restarted replica 1 after replica 2's restart failed: $(restarts)"

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
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service restart cocalc-bay-cloudflared.service " ]] ||
  fail "no replica ready: $(restarts)"

# Readiness that cannot be read is not "none": replica 1 answers garbage
# (it may well be serving) and replica 2 has none. Replica 2 is recovered
# first; if it does not come back, replica 1 is left alone.
reset
export FAKE_READY=garbage FAKE_READY_2=0
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with replica 2 not recovering"; fi
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service " ]] ||
  fail "restarted a replica of unknown readiness without another ready: $(restarts)"
# ...and once replica 2 is ready, replica 1 is restarted.
reset
export FAKE_READY=garbage FAKE_READY_2=0 FAKE_READY_2_AFTER_RESTART=4 FAKE_READY_AFTER_RESTART=4
bash "$CTL" restart-all || fail "restart-all failed after replica 2 recovered"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared-2.service restart cocalc-bay-cloudflared.service " ]] ||
  fail "unknown readiness, replica 2 recovered: $(restarts)"
# Neither readable: nothing is known to be ready, so nothing is restarted.
reset
export FAKE_READY=garbage FAKE_READY_2=garbage
if bash "$CTL" restart-all 2>/dev/null; then fail "restart-all succeeded with no readiness known"; fi
[[ -z "$(restarts)" ]] || fail "restarted with no readiness known: $(restarts)"

# A bay with only replica 1 installed.
reset
export FAKE_REPLICA2_INSTALLED=0
bash "$CTL" restart-all || fail "restart-all failed with one replica"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service " ]] || fail "single replica: $(restarts)"

echo "cocalc-bay-cloudflared-ctl tests passed"
