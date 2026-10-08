#!/usr/bin/env bash
# Seal, upload, read back, verify, prune and open a bay configuration escrow
# against a file-backed stand-in for R2. Run: bash bay-config-escrow.test.sh
# With passwordless sudo it also checks --chown and the symlink defenses as
# root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'chmod -R u+w "$TMP_ROOT" 2>/dev/null; rm -rf "$TMP_ROOT" 2>/dev/null || sudo -n rm -rf "$TMP_ROOT"' EXIT
NODE="$(readlink -f "$(command -v node)")"
ESCROW="${SCRIPT_DIR}/bay-config-escrow.mjs"
RUN="${SCRIPT_DIR}/bay-config-escrow-run"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

config="${TMP_ROOT}/etc"
mkdir -p "$config" "${TMP_ROOT}/bin" "${TMP_ROOT}/r2"
head -c 32 /dev/urandom | base64 > "${config}/site-master-key"
chmod 0600 "${config}/site-master-key"
KEY="${config}/site-master-key"
printf 'COCALC_BAY_ID=test-bay\n' > "${config}/bay.env"
printf 'COCALC_BAY_PGBACKREST_CIPHER_PASS=very-secret-cipher\nCOCALC_BAY_PGBACKREST_S3_SECRET_KEY=r2-secret\n' > "${config}/bay-secrets.env"
chmod 0600 "${config}/bay-secrets.env"
printf 'COCALC_BAY_PGBACKREST_ENABLED=1\n' > "${config}/bay-local.env"
secrets="${TMP_ROOT}/bay/secrets"
mkdir -p "${secrets}/host-owner-ssh/test-bay" "${secrets}/launchpad-cloudflare/bin/sub" \
  "${secrets}/launchpad-sshd/run"
chmod 0700 "${secrets}/host-owner-ssh" "${secrets}/host-owner-ssh/test-bay"
printf 'project-host-private-key\n' > "${secrets}/project-host-auth-ed25519-private.pem"
printf 'host-owner-private-key\n' > "${secrets}/host-owner-ssh/test-bay/id_ed25519"
chmod 0600 "${secrets}/project-host-auth-ed25519-private.pem" "${secrets}/host-owner-ssh/test-bay/id_ed25519"
printf '{"TunnelSecret":"tunnel-secret"}\n' > "${secrets}/launchpad-cloudflare/credentials.json"
printf '1234\n' > "${secrets}/launchpad-cloudflare/cloudflared.pid"
printf '99\n' > "${secrets}/launchpad-sshd/run/sshd.pid"
printf 'kept\n' > "${secrets}/launchpad-sshd/run/sshd.pidfile"
head -c 2000000 /dev/zero > "${secrets}/launchpad-cloudflare/bin/cloudflared"
printf 'x\n' > "${secrets}/launchpad-cloudflare/bin/sub/nested"

# R2 stand-in: PUT copies into r2/, GET copies out, a ?list-type=2 GET lists
# keys, DELETE removes. Records each command line so the test can prove
# credentials never appear in argv.
cat > "${TMP_ROOT}/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${TMP_ROOT}/curl-argv"
cat > "${TMP_ROOT}/curl-config"
upload="" output="" url="" method=GET
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --upload-file) upload="\$2"; shift 2 ;;
    --output) output="\$2"; shift 2 ;;
    -X) method="\$2"; shift 2 ;;
    --config|--aws-sigv4|--max-time|--retry|--max-filesize) shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
path="\${url#https://example.r2.test/}"
if [[ "\$path" == *'?list-type=2&prefix='* ]]; then
  bucket="\${path%%\?*}"
  prefix="\${path#*prefix=}"
  prefix="\${prefix//%2F//}"
  {
    echo '<ListBucketResult>'
    (cd "${TMP_ROOT}/r2/\$bucket" && find . -type f | sed 's|^\./||' | sort) |
      while read -r key; do [[ "\$key" == "\$prefix"* ]] && echo "<Contents><Key>\$key</Key></Contents>"; done
    echo '</ListBucketResult>'
  } > "\$output"
  exit 0
