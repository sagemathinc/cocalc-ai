#!/usr/bin/env bash
# The broker fabric TLS key tool (sbin/cocalc-bay-broker-tls-key) against a
# temporary /etc/cocalc, with a stand-in systemctl that runs the real
# listener (bin/bay-broker-tls.js) on loopback.
# Run: bash cocalc-bay-broker-tls-key.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/sbin/cocalc-bay-broker-tls-key"
MODULE="${SCRIPT_DIR}/bin/bay-broker-tls.js"
TMP_ROOT="$(mktemp -d)"
NODE="$(command -v node)"

stop_listener() {
  if [[ -f "${TMP_ROOT}/listener.pid" ]]; then
    kill "$(cat "${TMP_ROOT}/listener.pid")" 2>/dev/null || true
    rm -f "${TMP_ROOT}/listener.pid"
  fi
}
trap 'stop_listener; rm -rf "$TMP_ROOT"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

etc="${TMP_ROOT}/etc"
mkdir -p "$etc" "${TMP_ROOT}/bin"
PORT="$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

# The listener as the unit would run it, on loopback for the test.
cat > "${TMP_ROOT}/listener.js" <<EOF
const fs = require("node:fs");
const { createBrokerTlsServer } = require("${MODULE}");
const [keyFile, certFile, port, ready] = process.argv.slice(2);
const instance = createBrokerTlsServer(
  {
    bindHost: "127.0.0.1",
    allowedSources: new Set(["127.0.0.1"]),
    conatPath: "/conat/",
    upstreamHost: "127.0.0.1",
    upstreamPort: 9,
    upstreamHostHeader: "cocalc.example",
    maxConnections: 4,
    handshakeTimeoutMs: 2000,
    headersTimeoutMs: 2000,
    maxHeaderSize: 8192,
    upstreamConnectTimeoutMs: 1000,
    idleTimeoutMs: 5000,
  },
  { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
);
instance.server.listen(Number(port), "127.0.0.1", () => fs.writeFileSync(ready, "1"));
EOF

# systemctl: start/restart run the listener on the installed key, unless
# ${TMP_ROOT}/mode says the start fails ("fail") or the old process keeps
# serving the key it started with ("stale"). ${TMP_ROOT}/stop-mode isolates
# each proof of a stop: "fail" (stop fails, the listener runs on), "failquiet"
# (stop fails, though the listener is gone), "lie" (stop succeeds and
# is-active says inactive, but the listener runs on), "stuck" (stop succeeds
# and the listener is gone, but is-active says active).
# ${TMP_ROOT}/disable-mode likewise: "fail" (disable fails, still enabled),
# "failquiet" (disable fails, though not enabled), "stuck" (disable succeeds,
# still enabled). is-active reports the listener process, is-enabled the
# ${TMP_ROOT}/enabled flag.
cat > "${TMP_ROOT}/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${TMP_ROOT}/systemctl.log"
mode="\$(cat "${TMP_ROOT}/mode" 2>/dev/null || echo good)"
stop_mode="\$(cat "${TMP_ROOT}/stop-mode" 2>/dev/null || echo good)"
disable_mode="\$(cat "${TMP_ROOT}/disable-mode" 2>/dev/null || echo good)"
alive() {
  [[ -f "${TMP_ROOT}/listener.pid" ]] && kill -0 "\$(cat "${TMP_ROOT}/listener.pid")" 2>/dev/null
}
start() {
  [[ "\$mode" == fail ]] && exit 1
  rm -f "${TMP_ROOT}/ready"
  "$NODE" "${TMP_ROOT}/listener.js" "${etc}/broker-fabric-tls.key" "${etc}/broker-fabric-tls.crt" "$PORT" "${TMP_ROOT}/ready" >/dev/null 2>&1 &
  echo \$! > "${TMP_ROOT}/listener.pid"
  for _ in \$(seq 50); do [[ -f "${TMP_ROOT}/ready" ]] && return 0; sleep 0.1; done
  exit 1
}
stop() {
  if [[ -f "${TMP_ROOT}/listener.pid" ]]; then
    kill "\$(cat "${TMP_ROOT}/listener.pid")" 2>/dev/null || true
    rm -f "${TMP_ROOT}/listener.pid"
    sleep 0.2
  fi
}
case "\$1" in
  start) start ;;
  restart) [[ "\$mode" == stale && -f "${TMP_ROOT}/listener.pid" ]] && exit 0; stop; start ;;
  stop)
    case "\$stop_mode" in
      fail) exit 1 ;;
      failquiet) stop; exit 1 ;;
      lie) exit 0 ;;
    esac
    stop
    ;;
  is-active)
    [[ "\$stop_mode" == lie ]] && exit 3
    [[ "\$stop_mode" == stuck ]] && exit 0
    alive && exit 0
    exit 3
    ;;
  enable) touch "${TMP_ROOT}/enabled" ;;
  disable)
    case "\$disable_mode" in
      fail) exit 1 ;;
      failquiet) rm -f "${TMP_ROOT}/enabled"; exit 1 ;;
      stuck) exit 0 ;;
    esac
    rm -f "${TMP_ROOT}/enabled"
    ;;
  is-enabled) [[ -f "${TMP_ROOT}/enabled" ]] && exit 0; exit 1 ;;
