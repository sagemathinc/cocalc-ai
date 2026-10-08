#!/usr/bin/env bash
# Site master key rotation on a bay (sbin/cocalc-bay-master-key) against a
# temporary /etc/cocalc, cross-checked with @cocalc/util/master-key-lifecycle
# so both read and write the same key files. Needs packages/util built.
# Run: bash cocalc-bay-master-key.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SCRIPT_DIR}/sbin/cocalc-bay-master-key"
UTIL="${SCRIPT_DIR}/../../packages/util/dist/master-key-lifecycle.js"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
NODE="$(readlink -f "$(command -v node)")"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ -f "$UTIL" ]] || { echo "note: build packages/util first; skipped" >&2; exit 0; }

etc="${TMP_ROOT}/etc"
mkdir -p "$etc" "${TMP_ROOT}/bin"
head -c 32 /dev/urandom | base64 > "${etc}/site-master-key"
chmod 0600 "${etc}/site-master-key"
printf 'COCALC_BAY_NODE_BIN="%s"\n' "$NODE" > "${etc}/bay.env"
cat > "${TMP_ROOT}/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${TMP_ROOT}/systemctl.log"
case "\$1" in
  list-units) echo "cocalc-bay-hub@1.service loaded active running hub"; echo "cocalc-bay-hub@2.service loaded active running hub" ;;
  is-active) [[ "\$3" == cocalc-bay-frontdoor.service ]]; exit \$? ;;
esac
exit 0
EOF
# The database report a dry-run reencrypt would print: rows under each key.
cat > "${TMP_ROOT}/bin/systemd-run" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "${TMP_ROOT}/systemd-run.log"
cat "${TMP_ROOT}/report.json"
EOF
chmod 0755 "${TMP_ROOT}/bin/"*