fi
key="${TMP_ROOT}/r2/\$path"
if [[ "\$method" == DELETE ]]; then
  rm -f "\$key"
elif [[ -n "\$upload" ]]; then
  mkdir -p "\$(dirname "\$key")"
  cp "\$upload" "\$key"
elif [[ -n "\$output" ]]; then
  [[ -f "\$key" ]] || { echo "404" >&2; exit 22; }
  cp "\$key" "\$output"
fi
EOF
chmod 0755 "${TMP_ROOT}/bin/curl"

export COCALC_BAY_ID=test-bay
export COCALC_BAY_ROOT="${TMP_ROOT}/bay"
export COCALC_BAY_CONFIG_ESCROW_STATUS_FILE="${TMP_ROOT}/state/status.json"
export COCALC_BAY_CONFIG_DIR="$config"
export COCALC_BAY_USER=no-such-bay-user
# Some test containers have a group-writable /.
if (( 8#$(stat -c %a /) & 8#022 )); then
  export COCALC_BAY_CONFIG_ESCROW_ASSUME_TRUSTED_DIR=/
fi
export SECRETS="$secrets"
export COCALC_BAY_NODE_BIN="$NODE"
export CURL_BIN="${TMP_ROOT}/bin/curl"
export COCALC_BAY_PGBACKREST_S3_BUCKET=bucket
export COCALC_BAY_PGBACKREST_S3_ENDPOINT=example.r2.test
export COCALC_BAY_PGBACKREST_S3_ACCESS_KEY=access-id
export COCALC_BAY_PGBACKREST_S3_SECRET_KEY='s3cr"et\key'
status="$COCALC_BAY_CONFIG_ESCROW_STATUS_FILE"
history="${TMP_ROOT}/r2/bucket/cocalc-escrow/test-bay/history"
run() {
  bash "$RUN" >/dev/null 2>"${TMP_ROOT}/run-err"
}

# Old dated copies are pruned; recent ones stay.
mkdir -p "$history"
printf 'old\n' > "${history}/2001-01-01.json"
recent="$(date -u -d '-3 days' +%F)"
printf 'recent\n' > "${history}/${recent}.json"

run || { cat "${TMP_ROOT}/run-err" "$status" >&2 || true; fail "escrow run failed"; }
grep -q '"level": "ok"' "$status" || fail "status is not ok"
grep -q '"verified": true' "$status" || fail "status not verified"
grep -q '"history_pruned": 1' "$status" || fail "history not pruned: $(cat "$status")"
[[ "$(stat -c %a "$status")" == 644 ]] || fail "status must be readable by the hub"
[[ ! -e "${history}/2001-01-01.json" ]] || fail "old history copy kept"
[[ -f "${history}/${recent}.json" ]] || fail "recent history copy deleted"
sealed="${TMP_ROOT}/r2/bucket/cocalc-escrow/test-bay/bay-config.v1.json"
[[ -f "$sealed" ]] || fail "escrow not uploaded"
[[ -f "${history}/$(date -u +%F).json" ]] || fail "no dated copy"
ls -A "${TMP_ROOT}/state" | grep -q '^\.status' && fail "status temp file left behind"

# Secrets, their names and the master key never appear in plaintext or on a
# command line.
for secret in very-secret-cipher r2-secret project-host-private-key tunnel-secret \
  id_ed25519 credentials.json "$(cat "$KEY")"; do
  ! grep -qF "$secret" "$sealed" || fail "plaintext in escrow: $secret"
done
! grep -qF 's3cr' "${TMP_ROOT}/curl-argv" || fail "R2 secret on curl command line"
grep -qF 'user = "access-id:s3cr\"et\\key"' "${TMP_ROOT}/curl-config" || fail "curl config quoting"
info="$("$NODE" "$ESCROW" info --in "$sealed")"
[[ "$info" == *'"authenticated": false'* && "$info" != *file_names* ]] || fail "unauthenticated info: $info"
names="$("$NODE" "$ESCROW" info --in "$sealed" --master-key "$KEY")"
[[ "$names" == *'"authenticated": true'* ]] || fail "authenticated info: $names"
[[ "$names" == *'"bay-secrets/host-owner-ssh/test-bay/id_ed25519"'* ]] || fail "nested secret missing"
[[ "$names" == *'"bay-secrets/launchpad-sshd/run/sshd.pidfile"'* ]] || fail "near-miss of *.pid excluded"
for excluded in cloudflared.pid sshd.pid'"' bin/cloudflared bin/sub site-master-key; do
  [[ "$names" != *"$excluded"* ]] || fail "escrowed an excluded file: $excluded"
done

# A fresh machine opens it with only the master key; modes of files and of
# directories come back as they were.
"$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" --out-dir "${TMP_ROOT}/restored" >/dev/null
restored="${TMP_ROOT}/restored"
cmp "${config}/bay-secrets.env" "${restored}/etc-cocalc/bay-secrets.env" || fail "secrets differ"
cmp "${config}/bay.env" "${restored}/etc-cocalc/bay.env" || fail "bay.env differs"
[[ "$(stat -c %a "${restored}/etc-cocalc/bay-secrets.env")" == 600 ]] || fail "secrets mode"
cmp "${secrets}/host-owner-ssh/test-bay/id_ed25519" \
  "${restored}/bay-secrets/host-owner-ssh/test-bay/id_ed25519" || fail "nested secret differs"
[[ "$(stat -c %a "${restored}/bay-secrets/host-owner-ssh")" == 700 ]] || fail "directory mode"
[[ "$(stat -c %a "${restored}/bay-secrets")" == "$(stat -c %a "$secrets")" ]] || fail "root directory mode"
! "$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" --out-dir "$restored" 2>/dev/null ||
  fail "open must not overwrite"
"$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" --out-dir "$restored" --force >/dev/null ||
  fail "open --force"
ls -A "${restored}/bay-secrets" | grep -q '\.escrow-' && fail "temporary file left behind"

# --map never follows a symbolic link in the destination: not in a component
# below the mapped directory, and not the mapped directory itself.
mkdir -p "${TMP_ROOT}/map" "${TMP_ROOT}/outside"
ln -s "${TMP_ROOT}/outside" "${TMP_ROOT}/map/host-owner-ssh"
out="$("$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" \
  --map "etc-cocalc=${TMP_ROOT}/map-etc" --map "bay-secrets=${TMP_ROOT}/map" 2>&1)" &&
  fail "followed a symlink in the destination"
[[ "$out" == *"symbolic links are refused"* ]] || fail "destination symlink message: $out"
[[ -z "$(ls -A "${TMP_ROOT}/outside")" ]] || fail "wrote through a symlink"
[[ ! -e "${TMP_ROOT}/map-etc" ]] || fail "a refused open wrote files"
ln -s "${TMP_ROOT}/outside" "${TMP_ROOT}/map-link"
! "$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" \
  --map "etc-cocalc=${TMP_ROOT}/map-etc" --map "bay-secrets=${TMP_ROOT}/map-link" 2>/dev/null ||
  fail "followed a symlinked destination root"
[[ -z "$(ls -A "${TMP_ROOT}/outside")" ]] || fail "wrote through a symlinked root"
# A symlink where a file will go is refused even with --force.
mkdir -p "${TMP_ROOT}/map2"
ln -s "${TMP_ROOT}/outside/target" "${TMP_ROOT}/map2/conat-password"
printf 'conat\n' > "${secrets}/conat-password"
run || fail "rerun with conat-password"
! "$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" --force \
  --map "etc-cocalc=${TMP_ROOT}/map2-etc" --map "bay-secrets=${TMP_ROOT}/map2" 2>/dev/null ||
  fail "replaced a symlink"
[[ ! -e "${TMP_ROOT}/outside/target" ]] || fail "wrote through a final symlink"

# --chown is root only; it is never silently ignored.
if [[ "$(id -u)" != 0 ]]; then
  out="$("$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" \
    --out-dir "${TMP_ROOT}/chowned" --chown 2>&1)" && fail "--chown accepted as non-root"
  [[ "$out" == *"must be run as root"* ]] || fail "--chown message: $out"
fi

# Ownership with injected root operations: a created mapped root and created
# directories get their recorded owner; existing directories are left alone.
mkdir "${TMP_ROOT}/injected"
"$NODE" --input-type=module -e "
  import { collect, restore } from '${ESCROW}';
  const system = {
    users: { byName: new Map([['alice', { id: 1001, gid: 1001 }], ['bob', { id: 1002, gid: 1002 }]]), byId: new Map() },
    groups: { byName: new Map([['alice', { id: 1001 }], ['staff', { id: 50 }]]), byId: new Map() },
  };
  const calls = [];
  const payload = {
    dirs: [
      { root: 's', path: '', mode: 0o755, owner: 'alice', group: 'alice' },
      { root: 's', path: 'keys', mode: 0o700, owner: 'bob', group: 'staff' },
    ],
    files: [{ root: 's', path: 'keys/k', mode: 0o600, owner: 'bob', group: 'staff', content: Buffer.from('k') }],
  };
  const result = restore(payload, new Map([['s', '${TMP_ROOT}/injected/s']]), {
    chown: true, system, getuid: () => 0,
    fchown: (fd, uid, gid) => calls.push(['file', uid, gid]),
    pathChown: (path, uid, gid) => calls.push(['dir', uid, gid]),
  });
  const want = JSON.stringify([['dir', 1001, 1001], ['dir', 1002, 50], ['file', 1002, 50]]);
  if (JSON.stringify(calls) !== want) { console.error('chown calls', JSON.stringify(calls)); process.exit(1); }
  if (result.created.length !== 2) { console.error('created', result.created); process.exit(1); }
  // Unknown owners are refused before anything is written.
  try {
    restore({ dirs: [], files: [{ root: 's', path: 'x', mode: 0o600, owner: 'nobody-here', group: null, content: Buffer.from('x') }] },
      new Map([['s', '${TMP_ROOT}/injected/t']]), { chown: true, system, getuid: () => 0, fchown() {}, pathChown() {} });
    console.error('unknown owner accepted'); process.exit(1);
  } catch (err) {
    if (!/not a local user/.test(err.message)) throw err;
  }
" || fail "injected --chown"
[[ ! -e "${TMP_ROOT}/injected/t" ]] || fail "refused --chown wrote files"

# Symbolic links, symlinked directories and FIFOs in the source are refused
# rather than followed, and a FIFO does not block the walk.
for kind in link dirlink fifo; do
  case "$kind" in
    link) ln -s /etc/passwd "${secrets}/bad" ;;
    dirlink) ln -s /etc "${secrets}/bad" ;;
    fifo) mkfifo "${secrets}/bad" ;;
  esac
  timeout 30 bash "$RUN" >/dev/null 2>&1 && fail "source $kind accepted"
  grep -q 'non-regular file' "$status" || fail "source $kind error not reported: $(cat "$status")"
  rm "${secrets}/bad"
