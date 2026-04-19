#!/usr/bin/env bash
set -euo pipefail

BAY_ID="bay-0"
BAY_USER="cocalc-bay"
BAY_GROUP="cocalc-bay"
BAY_ROOT_BASE="/mnt/cocalc/bays"
INSTALL_BASE="/opt/cocalc/bay"
INSTALL_PACKAGES=1
INSTALL_NODEJS=0
NODE_MAJOR=22
PRESERVE_SYSTEM_POSTGRES=0

usage() {
  cat <<'EOF'
Usage: bay-bootstrap-host.sh [options]

Prepare a fresh Ubuntu host for a bay deployment.

Options:
  --bay-id <id>            bay id to provision (default: bay-0)
  --bay-user <user>        service user (default: cocalc-bay)
  --bay-group <group>      service group (default: cocalc-bay)
  --bay-root-base <dir>    base dir for bay state (default: /mnt/cocalc/bays)
  --install-base <dir>     install base for releases/current (default: /opt/cocalc/bay)
  --skip-packages          do not apt install base packages
  --install-nodejs         install Node.js from NodeSource if node is missing or too old
  --node-major <n>         NodeSource major version when using --install-nodejs (default: 22)
  --preserve-system-postgres
                           do not stop/disable Ubuntu's package-managed postgres service
  -h, --help               show help
EOF
}

run() {
  echo "+ $*"
  "$@"
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "run this script as root" >&2
    exit 1
  fi
}

ensure_node() {
  local version major
  if command -v node >/dev/null 2>&1; then
    version="$(node -v | sed 's/^v//')"
    major="${version%%.*}"
    if [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 22 ]]; then
      return 0
    fi
  fi
  if [[ "$INSTALL_NODEJS" -ne 1 ]]; then
    echo "node >=22 is required; rerun with --install-nodejs or install it first" >&2
    exit 1
  fi
  run apt-get update
  run apt-get install -y ca-certificates curl gnupg
  run bash -lc "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -"
  run apt-get install -y nodejs
}

find_initdb() {
  if command -v initdb >/dev/null 2>&1; then
    command -v initdb
    return 0
  fi
  find /usr/lib/postgresql -path '*/bin/initdb' 2>/dev/null | sort | tail -n1
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --bay-id)
        BAY_ID="$2"
        shift 2
        ;;
      --bay-user)
        BAY_USER="$2"
        shift 2
        ;;
      --bay-group)
        BAY_GROUP="$2"
        shift 2
        ;;
      --bay-root-base)
        BAY_ROOT_BASE="$2"
        shift 2
        ;;
      --install-base)
        INSTALL_BASE="$2"
        shift 2
        ;;
      --skip-packages)
        INSTALL_PACKAGES=0
        shift
        ;;
      --install-nodejs)
        INSTALL_NODEJS=1
        shift
        ;;
      --node-major)
        NODE_MAJOR="$2"
        shift 2
        ;;
      --preserve-system-postgres)
        PRESERVE_SYSTEM_POSTGRES=1
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

  require_root

  if [[ "$INSTALL_PACKAGES" -eq 1 ]]; then
    run apt-get update
    run apt-get install -y openssl rsync jq postgresql postgresql-client
  fi

  ensure_node

  if [[ "$PRESERVE_SYSTEM_POSTGRES" -ne 1 ]]; then
    if command -v pg_lsclusters >/dev/null 2>&1; then
      while read -r version cluster _rest; do
        if [[ -n "${version:-}" && -n "${cluster:-}" ]]; then
          run pg_ctlcluster "$version" "$cluster" stop || true
        fi
      done < <(pg_lsclusters --no-header 2>/dev/null || true)
    fi
    if command -v systemctl >/dev/null 2>&1; then
      run systemctl disable --now postgresql || true
    fi
  fi

  if ! getent group "$BAY_GROUP" >/dev/null; then
    run groupadd --system "$BAY_GROUP"
  fi
  if ! id "$BAY_USER" >/dev/null 2>&1; then
    run useradd \
      --system \
      --gid "$BAY_GROUP" \
      --home-dir "/var/lib/${BAY_USER}" \
      --create-home \
      --shell /usr/sbin/nologin \
      "$BAY_USER"
  fi

  BAY_ROOT="${BAY_ROOT_BASE}/${BAY_ID}"
  run mkdir -p \
    "${BAY_ROOT}/postgres" \
    "${BAY_ROOT}/logs" \
    "${BAY_ROOT}/run/postgres" \
    "${BAY_ROOT}/backups" \
    "${BAY_ROOT}/state" \
    "${BAY_ROOT}/secrets" \
    "${BAY_ROOT}/projects"
  run mkdir -p "${INSTALL_BASE}/releases" /etc/cocalc
  run chown -R "${BAY_USER}:${BAY_GROUP}" "$BAY_ROOT" "${INSTALL_BASE}"

  INITDB="$(find_initdb)"
  if [[ -z "$INITDB" ]]; then
    echo "could not find initdb; make sure postgresql is installed" >&2
    exit 1
  fi

  if [[ ! -f "${BAY_ROOT}/postgres/PG_VERSION" ]]; then
    run runuser -u "$BAY_USER" -- "$INITDB" -D "${BAY_ROOT}/postgres"
  fi

  cat <<EOF
Host bootstrap complete.

Bay user:        ${BAY_USER}
Bay root:        ${BAY_ROOT}
Install base:    ${INSTALL_BASE}
initdb:          ${INITDB}

Next step:
  sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh \\
    --source /path/to/built/src \\
    --bay-id ${BAY_ID}
EOF
}

main "$@"
