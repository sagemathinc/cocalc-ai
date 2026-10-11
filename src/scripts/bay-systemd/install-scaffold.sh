#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="/"
CURRENT_DIR="/opt/cocalc/bay/current"
ENV_DIR="/etc/cocalc"
SYSTEMD_DIR="/etc/systemd/system"
SBIN_DIR="/usr/local/sbin"
# Programs that root runs (the escrow job). Unlike the release tree, which
# belongs to the bay account, this directory and its files are root-owned.
LIBEXEC_DIR="/usr/local/libexec/cocalc-bay"
SUDOERS_DIR="/etc/sudoers.d"
NEEDRESTART_DIR="/etc/needrestart/conf.d"
OVERLAY_MODE="none"
DAEMON_RELOAD=0

usage() {
  cat <<'EOF'
Usage: install-scaffold.sh [options]

Install the bay systemd starter scaffold into a target rootfs.

Options:
  --root <dir>              install into an alternate rootfs prefix
  --current-dir <dir>       bundle current dir inside the target rootfs
  --env-dir <dir>           env dir inside the target rootfs
  --systemd-dir <dir>       systemd dir inside the target rootfs
  --sbin-dir <dir>          root helper dir inside the target rootfs
  --libexec-dir <dir>       root-owned program dir inside the target rootfs
  --sudoers-dir <dir>       sudoers dir inside the target rootfs
  --overlay current-cocalc  install the current CoCalc overlay as bay-overlay.env
  --overlay rocket-bundle   install the Rocket bay bundle overlay as bay-overlay.env
  --daemon-reload           run systemctl daemon-reload after install (only when --root=/)
  -h, --help                show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT_DIR="$2"
      shift 2
      ;;
    --current-dir)
      CURRENT_DIR="$2"
      shift 2
      ;;
    --env-dir)
      ENV_DIR="$2"
      shift 2
      ;;
    --systemd-dir)
      SYSTEMD_DIR="$2"
      shift 2
      ;;
    --sbin-dir)
      SBIN_DIR="$2"
      shift 2
      ;;
    --libexec-dir)
      LIBEXEC_DIR="$2"
      shift 2
      ;;
    --sudoers-dir)
      SUDOERS_DIR="$2"
      shift 2
      ;;
    --overlay)
      OVERLAY_MODE="$2"
      shift 2
      ;;
    --daemon-reload)
      DAEMON_RELOAD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$OVERLAY_MODE" != "none" && "$OVERLAY_MODE" != "current-cocalc" && "$OVERLAY_MODE" != "rocket-bundle" ]]; then
  echo "unsupported overlay mode: $OVERLAY_MODE" >&2
  exit 2
fi

prefix_path() {
  local path="$1"
  if [[ "$ROOT_DIR" == "/" ]]; then
    printf '%s' "$path"
  else
    printf '%s%s' "${ROOT_DIR%/}" "$path"
  fi
}

TARGET_CURRENT_DIR="$(prefix_path "$CURRENT_DIR")"
TARGET_BIN_DIR="${TARGET_CURRENT_DIR}/bin"
TARGET_ENV_DIR="$(prefix_path "$ENV_DIR")"
TARGET_SYSTEMD_DIR="$(prefix_path "$SYSTEMD_DIR")"
TARGET_SBIN_DIR="$(prefix_path "$SBIN_DIR")"
TARGET_LIBEXEC_DIR="$(prefix_path "$LIBEXEC_DIR")"
TARGET_SUDOERS_DIR="$(prefix_path "$SUDOERS_DIR")"
TARGET_NEEDRESTART_DIR="$(prefix_path "$NEEDRESTART_DIR")"

mkdir -p "$TARGET_BIN_DIR" "$TARGET_ENV_DIR" "$TARGET_SYSTEMD_DIR" \
  "$TARGET_SBIN_DIR" "$TARGET_SUDOERS_DIR" "$TARGET_NEEDRESTART_DIR"

install -m 0755 "${SCRIPT_DIR}/bin/"* "$TARGET_BIN_DIR/"
install -m 0644 "${SCRIPT_DIR}/systemd/"* "$TARGET_SYSTEMD_DIR/"
install -m 0755 "${SCRIPT_DIR}/sbin/"* "$TARGET_SBIN_DIR/"
install -d -m 0755 "$TARGET_LIBEXEC_DIR"
for file in "${SCRIPT_DIR}/libexec/"*; do
  [[ "$file" == *.test.sh ]] && continue
  install -m 0755 "$file" "$TARGET_LIBEXEC_DIR/"
done
install -m 0440 "${SCRIPT_DIR}/sudoers/"* "$TARGET_SUDOERS_DIR/"
install -m 0644 "${SCRIPT_DIR}/needrestart/cocalc-bay.conf" \
  "${TARGET_NEEDRESTART_DIR}/cocalc-bay.conf"

if command -v visudo >/dev/null 2>&1; then
  visudo -cf "${TARGET_SUDOERS_DIR}/cocalc-bay-cloudflared" >/dev/null
fi

install -m 0644 "${SCRIPT_DIR}/env/bay.env.example" \
  "${TARGET_ENV_DIR}/bay.env.example"