done
mv "$secrets" "${TMP_ROOT}/bay/real-secrets"
ln -s "${TMP_ROOT}/bay/real-secrets" "$secrets"
run && fail "a symlinked secrets directory was followed"
rm "$secrets"
mv "${TMP_ROOT}/bay/real-secrets" "$secrets"
run || fail "rerun after symlink removal"

# Bounds are enforced while walking.
head -c $((1024 * 1024 + 1)) /dev/zero > "${secrets}/big"
run && fail "oversized file accepted"
grep -q 'too large' "$status" || fail "size error not reported"
rm "${secrets}/big"
mkdir "${secrets}/many"
for i in $(seq 1 300); do : > "${secrets}/many/f$i"; done
run && fail "too many files accepted"
grep -q 'too many files' "$status" || fail "count error not reported"
rm -rf "${secrets}/many"
head -c $((9 * 1024 * 1024)) /dev/zero > "${TMP_ROOT}/huge.json"
out="$("$NODE" "$ESCROW" open --master-key "$KEY" --in "${TMP_ROOT}/huge.json" --out-dir "${TMP_ROOT}/h" 2>&1)" &&
  fail "huge envelope accepted"
[[ "$out" == *"not an escrow"* ]] || fail "huge envelope message: $out"

# A decrypted payload is validated before anything is written.
"$NODE" --input-type=module -e "
  import { createHash } from 'node:crypto';
  import { checkPayload } from '${ESCROW}';
  const file = (path, extra = {}) => ({ root: 's', path, mode: 0o600, owner: null, group: null,
    sha256: createHash('sha256').update('x').digest('hex'), content: Buffer.from('x').toString('base64'), ...extra });
  const bad = {
    traversal: { files: [file('../x')] },
    absolute: { files: [file('/etc/x')] },
    duplicate: { files: [file('a'), file('a')] },
    under_file: { files: [file('a'), file('a/b')] },
    mode: { files: [file('a', { mode: 0o4755 })] },
    owner: { files: [file('a', { owner: 'x;rm' })] },
    checksum: { files: [file('a', { sha256: '0'.repeat(64) })] },
    shape: { files: 'nope' },
    too_many: { files: Array.from({ length: 300 }, (_, i) => file('f' + i)) },
  };
  for (const [name, payload] of Object.entries(bad)) {
    let ok = false;
    try { checkPayload(payload, { decode: true }); ok = true; } catch {}
    if (ok) { console.error('accepted malformed payload: ' + name); process.exit(1); }
  }
