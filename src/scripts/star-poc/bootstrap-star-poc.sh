#!/usr/bin/env bash
set -euo pipefail

if [ -z "${STAR_USER:-}" ]; then
  if [ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ]; then
    echo "[star-poc] ERROR: set STAR_USER when running directly as root" >&2
    exit 1
  fi
  STAR_USER="${SUDO_USER:-${USER}}"
fi
STAR_HOME="$(getent passwd "$STAR_USER" | cut -d: -f6)"
SRC_ROOT="${SRC_ROOT:-${STAR_HOME}/cocalc-ai/src}"
STAR_ROOT="${STAR_ROOT:-/var/lib/cocalc/star}"
STAR_DATA="${STAR_DATA:-${STAR_ROOT}/launchpad}"
STAR_PROJECT_HOST_DATA="${STAR_PROJECT_HOST_DATA:-${STAR_ROOT}/project-host/0}"
STAR_HOST_ID="${STAR_HOST_ID:-11111111-1111-4111-8111-111111111111}"
STAR_BASE_PORT="${STAR_BASE_PORT:-9100}"
STAR_BASE_URL="${STAR_BASE_URL:-http://127.0.0.1:${STAR_BASE_PORT}}"
STAR_BTRFS_IMAGE="${STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}"
STAR_BTRFS_SIZE="${STAR_BTRFS_SIZE:-100G}"
STAR_BUILD="${STAR_BUILD:-1}"
STAR_BUILD_DEFAULT_ROOTFS="${STAR_BUILD_DEFAULT_ROOTFS:-1}"
STAR_DEFAULT_ROOTFS_IMAGE="${STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
STAR_DEFAULT_ROOTFS_BASE_IMAGE="${STAR_DEFAULT_ROOTFS_BASE_IMAGE:-ubuntu:24.04}"
STAR_REMOVE_GCP_SUDOERS="${STAR_REMOVE_GCP_SUDOERS:-1}"

log() {
  printf '[star-poc] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

run() {
  log "+ $*"
  "$@"
}

as_star_user() {
  sudo -H -u "$STAR_USER" bash -lc "cd '$STAR_HOME' && $*"
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "run as root, e.g. sudo SRC_ROOT=$SRC_ROOT bash $0"
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update
  run apt-get install -y \
    bash ca-certificates curl git jq openssl build-essential python3 \
    podman btrfs-progs uidmap slirp4netns passt catatonit fuse-overlayfs \
    caddy xz-utils rsync sudo postgresql postgresql-client libpq-dev
  systemctl disable --now postgresql >/dev/null 2>&1 || true
}

stop_existing_services() {
  systemctl stop cocalc-star-project-host.service >/dev/null 2>&1 || true
  systemctl stop cocalc-star-hub.service >/dev/null 2>&1 || true
}

install_node() {
  if as_star_user 'source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 && nvm version 26 >/dev/null 2>&1'; then
    return
  fi
  as_star_user 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash'
  as_star_user 'source "$HOME/.nvm/nvm.sh" && nvm install 26 && nvm alias default 26 && if command -v corepack >/dev/null 2>&1; then corepack enable; else npm install -g pnpm@10.33.0; fi'
}

build_source() {
  [ -d "$SRC_ROOT/packages" ] || die "missing source checkout at $SRC_ROOT"
  if [ "$STAR_BUILD" = "0" ]; then
    log "skipping build because STAR_BUILD=0"
    return
  fi
  as_star_user "cd '$SRC_ROOT' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 && if command -v corepack >/dev/null 2>&1; then corepack enable; fi && if ! command -v pnpm >/dev/null 2>&1; then npm install -g pnpm@10.33.0; fi && ./workspaces.py install && pnpm --filter @cocalc/app-notebook build && ./workspaces.py build --dev && pnpm python-api"
  as_star_user "cd '$SRC_ROOT/packages/project' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 && pnpm build:bundle"
}

ensure_btrfs() {
  mkdir -p /var/lib/cocalc /mnt/cocalc
  if [ ! -f "$STAR_BTRFS_IMAGE" ]; then
    run truncate -s "$STAR_BTRFS_SIZE" "$STAR_BTRFS_IMAGE"
    run mkfs.btrfs -f "$STAR_BTRFS_IMAGE"
  fi
  if ! grep -qF "$STAR_BTRFS_IMAGE /mnt/cocalc btrfs" /etc/fstab; then
    printf '%s /mnt/cocalc btrfs loop,noatime,compress=zstd 0 0 # cocalc-star-poc\n' "$STAR_BTRFS_IMAGE" >>/etc/fstab
  fi
  if ! mountpoint -q /mnt/cocalc; then
    run mount /mnt/cocalc
  fi
  mkdir -p /mnt/cocalc/data/tmp /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
  chmod 1777 /mnt/cocalc/data/tmp
  if ! grep -qF "/mnt/cocalc/shared-scratch /mnt/cocalc-scratch none bind" /etc/fstab; then
    printf '/mnt/cocalc/shared-scratch /mnt/cocalc-scratch none bind 0 0 # cocalc-star-poc\n' >>/etc/fstab
  fi
  if ! mountpoint -q /mnt/cocalc-scratch; then
    run mount /mnt/cocalc-scratch
  fi
  chown root:root /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
  chmod 0755 /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
}

install_wrappers() {
  python3 - "$SRC_ROOT" <<'PY'
import importlib.util
import sys
from pathlib import Path

src_root = Path(sys.argv[1])
path = src_root / "packages/server/cloud/bootstrap/bootstrap.py"
spec = importlib.util.spec_from_file_location("cocalc_star_bootstrap", path)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.install_privileged_wrappers(None)
PY
  cat >/usr/local/sbin/cocalc-project-host-rootctl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  start|stop|restart|status)
    exec /bin/systemctl "$1" cocalc-star-project-host.service
    ;;
  *)
    echo "usage: cocalc-project-host-rootctl {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
