#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="/"
CURRENT_DIR="/opt/cocalc/bay/current"
ENV_DIR="/etc/cocalc"
SYSTEMD_DIR="/etc/systemd/system"
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

mkdir -p "$TARGET_BIN_DIR" "$TARGET_ENV_DIR" "$TARGET_SYSTEMD_DIR"

install -m 0755 "${SCRIPT_DIR}/bin/"* "$TARGET_BIN_DIR/"
install -m 0644 "${SCRIPT_DIR}/systemd/"* "$TARGET_SYSTEMD_DIR/"

install -m 0644 "${SCRIPT_DIR}/env/bay.env.example" \
  "${TARGET_ENV_DIR}/bay.env.example"
install -m 0644 "${SCRIPT_DIR}/env/bay-workers.env.example" \
  "${TARGET_ENV_DIR}/bay-workers.env.example"
install -m 0644 "${SCRIPT_DIR}/env/bay-secrets.env.example" \
  "${TARGET_ENV_DIR}/bay-secrets.env.example"

if [[ ! -e "${TARGET_ENV_DIR}/bay.env" ]]; then
  install -m 0644 "${SCRIPT_DIR}/env/bay.env.example" "${TARGET_ENV_DIR}/bay.env"
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
fi

cat <<EOF
Installed bay scaffold:
  bin dir:      ${TARGET_BIN_DIR}
  env dir:      ${TARGET_ENV_DIR}
  systemd dir:  ${TARGET_SYSTEMD_DIR}
  overlay:      ${OVERLAY_MODE}

Next steps:
  1. Edit ${TARGET_ENV_DIR}/bay.env
  2. Edit ${TARGET_ENV_DIR}/bay-workers.env
  3. Edit ${TARGET_ENV_DIR}/bay-secrets.env
EOF

if [[ "$OVERLAY_MODE" != "none" ]]; then
  cat <<EOF
  4. Review ${TARGET_ENV_DIR}/bay-overlay.env
EOF
fi

cat <<EOF
  5. Enable desired workers, e.g.:
     systemctl enable cocalc-bay-hub@1.service
     systemctl enable cocalc-bay-hub@2.service
  6. Start the bay:
     systemctl start cocalc-bay.target
EOF