" || fail "payload validation"

# The wrong master key is named as such.
head -c 32 /dev/urandom | base64 > "${TMP_ROOT}/other-key"
out="$("$NODE" "$ESCROW" open --master-key "${TMP_ROOT}/other-key" --in "$sealed" \
  --out-dir "${TMP_ROOT}/x" 2>&1)" && fail "wrong key accepted"
[[ "$out" == *"different site master key"* ]] || fail "wrong-key message: $out"

# Tampering with any metadata, including host, or the ciphertext is detected.
for edit in 's/"bay_id": "test-bay"/"bay_id": "other-bay"/' \
  's/"host": "[^"]*"/"host": "forged-host"/' \
  's/"ciphertext": "\(.\)/"ciphertext": "A\1/'; do
  sed "$edit" "$sealed" > "${TMP_ROOT}/tampered.json"
  ! cmp -s "$sealed" "${TMP_ROOT}/tampered.json" || fail "tamper edit did nothing: $edit"
  out="$("$NODE" "$ESCROW" open --master-key "$KEY" \
    --in "${TMP_ROOT}/tampered.json" --out-dir "${TMP_ROOT}/y" 2>&1)" && fail "tampered escrow accepted: $edit"
  [[ "$out" == *"corrupt or was modified"* ]] || fail "tamper message: $out"