EOF
  chmod 0755 /usr/local/sbin/cocalc-project-host-rootctl
}

configure_users_and_dirs() {
  loginctl enable-linger "$STAR_USER" || true
  mkdir -p \
    "$STAR_DATA/secrets" \
    "$STAR_PROJECT_HOST_DATA/tmp" \
    "$STAR_PROJECT_HOST_DATA/cache/images" \
    "$STAR_PROJECT_HOST_DATA/cache/project-roots" \
    "$STAR_PROJECT_HOST_DATA/secrets" \
    /etc/cocalc/star
  chmod 700 "$STAR_PROJECT_HOST_DATA/tmp"
  chown -R "$STAR_USER:$STAR_USER" "$STAR_ROOT"
  mkdir -p /mnt/cocalc/data/tmp/cocalc-podman-runtime-"$(id -u "$STAR_USER")"
  chown -R "$STAR_USER:$STAR_USER" /mnt/cocalc/data
  chmod 700 /mnt/cocalc/data/tmp/cocalc-podman-runtime-"$(id -u "$STAR_USER")"
}

build_default_rootfs_image() {
  if [ "$STAR_BUILD_DEFAULT_ROOTFS" != "1" ]; then
    log "skipping default rootfs image build because STAR_BUILD_DEFAULT_ROOTFS=$STAR_BUILD_DEFAULT_ROOTFS"
    return
  fi

  local build_image="$STAR_DEFAULT_ROOTFS_IMAGE"
  case "$build_image" in
    containers-storage:*) build_image="${build_image#containers-storage:}" ;;
  esac

  local containerfile="${STAR_ROOT}/default-rootfs.Containerfile"
  cat >"$containerfile" <<EOF