export COCALC_BAY_CONFIG_DIR="$etc"
export COCALC_BAY_MASTER_KEY_TEST=1
export COCALC_BAY_USER=no-such-bay-user
export SYSTEMCTL="${TMP_ROOT}/bin/systemctl"
export SYSTEMD_RUN="${TMP_ROOT}/bin/systemd-run"
export COCALC_BAY_MASTER_KEY_RESTART_PAUSE=0
# Some test containers have a group-writable /.
if (( 8#$(stat -c %a /) & 8#022 )); then
  export COCALC_BAY_MASTER_KEY_ASSUME_TRUSTED_DIR=/
fi
util() {
  "$NODE" -e "
    const u = require('${UTIL}');
    const opts = { siteMasterKeyPath: '${etc}/site-master-key', keyringPath: '${etc}/site-master-key.keyring' };
    (async () => { console.log(JSON.stringify(await (${1}))); })().catch((e) => { console.error(e.message); process.exit(1); });"
}
field() {
  "$NODE" -e "let t='';process.stdin.on('data',d=>t+=d).on('end',()=>console.log(eval('(j)=>j.' + process.argv[1])(JSON.parse(t))))" "$1"
}

id1="$(bash "$TOOL" status | field active_id)"
[[ "$id1" == "$(util "u.siteMasterKeyId(require('fs').readFileSync(opts.siteMasterKeyPath,'utf8').trim() && Buffer.from(require('fs').readFileSync(opts.siteMasterKeyPath,'utf8').trim(),'base64'))" | tr -d '"')" ]] ||
  fail "key id differs from util"

# prepare: the backup copy and a staged next key, which util reads the same way.
out="$(bash "$TOOL" prepare --export "${TMP_ROOT}/new-key" 2>/dev/null)"
id2="$(field staged <<<"$out")"
[[ "$(stat -c %a "${TMP_ROOT}/new-key")" == 600 ]] || fail "export file mode"
[[ "$(stat -c %a "${etc}/site-master-key.keyring")" == 600 ]] || fail "keyring mode"
[[ "$(util "u.getSiteMasterKeyring(opts).then(k => k.map(e => e.role + ':' + e.id).join(' '))" | tr -d '"')" == "active:${id1} next:${id2}" ]] ||
  fail "util does not read the staged key"
bash "$TOOL" prepare --export "${TMP_ROOT}/again" >/dev/null 2>&1 && fail "staged a second next key"
[[ ! -e "${TMP_ROOT}/again" ]] || fail "exported a key that was not staged"

# activate needs the explicit backup confirmation.
bash "$TOOL" activate "$id2" >/dev/null 2>&1 && fail "activated without --backed-up"
bash "$TOOL" activate "$id2" --backed-up >/dev/null 2>&1 || fail "activate"
cmp -s <(tr -d '\n' < "${TMP_ROOT}/new-key") <(tr -d '\n' < "${etc}/site-master-key") || fail "active key is not the exported key"
[[ "$(util "u.getSiteMasterKeyring(opts).then(k => k.map(e => e.role + ':' + e.id).join(' '))" | tr -d '"')" == "active:${id2} retired:${id1}" ]] ||
  fail "after activate"

# util stages, this tool activates (a rollback to the retired key works too).
id3="$(util "u.stageNextSiteMasterKey(opts).then(r => r.id)" | tr -d '"')"
bash "$TOOL" activate "$id3" --backed-up >/dev/null 2>&1 || fail "activate a util-staged key"
bash "$TOOL" activate "$id2" --backed-up >/dev/null 2>&1 || fail "roll back"
[[ "$(bash "$TOOL" status | field active_id)" == "$id2" ]] || fail "rollback active key"

# retire refuses while the database still has rows under the key.
printf '{"tables":[{"table":"t","by_key":{"%s":3}}]}' "$id1" > "${TMP_ROOT}/report.json"
out="$(bash "$TOOL" retire "$id1" 2>&1)" && fail "retired a key still in use"
[[ "$out" == *"3 rows are still encrypted under ${id1}"* ]] || fail "retire message: $out"
grep -q 'LoadCredential=site-master-key.keyring:' "${TMP_ROOT}/systemd-run.log" || fail "database check without the keyring credential"
grep -q 'User=no-such-bay-user' "${TMP_ROOT}/systemd-run.log" || fail "database check not run as the bay user"
printf '{"tables":[{"table":"t","by_key":{"%s":0}}]}' "$id1" > "${TMP_ROOT}/report.json"
bash "$TOOL" retire "$id1" >/dev/null 2>&1 || fail "retire an unused key"
bash "$TOOL" retire "$id2" >/dev/null 2>&1 && fail "retired the active key"
[[ "$(util "u.getSiteMasterKeyring(opts).then(k => k.map(e => e.role + ':' + e.id).join(' '))" | tr -d '"')" == "active:${id2} retired:${id3}" ]] ||
  fail "after retire"

# restart: hub workers one at a time, then the other key consumers.
bash "$TOOL" restart >/dev/null
[[ "$(grep '^restart' "${TMP_ROOT}/systemctl.log" | tr '\n' ' ')" == "restart cocalc-bay-hub@1.service restart cocalc-bay-hub@2.service restart cocalc-bay-frontdoor.service " ]] ||
  fail "restart order: $(cat "${TMP_ROOT}/systemctl.log")"

# Root refuses to run node from a directory others can write.
mkdir -p "${TMP_ROOT}/open"
chmod 0777 "${TMP_ROOT}/open"
ln -s "$NODE" "${TMP_ROOT}/open/node"
out="$(COCALC_BAY_NODE_BIN="${TMP_ROOT}/open/node" bash "$TOOL" status 2>&1)" && fail "ran an untrusted node"
[[ "$out" == *"refusing to run"* ]] || fail "trust message: $out"

# A corrupted keyring is reported, not silently ignored.
printf 'AAAA retired\n' >> "${etc}/site-master-key.keyring"
bash "$TOOL" status >/dev/null 2>&1 && fail "accepted a corrupt keyring"

echo "cocalc-bay-master-key tests passed"