done

# verify notices a changed file or mode, so a stale escrow cannot pass as
# current.
verify() {
  "$NODE" "$ESCROW" verify --master-key "$KEY" --in "$sealed" \
    --include "etc-cocalc=${config}/bay.env" --include "etc-cocalc=${config}/bay-local.env" \
    --include "etc-cocalc=${config}/bay-secrets.env" --include "bay-secrets=${secrets}" \
    --exclude 'launchpad-cloudflare/bin' --exclude '**/*.pid' >/dev/null 2>&1
}
verify || fail "verify of an unchanged tree"
chmod 0640 "${secrets}/conat-password"
verify && fail "verify missed a mode change"
chmod 0600 "${secrets}/conat-password"
printf 'COCALC_BAY_PGBACKREST_CIPHER_PASS=rotated\n' > "${config}/bay-secrets.env"
verify && fail "verify missed a changed file"

# Root refuses to run programs, or read the master key, from a path the bay
# account or anyone else could change.
mkdir -p "${TMP_ROOT}/writable"
chmod 0777 "${TMP_ROOT}/writable"
ln -s "$NODE" "${TMP_ROOT}/writable/node"
COCALC_BAY_NODE_BIN="${TMP_ROOT}/writable/node" bash "$RUN" >/dev/null 2>"${TMP_ROOT}/run-err" &&
  fail "ran node from a world-writable directory"