FROM ${STAR_DEFAULT_ROOTFS_BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
    bash \\
    ca-certificates \\
    curl \\
    git \\
    latexmk \\
    less \\
    libatomic1 \\
    openssh-client \\
    procps \\
    python3 \\
    python3-pip \\
    python3-venv \\
    sudo \\
    texlive-fonts-recommended \\
    texlive-latex-base \\
    texlive-latex-recommended \\
    wget \\
  && python3 -m venv /opt/cocalc-jupyter \\
  && /opt/cocalc-jupyter/bin/pip install --no-cache-dir --upgrade pip wheel \\
  && /opt/cocalc-jupyter/bin/pip install --no-cache-dir ipykernel jupyterlab notebook \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter /usr/local/bin/jupyter \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-lab /usr/local/bin/jupyter-lab \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-notebook /usr/local/bin/jupyter-notebook \\
  && rm -rf /var/lib/apt/lists/*
EOF
  chown "$STAR_USER:$STAR_USER" "$containerfile"
  as_star_user "podman image exists '$build_image' >/dev/null 2>&1 && exit 0; podman build --pull=always -t '$build_image' -f '$containerfile' '$STAR_ROOT'"
}

write_env_files() {
  local site_master_key="${STAR_DATA}/secrets/site-master-key"
  if [ ! -f "$site_master_key" ]; then
    mkdir -p "$(dirname "$site_master_key")"
    openssl rand -base64 32 >"$site_master_key"
    chmod 600 "$site_master_key"
    chown "$STAR_USER:$STAR_USER" "$site_master_key"
  fi

  cat >/etc/cocalc/star/hub.env <<EOF
COCALC_PRODUCT=launchpad
COCALC_DB=postgres
COCALC_LOCAL_POSTGRES=1
DATA=${STAR_DATA}
COCALC_DATA_DIR=${STAR_DATA}
COCALC_LOCAL_PG_SOCKET_DIR=${STAR_DATA}/postgres-socket
COCALC_LOCAL_PG_ENV_FILE=${STAR_DATA}/local-postgres.env
COCALC_BACKUP_ROOT=${STAR_ROOT}/backup
PGHOST=${STAR_DATA}/postgres-socket
PGUSER=smc
PGDATABASE=smc
COCALC_SITE_MASTER_KEY_PATH=${site_master_key}
COCALC_SECRET_SETTINGS_KEY_PATH=${site_master_key}
COCALC_BASE_PORT=${STAR_BASE_PORT}
COCALC_HTTP_PORT=${STAR_BASE_PORT}
PORT=${STAR_BASE_PORT}
COCALC_SSHD_PORT=$((STAR_BASE_PORT + 1))
COCALC_OPEN_BROWSER=0
COCALC_ALLOW_INSECURE_HTTP_MODE=true
COCALC_DISABLE_ROOTFS_PORTABILITY_SEAL=1
COCALC_SETTING_DNS=${STAR_BASE_URL}
EOF
  chown "$STAR_USER:$STAR_USER" /etc/cocalc/star/hub.env
  chmod 600 /etc/cocalc/star/hub.env

  cat >/etc/cocalc/project-host.env <<EOF
PROJECT_HOST_ID=${STAR_HOST_ID}
PROJECT_HOST_NAME=star-local
PROJECT_HOST_REGION=local
PROJECT_HOST_PUBLIC_URL=http://127.0.0.1:9002
PROJECT_HOST_INTERNAL_URL=http://127.0.0.1:9002
PROJECT_HOST_SSH_SERVER=127.0.0.1:2222
MASTER_CONAT_SERVER=${STAR_BASE_URL}
COCALC_PROJECT_HOST_MASTER_CONAT_TOKEN_PATH=${STAR_PROJECT_HOST_DATA}/secrets/master-conat-token
COCALC_DATA=${STAR_PROJECT_HOST_DATA}
DATA=${STAR_PROJECT_HOST_DATA}
TMPDIR=${STAR_PROJECT_HOST_DATA}/tmp
COCALC_RUSTIC=${STAR_PROJECT_HOST_DATA}/rustic
COCALC_FILE_SERVER_MOUNTPOINT=/mnt/cocalc
COCALC_SHARED_SCRATCH_ENABLED=1
COCALC_SHARED_SCRATCH_HOST_MOUNT=/mnt/cocalc-scratch
COCALC_PODMAN_RUNTIME_DIR=/mnt/cocalc/data/tmp/cocalc-podman-runtime-$(id -u "$STAR_USER")
COCALC_PROJECT_BUNDLES=${SRC_ROOT}/packages/project/build
HOST=127.0.0.1
PORT=9002
PROJECT_RUNNER_NAME=0
COCALC_ALLOW_INSECURE_HTTP_MODE=true
DEBUG_CONSOLE=no
COCALC_PROJECT_HOST_LOG=${STAR_PROJECT_HOST_DATA}/log
EOF
  chown "$STAR_USER:$STAR_USER" /etc/cocalc/project-host.env
  chmod 600 /etc/cocalc/project-host.env
}

seed_database() {
  as_star_user "set -o pipefail && set -a && source /etc/cocalc/star/hub.env && set +a && cd '$SRC_ROOT' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 >/dev/null && STAR_PROJECT_HOST_ID='$STAR_HOST_ID' STAR_BASE_URL='$STAR_BASE_URL' STAR_MASTER_CONAT_TOKEN_PATH='$STAR_PROJECT_HOST_DATA/secrets/master-conat-token' STAR_DEFAULT_ROOTFS_IMAGE='$STAR_DEFAULT_ROOTFS_IMAGE' node scripts/star-poc/seed-star-poc.mjs | tee '$STAR_ROOT/bootstrap-result.json'"
}

install_systemd() {
  cat >/etc/systemd/system/cocalc-star-hub.service <<EOF
[Unit]
Description=CoCalc Star POC launchpad hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${STAR_USER}
Group=${STAR_USER}
WorkingDirectory=${SRC_ROOT}/packages/launchpad
EnvironmentFile=/etc/cocalc/star/hub.env
ExecStartPre=/bin/bash -lc 'if [ "\${COCALC_DB:-}" = "pglite" ]; then rm -f "\${COCALC_PGLITE_DATA_DIR:-\${DATA}/pglite}/postmaster.pid"; fi'
ExecStart=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && exec node bin/start.js --hostname=127.0.0.1'
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/systemd/system/cocalc-star-project-host.service <<EOF
[Unit]
Description=CoCalc Star POC local project host
After=network-online.target cocalc-star-hub.service
Wants=network-online.target
Requires=cocalc-star-hub.service

[Service]
Type=simple
User=${STAR_USER}
Group=${STAR_USER}
WorkingDirectory=${SRC_ROOT}/packages/project-host
EnvironmentFile=/etc/cocalc/project-host.env
Environment=COCALC_PROJECT_HOST_AGENT=1
Environment=COCALC_PROJECT_HOST_AGENT_INDEX=0
ExecStart=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && exec node dist/main.js --index 0'
ExecStop=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && node bin/start.js daemon stop 0'
Restart=always
RestartSec=5
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/caddy/Caddyfile <<EOF
:80 {
  reverse_proxy 127.0.0.1:${STAR_BASE_PORT}
}
EOF
  systemctl daemon-reload
  systemctl enable caddy cocalc-star-hub cocalc-star-project-host
}

configure_sudoers() {
  cat >/etc/sudoers.d/cocalc-project-host-runtime <<EOF
${STAR_USER} ALL=(root) NOPASSWD: /usr/local/sbin/cocalc-runtime-storage *
${STAR_USER} ALL=(root) NOPASSWD: /usr/local/sbin/cocalc-mount-data
${STAR_USER} ALL=(root) NOPASSWD: /usr/local/sbin/cocalc-project-host-rootctl *
EOF
  chmod 0440 /etc/sudoers.d/cocalc-project-host-runtime
  cat >/etc/sudoers.d/cocalc-star-poc-admin <<EOF
${STAR_USER} ALL=(root) NOPASSWD: /bin/systemctl *, /bin/journalctl *, /usr/bin/tee *, /usr/bin/install *, /bin/mount *, /bin/umount *, /usr/bin/loginctl *
EOF
  chmod 0440 /etc/sudoers.d/cocalc-star-poc-admin
  if [ "$STAR_REMOVE_GCP_SUDOERS" = "1" ]; then
    if id -nG "$STAR_USER" | tr ' ' '\n' | grep -qx google-sudoers; then
      gpasswd -d "$STAR_USER" google-sudoers || true
    fi
    rm -f /etc/sudoers.d/google-sudoers /etc/sudoers.d/google_sudoers
  fi
}

start_services() {
  systemctl restart caddy
  systemctl restart cocalc-star-hub
  systemctl restart cocalc-star-project-host
  sleep 5
  systemctl --no-pager --full status cocalc-star-hub cocalc-star-project-host || true
  cat "$STAR_ROOT/bootstrap-result.json"
}

require_root
install_packages
install_node
build_source
stop_existing_services
ensure_btrfs
install_wrappers
configure_users_and_dirs
build_default_rootfs_image
write_env_files
seed_database
install_systemd
configure_sudoers
start_services
