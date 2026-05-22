#!/usr/bin/env bash
set -euo pipefail

BAY_ID="bay-0"
BAY_USER="cocalc-bay"
BAY_GROUP="cocalc-bay"
BAY_ROOT_BASE="/mnt/cocalc/bays"
INSTALL_BASE="/opt/cocalc/bay"
INSTALL_PACKAGES=1
INSTALL_NODEJS=0
NODE_VERSION="26.2.0"
NVM_VERSION="0.40.4"
NVM_DIR="/opt/cocalc/nvm"
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
  --install-nodejs         install Node.js 26.2.0 using nvm if missing
  --node-version <v>       Node.js version when using --install-nodejs (default: 26.2.0)
  --nvm-version <v>        nvm version to install or refresh (default: 0.40.4)
  --nvm-dir <dir>          nvm install directory (default: /opt/cocalc/nvm)
  --node-major <n>         deprecated alias for --node-version
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
  local node_bin="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node"
  local version
  if [[ "$INSTALL_NODEJS" -eq 1 ]]; then
    install_nvm_node
    return 0
  fi

  if [[ -x "$node_bin" ]]; then
    version="$("$node_bin" -p 'process.versions.node' 2>/dev/null || true)"
    if [[ "$version" == "$NODE_VERSION" ]]; then
      return 0
    fi
  fi

  if command -v node >/dev/null 2>&1; then
    version="$(node -p 'process.versions.node' 2>/dev/null || true)"
    if [[ "$version" == "$NODE_VERSION" ]]; then
      return 0
    fi
  fi

  echo "node ${NODE_VERSION} is required; rerun with --install-nodejs or install it first" >&2
  exit 1
}

install_nvm_node() {
  local node_bin="${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node"
  run apt-get update
  run apt-get install -y ca-certificates curl gnupg
  run mkdir -p "$NVM_DIR"
  run bash -lc "export NVM_DIR='$NVM_DIR'; export PROFILE=/dev/null; curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh | bash"
  run bash -lc "export NVM_DIR='$NVM_DIR'; . '$NVM_DIR/nvm.sh'; nvm install '$NODE_VERSION'; nvm alias default '$NODE_VERSION'"
  if [[ ! -x "$node_bin" ]]; then
    echo "expected Node.js binary was not installed: $node_bin" >&2
    exit 1
  fi
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
      --node-version)
        NODE_VERSION="$2"
        shift 2
        ;;
      --nvm-version)
        NVM_VERSION="$2"
        shift 2
        ;;
      --nvm-dir)
        NVM_DIR="$2"
        shift 2
        ;;
      --node-major)
        if [[ "$2" != "26" ]]; then
          echo "--node-major is deprecated; only major 26 is supported" >&2
          exit 2
        fi
        NODE_VERSION="26.2.0"
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
    run apt-get install -y openssl rsync jq postgresql postgresql-client sqlite3 zstd libatomic1
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
  run mkdir -p "${INSTALL_BASE}/releases"
  run install -d -o root -g "$BAY_GROUP" -m 0750 /etc/cocalc
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
Node.js:         ${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node

Next step:
  install the shared site master key before starting any bay services:
    sudo install -o root -g root -m 0600 /path/to/site-master-key /etc/cocalc/site-master-key

Then stage a release:
  sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh \\
    --source /path/to/built/src \\
    --bay-id ${BAY_ID}
EOF
}

main "$@"
