#!/usr/bin/env bash
set -euo pipefail

# Tests cocalc-star-docker-hub-env.sh (#1619): only allowlisted variables reach
# the hub's systemd drop-in, values are validated and never logged.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_ENV="${SCRIPT_DIR}/cocalc-star-docker-hub-env.sh"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

DIR="${TMP}/cocalc-star-hub.service.d"
DROPIN="${DIR}/docker-env.conf"

run() {
  env -i PATH="$PATH" COCALC_STAR_DOCKER_HUB_DROPIN_DIR="$DIR" "$@" \
    bash "$HUB_ENV" >"${TMP}/out" 2>&1
}

# Forwards the allowlisted variable, lowercased.
run COCALC_FRONTEND_ASSET_MONITORING=FALSE
[ -f "$DROPIN" ] || fail "no drop-in written"
[ "$(cat "$DROPIN")" = "# Written by cocalc-star-docker-hub-env on every container start.
[Service]
Environment=COCALC_FRONTEND_ASSET_MONITORING=false" ] || fail "unexpected drop-in: $(cat "$DROPIN")"
[ "$(stat -c %a "$DROPIN")" = "644" ] || fail "drop-in mode"
grep -q "forwarding COCALC_FRONTEND_ASSET_MONITORING to the hub" "${TMP}/out" || fail "no forwarding log line"

# Nothing else from the container's environment is forwarded.
run COCALC_FRONTEND_ASSET_MONITORING=true OPENAI_API_KEY=sk-secret-value \
  COCALC_STAR_DOMAIN=example.com COCALC_SETTING_DNS=x
grep -q "Environment=COCALC_FRONTEND_ASSET_MONITORING=true" "$DROPIN" || fail "true not forwarded"
[ "$(grep -c '^Environment=' "$DROPIN")" = "1" ] || fail "forwarded more than the allowlist: $(cat "$DROPIN")"
! grep -q "sk-secret-value\|OPENAI_API_KEY\|COCALC_STAR_DOMAIN\|COCALC_SETTING_DNS" "$DROPIN" ||
  fail "a non-allowlisted variable reached the drop-in"

# An invalid value is ignored, the value is not logged, and no drop-in remains.
run COCALC_FRONTEND_ASSET_MONITORING='false
Environment=OTHER=1'
[ ! -e "$DROPIN" ] || fail "drop-in kept for an invalid value: $(cat "$DROPIN")"
grep -q "warning: ignoring COCALC_FRONTEND_ASSET_MONITORING" "${TMP}/out" || fail "no warning"
! grep -q "OTHER" "${TMP}/out" || fail "the rejected value was logged"

# Removing the variable removes the drop-in on the next start.
run COCALC_FRONTEND_ASSET_MONITORING=false
[ -f "$DROPIN" ] || fail "drop-in missing before removal"
run
[ ! -e "$DROPIN" ] || fail "drop-in kept after the variable was removed"
[ ! -s "${TMP}/out" ] || fail "unexpected output without variables: $(cat "${TMP}/out")"

# No temporary files are left next to the drop-in.
run COCALC_FRONTEND_ASSET_MONITORING=true
[ "$(find "$DIR" -mindepth 1 | wc -l)" = "1" ] || fail "leftover files: $(ls -A "$DIR")"

printf 'PASS: test-hub-env.sh\n'
