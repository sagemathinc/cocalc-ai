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
case "${*: -1}" in
  *:20242/ready) printf '{"status":200,"readyConnections":%s}\n' "${FAKE_READY_2:-4}" ;;
  *) printf '{"status":200,"readyConnections":%s}\n' "${FAKE_READY:-4}" ;;
esac
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
  export FAKE_READY=4 FAKE_READY_2=4 FAKE_RESTART2_FAILS=0 FAKE_REPLICA2_INSTALLED=1
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

# A bay with only replica 1 installed.
reset
export FAKE_REPLICA2_INSTALLED=0
bash "$CTL" restart-all || fail "restart-all failed with one replica"
[[ "$(restarts)" == "restart cocalc-bay-cloudflared.service " ]] || fail "single replica: $(restarts)"

echo "cocalc-bay-cloudflared-ctl tests passed"
