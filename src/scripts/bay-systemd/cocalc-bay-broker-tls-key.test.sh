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
# serving the key it started with ("stale").
cat > "${TMP_ROOT}/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${TMP_ROOT}/systemctl.log"
mode="\$(cat "${TMP_ROOT}/mode" 2>/dev/null || echo good)"
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
  stop) stop ;;
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
  COCALC_BAY_BROKER_TLS_KEY_TEST= bash "$TOOL" init >/dev/null 2>&1 && fail "init ran without root"
  [[ ! -e "$KEY" ]] || fail "a key was made without root"
fi

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

# check: needs a TLS 1.3 handshake serving the installed key.
tool check >/dev/null && fail "check passed with the listener stopped"
"$SYSTEMCTL" start cocalc-bay-broker-tls.service
out="$(tool check --expect "$pin1")" || fail "check failed against the listener"
[[ "$(field served_pin <<<"$out")" == "$pin1" ]] || fail "served pin"
grep -qx ok <<<"$out" || fail "check did not say ok"
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
tail -1 "${TMP_ROOT}/systemctl.log" | grep -qx "stop cocalc-bay-broker-tls.service" || fail "the listener was not stopped"
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

# A good activation: the new pin is served, the old key is removed, and a
# record line for the change log.
pin4="$(field next_pin < <(tool stage))"
out="$(tool activate --expect-pin "$pin4" --reason "test rotation")" || fail "activation failed"
[[ "$(field served_pin <<<"$out")" == "$pin4" ]] || fail "activation did not serve the new pin"
grep -Eq "^record: broker fabric pin ${pin1} -> ${pin4}; reason: test rotation; at [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z; check: served_pin=${pin4} tls=TLSv1.3 ok$" <<<"$out" ||
  fail "record line"
[[ ! -e "$OLD_KEY" && ! -e "$OLD_CRT" && ! -e "$NEXT_KEY" && ! -e "$NEXT_CRT" ]] || fail "rotation files left"
tool check --expect "$pin4" >/dev/null || fail "check after activation"

# revoke: only with --yes and a reason; then the listener stops and the keys go.
snapshot
tool revoke --reason test >/dev/null && fail "revoked without --yes"
tool revoke --yes >/dev/null && fail "revoked without a reason"
same_as_snapshot "revoke without confirmation"
out="$(tool revoke --yes --reason "test revoke")"
grep -q "^record: broker fabric key revoked (pin ${pin4}); reason: test revoke" <<<"$out" || fail "revoke record"
ls "$etc" | grep -q '^broker-fabric-tls' && fail "keys left after revoke"
grep -qx "disable cocalc-bay-broker-tls.service" "${TMP_ROOT}/systemctl.log" || fail "revoke did not disable the unit"
tool check >/dev/null && fail "check passed after revoke"

# No key material in anything the tool printed.
grep -q "pin=" "${TMP_ROOT}/all-output.log" || fail "the output log is empty"
grep -Eq "PRIVATE KEY|BEGIN " "${TMP_ROOT}/all-output.log" && fail "key or certificate material in the output"

echo "cocalc-bay-broker-tls-key: ok"