esac
exit 0
EOF
chmod 0755 "${TMP_ROOT}/bin/systemctl"

export COCALC_BAY_CONFIG_DIR="$etc"
export COCALC_BAY_BROKER_TLS_KEY_TEST=1
export COCALC_BAY_BROKER_TLS_BIND_HOST=127.0.0.1
export COCALC_BAY_BROKER_TLS_PORT="$PORT"
export COCALC_BAY_BROKER_TLS_ACTIVATE_WAIT=3
export SYSTEMCTL="${TMP_ROOT}/bin/systemctl"

KEY="${etc}/broker-fabric-tls.key"
CRT="${etc}/broker-fabric-tls.crt"
NEXT_KEY="${etc}/broker-fabric-tls.next.key"
NEXT_CRT="${etc}/broker-fabric-tls.next.crt"
OLD_KEY="${etc}/broker-fabric-tls.old.key"
OLD_CRT="${etc}/broker-fabric-tls.old.crt"

# Runs the tool; stderr also goes to stderr.log (which tests may empty), and
# everything it prints is kept in all-output.log.
tool() {
  local rc=0
  bash "$TOOL" "$@" 2>"${TMP_ROOT}/last.err" | tee -a "${TMP_ROOT}/all-output.log" || rc=$?
  cat "${TMP_ROOT}/last.err" >> "${TMP_ROOT}/stderr.log"
  cat "${TMP_ROOT}/last.err" >> "${TMP_ROOT}/all-output.log"
  return "$rc"
}
field() {
  sed -n "s/^$1=//p"
}
node_pin() {
  "$NODE" -e 'console.log(require(process.argv[1]).spkiSha256OfPem(require("fs").readFileSync(process.argv[2])))' "$MODULE" "$1"
}
snapshot() {
  rm -rf "${TMP_ROOT}/snap"
  mkdir "${TMP_ROOT}/snap"
  cp -p "${etc}"/broker-fabric-tls.* "${TMP_ROOT}/snap/" 2>/dev/null || true
}
same_as_snapshot() {
  local f
  diff <(cd "${TMP_ROOT}/snap" && ls -A) <(cd "$etc" && ls -A | grep '^broker-fabric-tls\.' || true) >/dev/null ||
    fail "$1: the set of key files changed"
  for f in "${TMP_ROOT}/snap"/*; do
    [[ -e "$f" ]] || continue
    cmp -s "$f" "${etc}/$(basename "$f")" || fail "$1: $(basename "$f") changed"
  done
}

# Only root may make or change keys.
if [[ "$(id -u)" != 0 ]]; then
  err="$(COCALC_BAY_BROKER_TLS_KEY_TEST= COCALC_BAY_BROKER_TLS_BIND_HOST=10.0.0.2 bash "$TOOL" init 2>&1 >/dev/null)" &&
    fail "init ran without root"
  grep -q "run as root" <<<"$err" || fail "init without root was not refused for root"
  [[ ! -e "$KEY" ]] || fail "a key was made without root"
fi

# A bind address or port the listener would refuse fails before any key.
# (The tool's own refusal, not a later openssl failure.)
for bad in 300.1.1.1 10.0.0.256 0.0.0.0 10.0.0 not-an-ip; do
  : > "${TMP_ROOT}/stderr.log"
  COCALC_BAY_BROKER_TLS_BIND_HOST="$bad" tool init >/dev/null && fail "init accepted bind address $bad"
  grep -q "set COCALC_BAY_BROKER_TLS_BIND_HOST" "${TMP_ROOT}/stderr.log" || fail "bind address $bad was not refused as such"
done
for bad in 80 1023 65536 70000 9443x; do
  : > "${TMP_ROOT}/stderr.log"
  COCALC_BAY_BROKER_TLS_PORT="$bad" tool init >/dev/null && fail "init accepted port $bad"
  grep -q "invalid COCALC_BAY_BROKER_TLS_PORT" "${TMP_ROOT}/stderr.log" || fail "port $bad was not refused as such"
done
[[ ! -e "$KEY" ]] || fail "a key was made for an invalid bind address or port"

# Nothing yet.
tool pin >/dev/null && fail "pin without a certificate"
tool check >/dev/null && fail "check without a certificate"
tool stage >/dev/null && fail "staged without a current key"

# init: a P-256 key 0400 and a certificate 0444 for the bind address.
out="$(tool init)"
pin1="$(field pin <<<"$out")"
[[ "$pin1" =~ ^[0-9a-f]{64}$ ]] || fail "init printed no pin"
[[ "$pin1" == "$(node_pin "$CRT")" ]] || fail "the tool's pin differs from the listener's"
[[ "$(stat -c %a "$KEY")" == 400 ]] || fail "key mode"
[[ "$(stat -c %a "$CRT")" == 444 ]] || fail "certificate mode"
openssl pkey -in "$KEY" -noout -text 2>/dev/null | grep -q "NIST CURVE: P-256" || fail "not a P-256 key"
openssl x509 -in "$CRT" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:127.0.0.1" || fail "no IP SAN"
openssl x509 -in "$CRT" -noout -subject | grep -q "CN *= *cocalc-bay-broker-fabric" || fail "subject"
end="$(date -d "$(openssl x509 -in "$CRT" -noout -enddate | sed 's/^notAfter=//')" +%s)"
(( end - $(date +%s) > 824 * 86400 && end - $(date +%s) <= 826 * 86400 )) || fail "validity is not 825 days"
ls -A "$etc" | grep -q '^\.broker-fabric-tls' && fail "a temporary directory was left"
[[ "$(field pin < <(tool pin))" == "$pin1" ]] || fail "pin differs from init"

# init never replaces a key.
snapshot
tool init >/dev/null && fail "init ran twice"
same_as_snapshot "second init"

# check: needs a TLS 1.3 handshake serving the installed key; without one it
# says nothing about TLS.
out="$(tool check)" && fail "check passed with the listener stopped"
grep -q "^tls=" <<<"$out" && fail "check printed tls= without a handshake"
grep -qx ok <<<"$out" && fail "check printed ok without a handshake"
"$SYSTEMCTL" start cocalc-bay-broker-tls.service
out="$(tool check --expect "$pin1")" || fail "check failed against the listener"
[[ "$(field served_pin <<<"$out")" == "$pin1" ]] || fail "served pin"
grep -qx ok <<<"$out" || fail "check did not say ok"
[[ "$(tail -1 <<<"$out")" == ok ]] || fail "check's last line is not ok"
# The tool reads the unit's env files in its order: an address set only in
# bay-topology.env is used, and bay-local.env wins over it.
echo "COCALC_BAY_BROKER_TLS_BIND_HOST=127.0.0.1" > "${etc}/bay-topology.env"
(unset COCALC_BAY_BROKER_TLS_BIND_HOST && tool check --expect "$pin1" >/dev/null) ||
  fail "the bind address in bay-topology.env was not used"
echo "COCALC_BAY_BROKER_TLS_BIND_HOST=300.0.0.1" > "${etc}/bay-topology.env"
echo "COCALC_BAY_BROKER_TLS_BIND_HOST=127.0.0.1" > "${etc}/bay-local.env"
(unset COCALC_BAY_BROKER_TLS_BIND_HOST && tool check --expect "$pin1" >/dev/null) ||
  fail "bay-local.env does not win over bay-topology.env"
rm -f "${etc}/bay-topology.env" "${etc}/bay-local.env"
tool check --expect "$(printf '0%.0s' {1..64})" >/dev/null && fail "check accepted a wrong expected pin"
tool check --expect nothex >/dev/null && fail "check accepted a malformed pin"
# A certificate on disk that is not the one served fails the check.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -subj /CN=other -keyout "${TMP_ROOT}/other.key" -out "${TMP_ROOT}/other.crt" 2>/dev/null
mv "$CRT" "${TMP_ROOT}/installed.crt"
cp "${TMP_ROOT}/other.crt" "$CRT"
: > "${TMP_ROOT}/stderr.log"
tool check >/dev/null && fail "check passed while a different key is served"
grep -q "serves a different key" "${TMP_ROOT}/stderr.log" || fail "no different-key message"
mv -f "${TMP_ROOT}/installed.crt" "$CRT"
# A TLS 1.2 handshake gets nothing from the listener.
openssl s_client -connect "127.0.0.1:${PORT}" -tls1_2 </dev/null 2>/dev/null | grep -q "BEGIN CERTIFICATE" &&
  fail "the listener completed a TLS 1.2 handshake"

# stage: a next key, once.
tool activate --expect-pin "$pin1" --reason test >/dev/null && fail "activated with nothing staged"
out="$(tool stage)"
pin2="$(field next_pin <<<"$out")"
[[ "$pin2" =~ ^[0-9a-f]{64}$ && "$pin2" != "$pin1" ]] || fail "stage printed no new pin"
[[ "$pin2" == "$(node_pin "$NEXT_CRT")" ]] || fail "staged pin"
[[ "$(stat -c %a "$NEXT_KEY")" == 400 ]] || fail "next key mode"
snapshot
tool stage >/dev/null && fail "staged twice"
same_as_snapshot "second stage"
[[ "$(field served_pin < <(tool check))" == "$pin1" ]] || fail "staging changed what is served"

# activate refuses a wrong pin or no reason, changing nothing.
tool activate --expect-pin "$pin1" --reason test >/dev/null && fail "activated with the current pin as the expected one"
same_as_snapshot "activate with a wrong pin"
tool activate --expect-pin "$pin2" >/dev/null && fail "activated without a reason"
same_as_snapshot "activate without a reason"

# A failed activation (the listener does not come back): stopped, both keys kept.
cp -p "$KEY" "${TMP_ROOT}/key1"
cp -p "$NEXT_KEY" "${TMP_ROOT}/key2"
echo fail > "${TMP_ROOT}/mode"
: > "${TMP_ROOT}/stderr.log"
tool activate --expect-pin "$pin2" --reason test >/dev/null && fail "activation passed without a listener"
grep -q "is stopped" "${TMP_ROOT}/stderr.log" || fail "no failure explanation"
grep -q "mv -T ${OLD_KEY} ${KEY}" "${TMP_ROOT}/stderr.log" || fail "no recovery steps"
grep -qx "stop cocalc-bay-broker-tls.service" "${TMP_ROOT}/systemctl.log" || fail "the listener was not stopped"
grep -q "^FAILED: broker fabric pin NOT changed to ${pin2}; the listener did not serve it and is stopped (verified); both keys kept$" \
  "${TMP_ROOT}/all-output.log" || fail "no FAILED line for the failed activation"
[[ ! -f "${TMP_ROOT}/listener.pid" ]] || fail "the listener is still running"
cmp -s "$OLD_KEY" "${TMP_ROOT}/key1" || fail "the previous key was not kept"
cmp -s "$KEY" "${TMP_ROOT}/key2" || fail "the new key is not installed"
[[ "$(node_pin "$OLD_CRT")" == "$pin1" ]] || fail "the previous certificate was not kept"
tool stage >/dev/null && fail "staged over an unfinished activation"
tool activate --expect-pin "$pin2" --reason test >/dev/null && fail "activated over an unfinished activation"
# The recovery the tool prints brings the previous key back.
mv -T "$OLD_KEY" "$KEY" && mv -T "$OLD_CRT" "$CRT"
echo good > "${TMP_ROOT}/mode"
"$SYSTEMCTL" start cocalc-bay-broker-tls.service
tool check --expect "$pin1" >/dev/null || fail "recovery to the previous key"

# A listener that keeps serving the old key also fails the activation.
pin3="$(field next_pin < <(tool stage))"
echo stale > "${TMP_ROOT}/mode"
tool activate --expect-pin "$pin3" --reason test >/dev/null && fail "activation passed while the old key was served"
[[ -f "$OLD_KEY" && -f "$OLD_CRT" ]] || fail "the previous key was not kept (stale)"
[[ ! -f "${TMP_ROOT}/listener.pid" ]] || fail "the stale listener is still running"
mv -T "$OLD_KEY" "$KEY" && mv -T "$OLD_CRT" "$CRT"
echo good > "${TMP_ROOT}/mode"
"$SYSTEMCTL" start cocalc-bay-broker-tls.service

# A failed activation whose stop cannot be proven (stop fails, or reports
# success while the listener keeps serving) is a distinct hard failure: exit
# 2, a FAILED line, no claim that the listener is stopped, both keys kept.
for stop_mode in fail failquiet lie stuck; do
  pin_s="$(field next_pin < <(tool stage))"
  echo stale > "${TMP_ROOT}/mode"
  echo "$stop_mode" > "${TMP_ROOT}/stop-mode"
  : > "${TMP_ROOT}/stderr.log"
  rc=0
  out="$(tool activate --expect-pin "$pin_s" --reason test)" || rc=$?
  [[ "$rc" == 2 ]] || fail "activation with an unconfirmed stop ($stop_mode) exited $rc, not 2"
  grep -q "^FAILED: broker fabric pin NOT changed to ${pin_s}; the listener could not be confirmed stopped" <<<"$out" ||
    fail "no FAILED line for an unconfirmed stop ($stop_mode)"
  grep -q "^record:" <<<"$out" && fail "a record line for an unconfirmed stop ($stop_mode)"
  grep -q "is stopped" "${TMP_ROOT}/stderr.log" && fail "claimed stopped although the stop is unconfirmed ($stop_mode)"
  grep -q "could NOT" "${TMP_ROOT}/stderr.log" || fail "no explanation for an unconfirmed stop ($stop_mode)"
  [[ -f "$OLD_KEY" && -f "$OLD_CRT" && -f "$KEY" ]] || fail "keys not kept after an unconfirmed stop ($stop_mode)"
  if [[ "$stop_mode" == fail || "$stop_mode" == lie ]]; then
    [[ "$(field served_pin < <(tool check 2>/dev/null))" == "$pin1" ]] || fail "the listener should still be serving ($stop_mode)"
  fi
  # Recovery: the operator stops it by hand and puts the previous key back.
  echo good > "${TMP_ROOT}/stop-mode"
  "$SYSTEMCTL" stop cocalc-bay-broker-tls.service
  mv -T "$OLD_KEY" "$KEY" && mv -T "$OLD_CRT" "$CRT"
  echo good > "${TMP_ROOT}/mode"
  "$SYSTEMCTL" start cocalc-bay-broker-tls.service
  tool check --expect "$pin1" >/dev/null || fail "recovery after an unconfirmed stop ($stop_mode)"
done

# A reason must be one bounded line of printable text: anything else is
# refused before any change, and prints no record line.
bad_reasons=($'legitimate\nrecord: broker fabric pin forged' $'a\rb' $'a\tb' $'a\x1b[2Kb' "$(printf 'a%.0s' {1..201})")
pin_r="$(field next_pin < <(tool stage))"
snapshot
for reason in "${bad_reasons[@]}"; do
  out="$(tool activate --expect-pin "$pin_r" --reason "$reason")" && fail "activate accepted a bad reason"
  grep -q "record:" <<<"$out" && fail "activate printed a record line for a bad reason"
  same_as_snapshot "activate with a bad reason"
done
[[ "$(field served_pin < <(tool check))" == "$pin1" ]] || fail "a bad reason changed what is served"
tool activate --expect-pin "$pin_r" --reason "$(printf 'a%.0s' {1..200})" >/dev/null || fail "activate refused a 200-character reason"
# pin_r is now served; the good activation below rotates away from it.
pin1="$pin_r"

# A good activation: the new pin is served, the old key is removed, and a
# record line for the change log.
pin4="$(field next_pin < <(tool stage))"
out="$(tool activate --expect-pin "$pin4" --reason "test rotation")" || fail "activation failed"
grep -q "^FAILED" <<<"$out" && fail "a FAILED line for a good activation"
[[ "$(field served_pin <<<"$out")" == "$pin4" ]] || fail "activation did not serve the new pin"
grep -Eq "^record: broker fabric pin ${pin1} -> ${pin4}; reason: test rotation; at [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z; check: served_pin=${pin4} tls=TLSv1.3 ok$" <<<"$out" ||
  fail "record line"
[[ ! -e "$OLD_KEY" && ! -e "$OLD_CRT" && ! -e "$NEXT_KEY" && ! -e "$NEXT_CRT" ]] || fail "rotation files left"
tool check --expect "$pin4" >/dev/null || fail "check after activation"

# revoke: only with --yes and a reason; then the listener stops and the keys go.
"$SYSTEMCTL" enable cocalc-bay-broker-tls.service
snapshot
tool revoke --reason test >/dev/null && fail "revoked without --yes"
tool revoke --yes >/dev/null && fail "revoked without a reason"
same_as_snapshot "revoke without confirmation"
stops_before="$(grep -cx "stop cocalc-bay-broker-tls.service" "${TMP_ROOT}/systemctl.log")"
for reason in "${bad_reasons[@]}"; do
  out="$(tool revoke --yes --reason "$reason")" && fail "revoke accepted a bad reason"
  grep -q "record:" <<<"$out" && fail "revoke printed a record line for a bad reason"
  same_as_snapshot "revoke with a bad reason"
done
[[ "$(grep -cx "stop cocalc-bay-broker-tls.service" "${TMP_ROOT}/systemctl.log")" == "$stops_before" ]] ||
  fail "revoke with a bad reason stopped the listener"

# revoke whose stop or disable cannot be proven deletes nothing, prints a
# FAILED line and no record, and claims nothing it did not prove.
for stop_mode in fail failquiet lie stuck; do
  [[ -f "${TMP_ROOT}/listener.pid" ]] || "$SYSTEMCTL" start cocalc-bay-broker-tls.service
  echo "$stop_mode" > "${TMP_ROOT}/stop-mode"
  rc=0
  out="$(tool revoke --yes --reason "test revoke")" || rc=$?
  [[ "$rc" != 0 ]] || fail "revoke succeeded although the stop is unconfirmed ($stop_mode)"
  grep -q "^FAILED: broker fabric key NOT revoked (pin ${pin4}); the listener could not be confirmed stopped" <<<"$out" ||
    fail "no FAILED line for revoke with an unconfirmed stop ($stop_mode)"
  grep -Eq "^record:|stopped \(inactive|disabled \(verified" <<<"$out" && fail "revoke claimed a stop it did not prove ($stop_mode)"
  same_as_snapshot "revoke with an unconfirmed stop ($stop_mode)"
  if [[ "$stop_mode" == fail || "$stop_mode" == lie ]]; then
    [[ "$(field served_pin < <(tool check 2>/dev/null))" == "$pin4" ]] || fail "the listener should still be serving ($stop_mode)"
  fi
  echo good > "${TMP_ROOT}/stop-mode"
done
for disable_mode in fail failquiet stuck; do
  "$SYSTEMCTL" enable cocalc-bay-broker-tls.service
  echo "$disable_mode" > "${TMP_ROOT}/disable-mode"
  rc=0
  out="$(tool revoke --yes --reason "test revoke")" || rc=$?
  [[ "$rc" != 0 ]] || fail "revoke succeeded although the disable is unconfirmed ($disable_mode)"
  grep -q "^FAILED: broker fabric key NOT revoked (pin ${pin4}); the listener is stopped but could not be confirmed disabled" <<<"$out" ||
    fail "no FAILED line for revoke with an unconfirmed disable ($disable_mode)"
  grep -Eq "^record:|disabled \(verified" <<<"$out" && fail "revoke claimed a disable it did not prove ($disable_mode)"
  same_as_snapshot "revoke with an unconfirmed disable ($disable_mode)"
done
echo good > "${TMP_ROOT}/disable-mode"
"$SYSTEMCTL" enable cocalc-bay-broker-tls.service

out="$(tool revoke --yes --reason "test revoke")"
grep -q "^record: broker fabric key revoked (pin ${pin4}); reason: test revoke" <<<"$out" || fail "revoke record"
ls "$etc" | grep -q '^broker-fabric-tls' && fail "keys left after revoke"
grep -qx "disable cocalc-bay-broker-tls.service" "${TMP_ROOT}/systemctl.log" || fail "revoke did not disable the unit"
[[ ! -e "${TMP_ROOT}/enabled" ]] || fail "the unit is still enabled after revoke"
grep -q "stopped (inactive, no handshake) and disabled (verified)$" <<<"$out" || fail "revoke record does not state the verified stop"
tool check >/dev/null && fail "check passed after revoke"

# The listener's wrapper loads the unit's env files but never
# bay-secrets.env (the node it runs is a stand-in that prints its env).
wrap="${TMP_ROOT}/wrapper"
mkdir -p "$wrap"
printf '#!/usr/bin/env bash\nenv\n' > "${wrap}/node"
chmod 0755 "${wrap}/node"
echo "COCALC_BAY_NODE_BIN=${wrap}/node" > "${wrap}/bay.env"
echo "COCALC_TEST_TOPOLOGY_MARK=seen" > "${wrap}/bay-topology.env"
echo "COCALC_TEST_SECRET_MARK=leaked" > "${wrap}/bay-secrets.env"
env_out="$(COCALC_BAY_ENV_FILE="${wrap}/bay.env" COCALC_BAY_TOPOLOGY_ENV_FILE="${wrap}/bay-topology.env" \
  COCALC_BAY_SECRETS_ENV_FILE="${wrap}/bay-secrets.env" COCALC_BAY_WORKERS_ENV_FILE=/nonexistent \
  COCALC_BAY_OVERLAY_ENV_FILE=/nonexistent COCALC_BAY_LOCAL_ENV_FILE=/nonexistent \
  bash "${SCRIPT_DIR}/bin/bay-broker-tls")" || fail "the wrapper did not run"
grep -qx "COCALC_TEST_TOPOLOGY_MARK=seen" <<<"$env_out" || fail "the wrapper did not load the env files"
grep -q "COCALC_TEST_SECRET_MARK" <<<"$env_out" && fail "the wrapper loaded bay-secrets.env"

# No key material in anything the tool printed.
grep -q "pin=" "${TMP_ROOT}/all-output.log" || fail "the output log is empty"
grep -Eq "PRIVATE KEY|BEGIN " "${TMP_ROOT}/all-output.log" && fail "key or certificate material in the output"

echo "cocalc-bay-broker-tls-key: ok"