grep -q 'refusing to trust' "${TMP_ROOT}/run-err" || fail "trust message: $(cat "${TMP_ROOT}/run-err")"
COCALC_BAY_USER="$(id -un)" bash "$RUN" >/dev/null 2>"${TMP_ROOT}/run-err" &&
  fail "trusted files owned by the bay account"
grep -q "owned by $(id -un)" "${TMP_ROOT}/run-err" || fail "owner message: $(cat "${TMP_ROOT}/run-err")"

# A failed upload records an error status for the health check.
CURL_BIN=false bash "$RUN" >/dev/null 2>&1 && fail "upload failure not reported"
grep -q '"level": "error"' "$status" || fail "error status missing"

# The same defenses as root, with real ownership.
if sudo -n true 2>/dev/null; then
  me="$(id -un)"
  run || fail "rerun before root checks"
  # The parent of a mapped directory must already exist.
  mkdir "${TMP_ROOT}/root"
  sudo -n "$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" \
    --map "etc-cocalc=${TMP_ROOT}/root/etc" --map "bay-secrets=${TMP_ROOT}/root/secrets" --chown >/dev/null ||
    fail "root open --chown"
  [[ "$(stat -c %U "${TMP_ROOT}/root/secrets")" == "$me" ]] || fail "created root dir owner"
  [[ "$(stat -c %U "${TMP_ROOT}/root/secrets/host-owner-ssh/test-bay/id_ed25519")" == "$me" ]] || fail "file owner"
  [[ "$(stat -c %U "${TMP_ROOT}/root")" == "$me" ]] || fail "existing parent was re-owned"
  [[ "$(stat -c %a "${TMP_ROOT}/root/secrets/host-owner-ssh")" == 700 ]] || fail "root dir mode"
  sudo -n "$NODE" "$ESCROW" open --master-key "$KEY" --in "$sealed" \
    --map "etc-cocalc=${TMP_ROOT}/map-etc" --map "bay-secrets=${TMP_ROOT}/map" --chown >/dev/null 2>&1 &&
    fail "root followed a destination symlink"
  [[ -z "$(ls -A "${TMP_ROOT}/outside")" ]] || fail "root wrote through a symlink"
  sudo -n rm -rf "${TMP_ROOT}/root"
else
  echo "note: no passwordless sudo; skipped the as-root checks" >&2
fi

# The key derivation matches the server's deriveSiteMasterKey, if built.
UTIL="${SCRIPT_DIR}/../../../packages/util/dist/master-key-lifecycle.js"
if [[ -f "$UTIL" ]]; then
  "$NODE" --input-type=module -e "
    import { createRequire } from 'node:module';
    import { deriveEscrowKey } from '${ESCROW}';
    const { deriveSiteMasterKey } = createRequire(import.meta.url)('${UTIL}');
    const key = Buffer.alloc(32, 7);
    if (!deriveEscrowKey(key).equals(deriveSiteMasterKey(key, 'bay-config-escrow:v1'))) {
      console.error('derivation mismatch'); process.exit(1);
    }" || fail "key derivation differs from deriveSiteMasterKey"
else
  echo "note: util not built; skipped derivation cross-check" >&2
fi

echo "bay-config-escrow tests passed"
