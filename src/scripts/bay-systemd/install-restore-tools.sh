#!/usr/bin/env bash
# Install the bay's restore tooling from this checkout, independently of the
# bay release: the restore fence (a start condition on every bay unit) and
# the root-owned bay-restore, its engine and lib.sh in
# /usr/local/libexec/cocalc-bay. install-scaffold.sh runs this for every
# release; a mode B rebuild (RESTORE.md) runs it from current main, because
# the release it restores may predate the fence.
#
#   install-restore-tools.sh [--root DIR] [--systemd-dir DIR] [--libexec-dir DIR]
#                            [--fence] [--no-daemon-reload]
#
#   --root DIR            install below DIR instead of / (tests)
#   --systemd-dir DIR     systemd dir inside the root (default /etc/systemd/system)
#   --libexec-dir DIR     root-owned program dir inside the root
#                         (default /usr/local/libexec/cocalc-bay)
#   --fence               also fence the bay (create /etc/cocalc/bay-restore-fence,
#                         the path the drop-in checks)
#   --no-daemon-reload    do not run systemctl daemon-reload (only with --root /)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="/"
SYSTEMD_DIR_IN_ROOT="/etc/systemd/system"
LIBEXEC_DIR_IN_ROOT="/usr/local/libexec/cocalc-bay"
FENCE=0
DAEMON_RELOAD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT_DIR="$2"; shift 2 ;;
    --systemd-dir) SYSTEMD_DIR_IN_ROOT="$2"; shift 2 ;;
    --libexec-dir) LIBEXEC_DIR_IN_ROOT="$2"; shift 2 ;;
    --fence) FENCE=1; shift ;;
    --no-daemon-reload) DAEMON_RELOAD=0; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-restore-tools.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done
prefix() {
  if [[ "$ROOT_DIR" == / ]]; then printf '%s' "$1"; else printf '%s%s' "${ROOT_DIR%/}" "$1"; fi
}
SYSTEMD_DIR="$(prefix "$SYSTEMD_DIR_IN_ROOT")"
LIBEXEC_DIR="$(prefix "$LIBEXEC_DIR_IN_ROOT")"
ENV_DIR="$(prefix /etc/cocalc)"

# The fence first: from here on, a reboot cannot start the bay.
if [[ "$FENCE" == 1 ]]; then
  install -d -m 0755 "$ENV_DIR"
  [[ -e "${ENV_DIR}/bay-restore-fence" ]] || install -m 0644 /dev/null "${ENV_DIR}/bay-restore-fence"
fi
# "cocalc-bay-.service.d" is a prefix drop-in, so it also covers template
# instances such as cocalc-bay-hub@1.
for dropin_dir in cocalc-bay.target.d cocalc-bay-.target.d cocalc-bay-.service.d cocalc-bay-.timer.d; do
  install -d -m 0755 "${SYSTEMD_DIR}/${dropin_dir}"
  install -m 0644 "${SCRIPT_DIR}/systemd-dropins/restore-fence.conf" \
    "${SYSTEMD_DIR}/${dropin_dir}/restore-fence.conf"
done
install -d -m 0755 "$LIBEXEC_DIR"
install -m 0755 "${SCRIPT_DIR}/libexec/bay-restore" "${SCRIPT_DIR}/libexec/bay-restore-engine.py" "$LIBEXEC_DIR/"
# bay-restore sources lib.sh, so root's copy sits beside it.
install -m 0644 "${SCRIPT_DIR}/bin/lib.sh" "${LIBEXEC_DIR}/lib.sh"
if [[ "$DAEMON_RELOAD" == 1 && "$ROOT_DIR" == / ]]; then
  systemctl daemon-reload
fi
