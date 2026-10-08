#!/usr/bin/env bash
# Seal, upload, read back, verify and open a bay configuration escrow against
# a file-backed stand-in for R2. Run: bash bay-config-escrow.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
NODE="$(command -v node)"
ESCROW="${SCRIPT_DIR}/bay-config-escrow.mjs"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

config="${TMP_ROOT}/etc"
mkdir -p "$config" "${TMP_ROOT}/bin" "${TMP_ROOT}/r2"
head -c 32 /dev/urandom | base64 > "${config}/site-master-key"
printf 'COCALC_BAY_ID=test-bay\n' > "${config}/bay.env"
printf 'COCALC_BAY_PGBACKREST_CIPHER_PASS=very-secret-cipher\nCOCALC_BAY_PGBACKREST_S3_SECRET_KEY=r2-secret\n' > "${config}/bay-secrets.env"
chmod 0600 "${config}/bay-secrets.env"
printf 'COCALC_BAY_PGBACKREST_ENABLED=1\n' > "${config}/bay-local.env"

# R2 stand-in: PUT copies into r2/, GET copies out. Records each command line
# so the test can prove credentials never appear in argv.
cat > "${TMP_ROOT}/bin/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${TMP_ROOT}/curl-argv"
cat > "${TMP_ROOT}/curl-config"
upload="" output="" url=""
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --upload-file) upload="\$2"; shift 2 ;;
    --output) output="\$2"; shift 2 ;;
    --config|--aws-sigv4|--max-time|--retry) shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
key="${TMP_ROOT}/r2/\${url#https://example.r2.test/}"
if [[ -n "\$upload" ]]; then
  mkdir -p "\$(dirname "\$key")"
  cp "\$upload" "\$key"
elif [[ -n "\$output" ]]; then
  [[ -f "\$key" ]] || { echo "404" >&2; exit 22; }
  cp "\$key" "\$output"
fi
EOF
chmod 0755 "${TMP_ROOT}/bin/curl"

export COCALC_BAY_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_WORKERS_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_OVERLAY_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_SECRETS_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_LOCAL_ENV_FILE="${TMP_ROOT}/missing.env"
export COCALC_BAY_ID=test-bay
export COCALC_BAY_ROOT="${TMP_ROOT}/bay"
export COCALC_BAY_STATE_DIR="${TMP_ROOT}/state"
export COCALC_BAY_CONFIG_DIR="$config"
export COCALC_BAY_NODE_BIN="$NODE"
export CURL_BIN="${TMP_ROOT}/bin/curl"
export COCALC_BAY_PGBACKREST_S3_BUCKET=bucket
export COCALC_BAY_PGBACKREST_S3_ENDPOINT=example.r2.test
export COCALC_BAY_PGBACKREST_S3_ACCESS_KEY=access-id
export COCALC_BAY_PGBACKREST_S3_SECRET_KEY='s3cr"et\key'

bash "${SCRIPT_DIR}/bay-config-escrow-run" >/dev/null 2>&1 || {
  cat "${TMP_ROOT}/state/config-escrow-status.json" >&2 || true
  fail "escrow run failed"
}
status="${TMP_ROOT}/state/config-escrow-status.json"
grep -q '"level": "ok"' "$status" || fail "status is not ok"
grep -q '"verified": true' "$status" || fail "status not verified"
[[ "$(stat -c %a "$status")" == 644 ]] || fail "status must be readable by the hub"
sealed="${TMP_ROOT}/r2/bucket/cocalc-escrow/test-bay/bay-config.v1.json"
[[ -f "$sealed" ]] || fail "escrow not uploaded"
[[ -f "${TMP_ROOT}/r2/bucket/cocalc-escrow/test-bay/history/$(date -u +%F).json" ]] || fail "no dated copy"

# Secrets and the master key never appear in plaintext or on a command line.
for secret in very-secret-cipher r2-secret "$(cat "${config}/site-master-key")"; do
  ! grep -qF "$secret" "$sealed" || fail "plaintext secret in escrow"
done
! grep -qF 's3cr' "${TMP_ROOT}/curl-argv" || fail "R2 secret on curl command line"
grep -qF 'user = "access-id:s3cr\"et\\key"' "${TMP_ROOT}/curl-config" || fail "curl config quoting"
grep -q '"file_names"' "$sealed" || fail "missing file names"
grep -q 'site-master-key' "$sealed" && fail "the master key must not be escrowed"

# A fresh machine opens it with only the master key.
"$NODE" "$ESCROW" open --master-key "${config}/site-master-key" --in "$sealed" \
  --out-dir "${TMP_ROOT}/restored" >/dev/null
cmp "${config}/bay-secrets.env" "${TMP_ROOT}/restored/bay-secrets.env" || fail "secrets differ"
cmp "${config}/bay.env" "${TMP_ROOT}/restored/bay.env" || fail "bay.env differs"
[[ "$(stat -c %a "${TMP_ROOT}/restored/bay-secrets.env")" == 600 ]] || fail "secrets mode"
! "$NODE" "$ESCROW" open --master-key "${config}/site-master-key" --in "$sealed" \
  --out-dir "${TMP_ROOT}/restored" 2>/dev/null || fail "open must not overwrite"

# The wrong master key is named as such.
head -c 32 /dev/urandom | base64 > "${TMP_ROOT}/other-key"
out="$("$NODE" "$ESCROW" open --master-key "${TMP_ROOT}/other-key" --in "$sealed" \
  --out-dir "${TMP_ROOT}/x" 2>&1)" && fail "wrong key accepted"
[[ "$out" == *"different site master key"* ]] || fail "wrong-key message: $out"

# Tampering with the metadata or the ciphertext is detected.
for edit in 's/"bay_id": "test-bay"/"bay_id": "other-bay"/' 's/"ciphertext": "\(.\)/"ciphertext": "A\1/'; do
  sed "$edit" "$sealed" > "${TMP_ROOT}/tampered.json"
  ! cmp -s "$sealed" "${TMP_ROOT}/tampered.json" || fail "tamper edit did nothing: $edit"
  out="$("$NODE" "$ESCROW" open --master-key "${config}/site-master-key" \
    --in "${TMP_ROOT}/tampered.json" --out-dir "${TMP_ROOT}/y" 2>&1)" && fail "tampered escrow accepted"
  [[ "$out" == *"corrupt or was modified"* ]] || fail "tamper message: $out"
done

# verify notices a live change, so a stale escrow cannot pass as current.
printf 'COCALC_BAY_PGBACKREST_CIPHER_PASS=rotated\n' > "${config}/bay-secrets.env"
! "$NODE" "$ESCROW" verify --master-key "${config}/site-master-key" --in "$sealed" \
  "${config}/bay.env" "${config}/bay-local.env" "${config}/bay-secrets.env" 2>/dev/null ||
  fail "verify missed a changed file"

# A failed upload records an error status for the health check.
export CURL_BIN=false
! bash "${SCRIPT_DIR}/bay-config-escrow-run" >/dev/null 2>&1 || fail "upload failure not reported"
grep -q '"level": "error"' "$status" || fail "error status missing"

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
