#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

printf '%s\n' 'COCALC_BAY_FRONTDOOR_HOST=127.0.0.1' > "${TMP_ROOT}/bay.env"
printf '%s\n' 'COCALC_BAY_FRONTDOOR_HOST=192.0.2.10' > "${TMP_ROOT}/bay-overlay.env"
printf '%s\n' \
  'COCALC_BAY_FRONTDOOR_HOST=0.0.0.0' \
  'COCALC_BAY_PUBLIC_INGRESS_MODE=cloudflare-proxy' > "${TMP_ROOT}/bay-local.env"

loaded="$({
  COCALC_BAY_ENV_FILE="${TMP_ROOT}/bay.env" \
  COCALC_BAY_WORKERS_ENV_FILE="${TMP_ROOT}/missing-workers.env" \
  COCALC_BAY_OVERLAY_ENV_FILE="${TMP_ROOT}/bay-overlay.env" \
  COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP_ROOT}/missing-topology.env" \
  COCALC_BAY_SECRETS_ENV_FILE="${TMP_ROOT}/missing-secrets.env" \
  COCALC_BAY_LOCAL_ENV_FILE="${TMP_ROOT}/bay-local.env" \
    bash -c 'source "$1"; printf "%s %s" "$COCALC_BAY_FRONTDOOR_HOST" "$COCALC_BAY_PUBLIC_INGRESS_MODE"' \
      bash "${SCRIPT_DIR}/bin/lib.sh"
})"
if [[ "$loaded" != "0.0.0.0 cloudflare-proxy" ]]; then
  echo "bay-local.env did not override generated environment files: $loaded" >&2
  exit 1
fi

TARGET_ROOT="${TMP_ROOT}/rootfs"
bash "${SCRIPT_DIR}/install-scaffold.sh" --root "$TARGET_ROOT" >/dev/null
LOCAL_ENV="${TARGET_ROOT}/etc/cocalc/bay-local.env"
NEEDRESTART_CONFIG="${TARGET_ROOT}/etc/needrestart/conf.d/cocalc-bay.conf"
[[ -f "$LOCAL_ENV" ]]
[[ "$(stat -c '%a' "$LOCAL_ENV")" == "644" ]]
[[ -f "$NEEDRESTART_CONFIG" ]]
[[ -f "${TARGET_ROOT}/etc/cocalc/site-master-key.keyring" ]]
[[ "$(stat -c '%a' "${TARGET_ROOT}/etc/cocalc/site-master-key.keyring")" == "600" ]]
grep -qx 'LoadCredential=site-master-key.keyring:/etc/cocalc/site-master-key.keyring' \
  "${TARGET_ROOT}/etc/systemd/system/cocalc-bay-hub@.service"
[[ "$(stat -c '%a' "$NEEDRESTART_CONFIG")" == "644" ]]
grep -Fqx '$nrconf{override_rc}{qr(^cocalc-bay-.*\.service$)} = 0;' \
  "$NEEDRESTART_CONFIG"
# Root's escrow job is installed outside the bay-owned release tree, without
# its test, and the unit runs that copy.
LIBEXEC="${TARGET_ROOT}/usr/local/libexec/cocalc-bay"
[[ -x "${LIBEXEC}/bay-config-escrow-run" && -f "${LIBEXEC}/bay-config-escrow.mjs" ]]
[[ ! -e "${LIBEXEC}/bay-config-escrow.test.sh" ]]
# So is bay-restore, with its engine and a copy of lib.sh.
[[ -x "${LIBEXEC}/bay-restore" && -x "${LIBEXEC}/bay-restore-engine.py" && -f "${LIBEXEC}/lib.sh" ]]
[[ ! -e "${LIBEXEC}/bay-restore-cutover.test.sh" ]]
[[ ! -e "${LIBEXEC}/bay-restore-engine.test.sh" ]]
# The restore fence holds every bay unit: the target, and by prefix drop-ins
# all cocalc-bay-* services (template instances too), timers and targets.
for dropin_dir in cocalc-bay.target.d cocalc-bay-.target.d cocalc-bay-.service.d cocalc-bay-.timer.d; do
  grep -qx 'ConditionPathExists=!/etc/cocalc/bay-restore-fence' \
    "${TARGET_ROOT}/etc/systemd/system/${dropin_dir}/restore-fence.conf"
done
# The scaffold never fences a bay itself.
[[ ! -e "${TARGET_ROOT}/etc/cocalc/bay-restore-fence" ]]
# A mode B rebuild installs the tooling, fenced, before any release.
TOOLS_ROOT="${TMP_ROOT}/tools-rootfs"
bash "${SCRIPT_DIR}/install-restore-tools.sh" --root "$TOOLS_ROOT" --fence
[[ -e "${TOOLS_ROOT}/etc/cocalc/bay-restore-fence" ]]
[[ -f "${TOOLS_ROOT}/etc/systemd/system/cocalc-bay-.service.d/restore-fence.conf" ]]
cmp -s "${SCRIPT_DIR}/libexec/bay-restore" "${TOOLS_ROOT}/usr/local/libexec/cocalc-bay/bay-restore"
[[ -x "${TOOLS_ROOT}/usr/local/libexec/cocalc-bay/bay-restore-engine.py" && -f "${TOOLS_ROOT}/usr/local/libexec/cocalc-bay/lib.sh" ]]
[[ ! -e "${TARGET_ROOT}/opt/cocalc/bay/current/bin/bay-restore" ]]
[[ ! -e "${TARGET_ROOT}/opt/cocalc/bay/current/bin/bay-config-escrow-run" ]]
grep -qx 'ExecStart=/usr/local/libexec/cocalc-bay/bay-config-escrow-run' \
  "${TARGET_ROOT}/etc/systemd/system/cocalc-bay-config-escrow.service"
printf '%s\n' 'COCALC_BAY_FRONTDOOR_HOST=0.0.0.0' > "$LOCAL_ENV"

bash "${SCRIPT_DIR}/install-scaffold.sh" --root "$TARGET_ROOT" >/dev/null
grep -qx 'COCALC_BAY_FRONTDOOR_HOST=0.0.0.0' "$LOCAL_ENV"

echo "bay scaffold local environment tests passed"