install -m 0644 "${SCRIPT_DIR}/env/bay-workers.env.example" \
  "${TARGET_ENV_DIR}/bay-workers.env.example"
install -m 0644 "${SCRIPT_DIR}/env/bay-secrets.env.example" \
  "${TARGET_ENV_DIR}/bay-secrets.env.example"
install -m 0644 "${SCRIPT_DIR}/env/bay-topology.env.example" \
  "${TARGET_ENV_DIR}/bay-topology.env.example"

if [[ ! -e "${TARGET_ENV_DIR}/bay.env" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay.env.example" "${TARGET_ENV_DIR}/bay.env"
fi
# /ready verifies each hub worker's Conat round trip. Migrate only the old
# scaffold default so an explicit operator-selected path remains untouched.
if grep -qx 'COCALC_BAY_HUB_HEALTH_PATH=/alive' "${TARGET_ENV_DIR}/bay.env"; then
  sed -i 's|^COCALC_BAY_HUB_HEALTH_PATH=/alive$|COCALC_BAY_HUB_HEALTH_PATH=/ready|' \
    "${TARGET_ENV_DIR}/bay.env"
fi
if [[ ! -e "${TARGET_ENV_DIR}/bay-workers.env" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay-workers.env.example" \
    "${TARGET_ENV_DIR}/bay-workers.env"
fi
if [[ ! -e "${TARGET_ENV_DIR}/bay-secrets.env" ]]; then
  install -m 0600 "${SCRIPT_DIR}/env/bay-secrets.env.example" \
    "${TARGET_ENV_DIR}/bay-secrets.env"
else
  chmod 0600 "${TARGET_ENV_DIR}/bay-secrets.env"
fi
if [[ ! -e "${TARGET_ENV_DIR}/bay-topology.env" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay-topology.env.example" \
    "${TARGET_ENV_DIR}/bay-topology.env"
fi
if [[ ! -e "${TARGET_ENV_DIR}/bay-local.env" ]]; then
  install -m 0644 /dev/null "${TARGET_ENV_DIR}/bay-local.env"
fi

if [[ "$OVERLAY_MODE" == "current-cocalc" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay-current-cocalc-overlay.env.example" \
    "${TARGET_ENV_DIR}/bay-current-cocalc-overlay.env.example"
  if [[ ! -e "${TARGET_ENV_DIR}/bay-overlay.env" ]]; then
    install -m 0644 "${SCRIPT_DIR}/env/bay-current-cocalc-overlay.env.example" \
      "${TARGET_ENV_DIR}/bay-overlay.env"
  fi
fi

if [[ "$OVERLAY_MODE" == "rocket-bundle" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay-rocket-bundle-overlay.env.example" \
    "${TARGET_ENV_DIR}/bay-rocket-bundle-overlay.env.example"
  if [[ ! -e "${TARGET_ENV_DIR}/bay-overlay.env" ]]; then
    install -m 0644 "${SCRIPT_DIR}/env/bay-rocket-bundle-overlay.env.example" \
      "${TARGET_ENV_DIR}/bay-overlay.env"
  fi
fi

if [[ "$DAEMON_RELOAD" -eq 1 ]]; then
  if [[ "$ROOT_DIR" != "/" ]]; then
    echo "--daemon-reload only works with --root /" >&2
    exit 2
  fi
  systemctl daemon-reload
  systemctl enable cocalc-bay-hub-watchdog.timer
  systemctl enable cocalc-bay-cloudflared-watchdog.timer
  if systemctl is-active --quiet cocalc-bay.target; then
    systemctl start cocalc-bay-hub-watchdog.timer
    systemctl start cocalc-bay-cloudflared-watchdog.timer
  fi
fi

cat <<EOF
Installed bay scaffold:
  bin dir:      ${TARGET_BIN_DIR}
  env dir:      ${TARGET_ENV_DIR}
  systemd dir:  ${TARGET_SYSTEMD_DIR}
  sbin dir:     ${TARGET_SBIN_DIR}
  libexec dir:  ${TARGET_LIBEXEC_DIR}
  sudoers dir:  ${TARGET_SUDOERS_DIR}
  needrestart:  ${TARGET_NEEDRESTART_DIR}/cocalc-bay.conf
  overlay:      ${OVERLAY_MODE}

Next steps:
  1. Edit ${TARGET_ENV_DIR}/bay.env
  2. Edit ${TARGET_ENV_DIR}/bay-workers.env
  3. Edit ${TARGET_ENV_DIR}/bay-secrets.env
  4. Edit ${TARGET_ENV_DIR}/bay-topology.env for multibay clusters
  5. Put persistent operator overrides in ${TARGET_ENV_DIR}/bay-local.env
  6. Install the shared site master key:
     install -o root -g root -m 0600 /path/to/site-master-key ${TARGET_ENV_DIR}/site-master-key
EOF

if [[ "$OVERLAY_MODE" != "none" ]]; then
  cat <<EOF
  7. Review ${TARGET_ENV_DIR}/bay-overlay.env
EOF
fi

cat <<EOF
  - Enable desired workers, e.g.:
     systemctl enable cocalc-bay-hub@1.service
     systemctl enable cocalc-bay-hub@2.service
  - Start the bay:
     systemctl start cocalc-bay.target
EOF
