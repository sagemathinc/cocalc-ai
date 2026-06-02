#!/usr/bin/env bash
set -euo pipefail

if [ -z "${STAR_USER:-}" ]; then
  if [ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ]; then
    echo "[star] ERROR: set STAR_USER when running directly as root" >&2
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
STAR_PROJECT_HOST_REGION="${STAR_PROJECT_HOST_REGION:-wnam}"
STAR_BASE_PORT="${STAR_BASE_PORT:-9100}"
STAR_BASE_URL="${STAR_BASE_URL:-http://127.0.0.1:${STAR_BASE_PORT}}"
STAR_BTRFS_IMAGE="${STAR_BTRFS_IMAGE:-/var/lib/cocalc/btrfs.img}"
STAR_BTRFS_SIZE="${STAR_BTRFS_SIZE:-100G}"
STAR_BUILD="${STAR_BUILD:-1}"
STAR_BUILD_DEFAULT_ROOTFS="${STAR_BUILD_DEFAULT_ROOTFS:-1}"
STAR_DEFAULT_ROOTFS_IMAGE="${STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
STAR_DEFAULT_ROOTFS_BASE_IMAGE="${STAR_DEFAULT_ROOTFS_BASE_IMAGE:-docker.io/buildpack-deps:26.04}"
STAR_REMOVE_GCP_SUDOERS="${STAR_REMOVE_GCP_SUDOERS:-1}"
STAR_SUBID_RANGES="${STAR_SUBID_RANGES:-231072:65536 327680:4128768}"
STAR_HAS_GPU="${STAR_HAS_GPU:-0}"

log() {
  printf '[star] %s\n' "$*" >&2
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

host_has_nvidia_gpu() {
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    return 0
  fi
  if ls /dev/nvidia0 >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

install_nvidia_cdi_normalizer() {
  cat >/usr/local/sbin/cocalc-nvidia-cdi-normalize <<'PY'
#!/usr/bin/env python3
import sys
from pathlib import Path

COMPAT_VERSION = "0.5.0"
CDI_PATHS = (Path("/etc/cdi/nvidia.yaml"), Path("/var/run/cdi/nvidia.yaml"))


def strip_yaml_field(lines, field):
    out = []
    i = 0
    needle = f"{field}:"
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped == needle:
            indent = len(line) - len(line.lstrip(" "))
            i += 1
            while i < len(lines):
                next_line = lines[i]
                next_stripped = next_line.strip()
                if not next_stripped:
                    i += 1
                    continue
                next_indent = len(next_line) - len(next_line.lstrip(" "))
                if next_indent > indent:
                    i += 1
                    continue
                break
            continue
        out.append(line)
        i += 1
    return out


def normalize(path):
    if not path.exists():
        return False
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    lines = strip_yaml_field(lines, "additionalGids")
    changed_version = False
    for i, line in enumerate(lines):
        if line.startswith("cdiVersion:"):
            replacement = f"cdiVersion: {COMPAT_VERSION}\n"
            if line != replacement:
                lines[i] = replacement
                changed_version = True
            break
    updated = "".join(lines)
    if updated == original and not changed_version:
        return False
    path.write_text(updated, encoding="utf-8")
    path.chmod(0o644)
    return True


changed = False
paths = [Path(arg) for arg in sys.argv[1:]] or list(CDI_PATHS)
for path in paths:
    changed = normalize(path) or changed
raise SystemExit(0)
PY
  chmod 0755 /usr/local/sbin/cocalc-nvidia-cdi-normalize
}

install_gpu_support() {
  STAR_HAS_GPU=0
  if ! host_has_nvidia_gpu; then
    return
  fi
  STAR_HAS_GPU=1
  log "NVIDIA GPU detected; configuring Podman CDI support"
  run apt-get install -y ca-certificates gnupg
  rm -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  run bash -lc "curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg"
  run bash -lc "curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list"
  run apt-get update
  run apt-get install -y --allow-change-held-packages nvidia-container-toolkit
  ldconfig || true
  install_nvidia_cdi_normalizer
  mkdir -p /etc/cdi
  run nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
  [ -f /etc/cdi/nvidia.yaml ] || die "nvidia CDI generation did not create /etc/cdi/nvidia.yaml"
  usermod -aG video,render "$STAR_USER" || true
  cat >/usr/local/sbin/cocalc-nvidia-cdi <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  exit 0
fi
if [ ! -x /usr/bin/nvidia-ctk ]; then
  exit 0
fi
if [ -f /etc/cdi/nvidia.yaml ]; then
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
  exit 0
fi
ldconfig || true
if command -v nvidia-smi >/dev/null 2>&1 || ldconfig -p 2>/dev/null | grep -q libnvidia-ml.so.1; then
  /usr/bin/nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml || exit 0
  /usr/local/sbin/cocalc-nvidia-cdi-normalize || true
fi
exit 0
EOF
  chmod 0755 /usr/local/sbin/cocalc-nvidia-cdi
  cat >/etc/cron.d/cocalc-nvidia-cdi <<'EOF'
*/5 * * * * root /usr/local/sbin/cocalc-nvidia-cdi >/dev/null 2>&1
EOF
  chmod 0644 /etc/cron.d/cocalc-nvidia-cdi
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

ensure_exact_subid_file() {
  local path="$1"
  local tmp expected current line
  tmp="$(mktemp)"
  expected=""
  for range in $STAR_SUBID_RANGES; do
    expected="${expected}${STAR_USER}:${range}
"
  done
  current=""
  if [ -f "$path" ]; then
    current="$(grep -E "^${STAR_USER}:" "$path" || true)"
    current="${current}${current:+
}"
  fi

  if [ "$current" = "$expected" ]; then
    rm -f "$tmp"
    return
  fi

  if [ -f "$path" ]; then
    while IFS= read -r line; do
      case "$line" in
        "${STAR_USER}:"*) ;;
        *) printf '%s\n' "$line" >>"$tmp" ;;
      esac
    done <"$path"
  fi

  printf '%s' "$expected" >>"$tmp"
  install -m 0644 -o root -g root "$tmp" "$path"
  rm -f "$tmp"
  log "set rootless subid allocation for $STAR_USER in $path to $STAR_SUBID_RANGES"
}

ensure_subuids() {
  ensure_exact_subid_file /etc/subuid
  ensure_exact_subid_file /etc/subgid
  as_star_user 'podman system migrate >/dev/null 2>&1 || true'
}

build_source() {
  [ -d "$SRC_ROOT/packages" ] || die "missing source checkout at $SRC_ROOT"
  if [ "$STAR_BUILD" = "0" ]; then
    log "skipping build because STAR_BUILD=0"
    return
  fi
  as_star_user "cd '$SRC_ROOT' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 && export COCALC_SETUP_PROFILE=star && if command -v corepack >/dev/null 2>&1; then corepack enable; fi && if ! command -v pnpm >/dev/null 2>&1; then npm install -g pnpm@10.33.0; fi && ./workspaces.py install && pnpm --filter @cocalc/app-notebook build && ./workspaces.py build --dev && pnpm python-api"
  as_star_user "cd '$SRC_ROOT/packages/project' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 && pnpm build:bundle"
}

host_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    *) die "unsupported architecture for Star runtime bundle: $(uname -m)" ;;
  esac
}

extract_tarball_if_needed() {
  local tarball="$1"
  local parent="$2"
  local marker="$3"
  [ -f "$tarball" ] || die "missing runtime artifact: $tarball"
  if [ -e "$marker" ]; then
    return
  fi
  mkdir -p "$parent"
  rm -rf "$marker"
  run tar -C "$parent" -Jxf "$tarball"
}

prepare_runtime_artifacts() {
  if [ -f "$SRC_ROOT/packages/launchpad/build/bundle.tar.xz" ]; then
    extract_tarball_if_needed \
      "$SRC_ROOT/packages/launchpad/build/bundle.tar.xz" \
      "$SRC_ROOT/packages/launchpad/build" \
      "$SRC_ROOT/packages/launchpad/build/bundle/bundle/index.js"
  fi
  if [ -f "$SRC_ROOT/packages/project-host/build/bundle-linux.tar.xz" ]; then
    extract_tarball_if_needed \
      "$SRC_ROOT/packages/project-host/build/bundle-linux.tar.xz" \
      "$SRC_ROOT/packages/project-host/build" \
      "$SRC_ROOT/packages/project-host/build/bundle/main/index.js"
  fi
  if [ -f "$SRC_ROOT/packages/project/build/bundle-linux.tar.xz" ]; then
    extract_tarball_if_needed \
      "$SRC_ROOT/packages/project/build/bundle-linux.tar.xz" \
      "$SRC_ROOT/packages/project/build" \
      "$SRC_ROOT/packages/project/build/bundle/bundle/index.js"
    ln -sfn "$SRC_ROOT/packages/project/build/bundle" \
      "$SRC_ROOT/packages/project/build/current"
  fi
  local arch tools_tarball tools_release tools_current
  arch="$(host_arch)"
  tools_tarball="$SRC_ROOT/packages/project/build/tools-linux-${arch}.tar.xz"
  if [ -f "$tools_tarball" ]; then
    tools_release="$SRC_ROOT/packages/project/build/tools/${STAR_RELEASE_ID:-runtime}"
    tools_current="$SRC_ROOT/packages/project/build/tools/current"
    if [ ! -x "$tools_release/bin/dropbear" ]; then
      rm -rf "$tools_release"
      mkdir -p "$tools_release"
      run tar -C "$tools_release" -Jxf "$tools_tarball"
    fi
    ln -sfn "$tools_release/bin" "$tools_current"
  fi
  chown -R "$STAR_USER:$STAR_USER" "$SRC_ROOT/packages" "$SRC_ROOT/scripts/star-poc/build" 2>/dev/null || true
}

ensure_btrfs() {
  mkdir -p /var/lib/cocalc /mnt/cocalc
  if [ ! -f "$STAR_BTRFS_IMAGE" ]; then
    run truncate -s "$STAR_BTRFS_SIZE" "$STAR_BTRFS_IMAGE"
    run mkfs.btrfs -f "$STAR_BTRFS_IMAGE"
  fi
  if ! grep -qF "$STAR_BTRFS_IMAGE /mnt/cocalc btrfs" /etc/fstab; then
    printf '%s /mnt/cocalc btrfs loop,noatime,compress=zstd 0 0 # cocalc-star\n' "$STAR_BTRFS_IMAGE" >>/etc/fstab
  fi
  if ! mountpoint -q /mnt/cocalc; then
    run mount /mnt/cocalc
  fi
  mkdir -p /mnt/cocalc/data/tmp /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
  chmod 1777 /mnt/cocalc/data/tmp
  if ! grep -qF "/mnt/cocalc/shared-scratch /mnt/cocalc-scratch none bind" /etc/fstab; then
    printf '/mnt/cocalc/shared-scratch /mnt/cocalc-scratch none bind 0 0 # cocalc-star\n' >>/etc/fstab
  fi
  if ! mountpoint -q /mnt/cocalc-scratch; then
    run mount /mnt/cocalc-scratch
  fi
  chown root:root /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
  chmod 0755 /mnt/cocalc/shared-scratch /mnt/cocalc-scratch
  install -d -o "$STAR_USER" -g "$STAR_USER" -m 0775 /mnt/cocalc/shared-scratch/shared
}

install_wrappers() {
  python3 - "$SRC_ROOT" <<'PY'
import importlib.util
import sys
from pathlib import Path

src_root = Path(sys.argv[1])
paths = [
    src_root / "packages/server/cloud/bootstrap/bootstrap.py",
    src_root / "packages/launchpad/build/bundle/bundle/bootstrap/bootstrap.py",
]
path = next((path for path in paths if path.exists()), None)
if path is None:
    raise RuntimeError("unable to find bootstrap.py in Star source or bundle")
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
  systemctl start "user@$(id -u "$STAR_USER").service" >/dev/null 2>&1 || true
  mkdir -p \
    "$STAR_DATA/secrets" \
    "$STAR_PROJECT_HOST_DATA/tmp" \
    "$STAR_PROJECT_HOST_DATA/cache/images" \
    "$STAR_PROJECT_HOST_DATA/cache/project-roots" \
    "$STAR_PROJECT_HOST_DATA/secrets" \
    "$STAR_ROOT/backup" \
    /etc/cocalc/star
  chmod 700 "$STAR_PROJECT_HOST_DATA/tmp"
  # Do not recursively chown STAR_ROOT. It contains cached RootFS trees whose
  # numeric ownership is part of the container runtime contract.
  chown -R "$STAR_USER:$STAR_USER" \
    "$STAR_DATA" \
    "$STAR_ROOT/backup" \
    "$STAR_PROJECT_HOST_DATA/secrets" \
    "$STAR_PROJECT_HOST_DATA/tmp"
  chown "$STAR_USER:$STAR_USER" \
    "$STAR_ROOT" \
    "$STAR_PROJECT_HOST_DATA" \
    "$STAR_PROJECT_HOST_DATA/tmp" \
    "$STAR_PROJECT_HOST_DATA/cache" \
    "$STAR_PROJECT_HOST_DATA/cache/images" \
    "$STAR_PROJECT_HOST_DATA/cache/project-roots" \
    "$STAR_PROJECT_HOST_DATA/secrets"
  find "$STAR_ROOT" -maxdepth 1 -type f \
    -exec chown "$STAR_USER:$STAR_USER" {} +
  find "$STAR_PROJECT_HOST_DATA" -maxdepth 1 -type f \
    -exec chown "$STAR_USER:$STAR_USER" {} +
  find "$STAR_PROJECT_HOST_DATA/cache/images" -maxdepth 1 -type f -name '.*.json' \
    -exec chown "$STAR_USER:$STAR_USER" {} +
  chown -R "$STAR_USER:$STAR_USER" /mnt/cocalc/data
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
  && /opt/cocalc-jupyter/bin/python -m ipykernel install --prefix=/usr/local --name python3 \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter /usr/local/bin/jupyter \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-lab /usr/local/bin/jupyter-lab \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-notebook /usr/local/bin/jupyter-notebook \\
  && mkdir -p \\
    /home/user \\
    /scratch \\
    /run/secrets/cocalc \\
    /opt/cocalc/bin \\
    /opt/cocalc/lib \\
    /opt/cocalc/runtime-lib \\
    /opt/cocalc/project-bundle \\
    /opt/cocalc/project-bundles \\
  && chmod 0755 /home/user /scratch /run/secrets /run/secrets/cocalc /opt/cocalc \\
  && rm -rf /var/lib/apt/lists/*
EOF
  chown "$STAR_USER:$STAR_USER" "$containerfile"
  as_star_user "podman image exists '$build_image' >/dev/null 2>&1 && exit 0; podman build --pull=always -t '$build_image' -f '$containerfile' '$STAR_ROOT'"
}

ensure_default_rootfs_cache() {
  if [ -z "${STAR_DEFAULT_ROOTFS_IMAGE:-}" ]; then
    return
  fi
  local script="scripts/star-poc/ensure-rootfs-cache.mjs"
  if [ -f "$SRC_ROOT/scripts/star-poc/build/ensure-rootfs-cache/index.cjs" ]; then
    script="scripts/star-poc/build/ensure-rootfs-cache/index.cjs"
  elif [ -f "$SRC_ROOT/scripts/star-poc/ensure-rootfs-cache.cjs" ]; then
    script="scripts/star-poc/ensure-rootfs-cache.cjs"
  fi
  as_star_user "set -a && source /etc/cocalc/project-host.env && set +a && cd '$SRC_ROOT' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 >/dev/null && NODE_PATH='$SRC_ROOT/packages/node_modules' STAR_DEFAULT_ROOTFS_IMAGE='$STAR_DEFAULT_ROOTFS_IMAGE' node '$script'"
}

write_env_files() {
  local site_master_key="${STAR_DATA}/secrets/site-master-key"
  if [ ! -f "$site_master_key" ]; then
    mkdir -p "$(dirname "$site_master_key")"
    openssl rand -base64 32 >"$site_master_key"
    chmod 600 "$site_master_key"
    chown "$STAR_USER:$STAR_USER" "$site_master_key"
  fi

  {
    printf 'STAR_USER=%q\n' "$STAR_USER"
    printf 'STAR_HOME=%q\n' "$STAR_HOME"
    printf 'STAR_ROOT=%q\n' "$STAR_ROOT"
    printf 'STAR_DATA=%q\n' "$STAR_DATA"
    printf 'STAR_PROJECT_HOST_DATA=%q\n' "$STAR_PROJECT_HOST_DATA"
    printf 'STAR_BASE_PORT=%q\n' "$STAR_BASE_PORT"
    printf 'STAR_BASE_URL=%q\n' "$STAR_BASE_URL"
    printf 'STAR_API=%q\n' "$STAR_BASE_URL"
    printf 'STAR_PROJECT_HOST_REGION=%q\n' "$STAR_PROJECT_HOST_REGION"
    printf 'STAR_INSTALL_ROOT=%q\n' "${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
    printf 'STAR_DEFAULT_ROOTFS_IMAGE=%q\n' "$STAR_DEFAULT_ROOTFS_IMAGE"
  } >/etc/cocalc/star/config.env
  chown root:root /etc/cocalc/star/config.env
  chmod 644 /etc/cocalc/star/config.env

  cat >/etc/cocalc/star/hub.env <<EOF
COCALC_PRODUCT=launchpad
COCALC_SETUP_PROFILE=star
COCALC_ROOT=${SRC_ROOT}
COCALC_DB=postgres
COCALC_LOCAL_POSTGRES=1
DATA=${STAR_DATA}
COCALC_DATA_DIR=${STAR_DATA}
COCALC_LOCAL_POSTGRES_ADMIN_USER=smc
COCALC_LOCAL_PG_SOCKET_DIR=${STAR_DATA}/postgres-socket
COCALC_LOCAL_PG_ENV_FILE=${STAR_DATA}/local-postgres.env
COCALC_BACKUP_ROOT=${STAR_ROOT}/backup
PGHOST=${STAR_DATA}/postgres-socket
PGUSER=smc
PGDATABASE=smc
COCALC_SITE_MASTER_KEY_PATH=${site_master_key}
COCALC_SECRET_SETTINGS_KEY_PATH=${site_master_key}
COCALC_BIN_PATH=${SRC_ROOT}/packages/project/build/tools/current
COCALC_BASE_PORT=${STAR_BASE_PORT}
COCALC_HTTP_PORT=${STAR_BASE_PORT}
PORT=${STAR_BASE_PORT}
COCALC_SSHD_PORT=$((STAR_BASE_PORT + 1))
COCALC_OPEN_BROWSER=0
COCALC_ALLOW_INSECURE_HTTP_MODE=true
COCALC_SETTING_DNS=${STAR_BASE_URL}
EOF
  chown "$STAR_USER:$STAR_USER" /etc/cocalc/star/hub.env
  chmod 600 /etc/cocalc/star/hub.env

  cat >/etc/cocalc/project-host.env <<EOF
PROJECT_HOST_ID=${STAR_HOST_ID}
PROJECT_HOST_NAME=star-local
COCALC_ROOT=${SRC_ROOT}
PROJECT_HOST_REGION=${STAR_PROJECT_HOST_REGION}
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
COCALC_PROJECT_HOST_CPU_USAGE_MODE=observe
COCALC_PROJECT_TOOLS=$([ -d "${SRC_ROOT}/packages/project/build/tools/current" ] && printf '%s' "${SRC_ROOT}/packages/project/build/tools/current" || printf '%s' "${SRC_ROOT}/packages/backend/node_modules/.bin")
COCALC_PROJECT_BUNDLES=${SRC_ROOT}/packages/project/build
COCALC_PROJECT_HOST_CONAT_ROUTER_HOST=0.0.0.0
COCALC_PROJECT_HOST_CONAT_ROUTER_PORT=9112
COCALC_PROJECT_HOST_CONAT_PERSIST_HEALTH_PORT=9212
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
  local script="scripts/star-poc/seed-star-poc.cjs"
  if [ -f "$SRC_ROOT/scripts/star-poc/build/seed-star-poc/index.cjs" ]; then
    script="scripts/star-poc/build/seed-star-poc/index.cjs"
  fi
  as_star_user "set -a && source /etc/cocalc/star/hub.env && set +a && cd '$SRC_ROOT' && source \"\$HOME/.nvm/nvm.sh\" && nvm use 26 >/dev/null && NODE_PATH='$SRC_ROOT/packages/node_modules' STAR_PROJECT_HOST_ID='$STAR_HOST_ID' STAR_PROJECT_HOST_REGION='$STAR_PROJECT_HOST_REGION' STAR_BASE_URL='$STAR_BASE_URL' STAR_MASTER_CONAT_TOKEN_PATH='$STAR_PROJECT_HOST_DATA/secrets/master-conat-token' STAR_DEFAULT_ROOTFS_IMAGE='$STAR_DEFAULT_ROOTFS_IMAGE' STAR_BOOTSTRAP_RESULT_PATH='$STAR_ROOT/bootstrap-result.json' STAR_HAS_GPU='${STAR_HAS_GPU:-0}' node '$script'"
}

install_systemd() {
  local hub_unit project_host_unit caddy_config hub_workdir hub_exec hub_bundle_env project_host_workdir project_host_exec project_host_stop api_v2_routes_bundle
  hub_unit="$(mktemp)"
  project_host_unit="$(mktemp)"
  caddy_config="$(mktemp)"
  if [ -f "$SRC_ROOT/packages/launchpad/build/bundle/bundle/index.js" ]; then
    hub_workdir="$SRC_ROOT/packages/launchpad/build/bundle"
    hub_exec='exec node bundle/index.js --hostname=127.0.0.1'
    hub_bundle_env="Environment=COCALC_BUNDLE_DIR=${hub_workdir}"
    api_v2_routes_bundle="$SRC_ROOT/scripts/star-poc/build/api-v2-routes-bundle/index.cjs"
    if [ ! -f "$api_v2_routes_bundle" ]; then
      api_v2_routes_bundle="${hub_workdir}/api-v2-routes-bundle/index.cjs"
    fi
    if [ -f "$api_v2_routes_bundle" ]; then
      hub_bundle_env="${hub_bundle_env}
Environment=COCALC_API_V2_ROUTES_BUNDLE=${api_v2_routes_bundle}"
    fi
  else
    hub_workdir="$SRC_ROOT/packages/launchpad"
    hub_exec='exec node bin/start.js --hostname=127.0.0.1'
    hub_bundle_env=""
  fi
  if [ -f "$SRC_ROOT/packages/project-host/build/bundle/main/index.js" ]; then
    project_host_workdir="$SRC_ROOT/packages/project-host/build/bundle"
    project_host_exec='exec node main/index.js --index 0'
    project_host_stop='node bundle/index.js daemon stop 0'
  else
    project_host_workdir="$SRC_ROOT/packages/project-host"
    project_host_exec='exec node dist/main.js --index 0'
    project_host_stop='node bin/start.js daemon stop 0'
  fi

  cat >"$hub_unit" <<EOF
[Unit]
Description=CoCalc Star launchpad hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${STAR_USER}
Group=${STAR_USER}
WorkingDirectory=${hub_workdir}
EnvironmentFile=/etc/cocalc/star/hub.env
${hub_bundle_env}
ExecStartPre=/bin/bash -lc 'if [ "\${COCALC_DB:-}" = "pglite" ]; then rm -f "\${COCALC_PGLITE_DATA_DIR:-\${DATA}/pglite}/postmaster.pid"; fi'
ExecStartPre=/bin/bash -lc 'pkill -TERM -f "[l]aunchpad-sshd/sshd_config" 2>/dev/null || true'
ExecStart=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && ${hub_exec}'
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

  cat >"$project_host_unit" <<EOF
[Unit]
Description=CoCalc Star local project host
After=network-online.target cocalc-star-hub.service
Wants=network-online.target cocalc-star-hub.service

[Service]
Type=simple
User=${STAR_USER}
Group=${STAR_USER}
WorkingDirectory=${project_host_workdir}
EnvironmentFile=/etc/cocalc/project-host.env
Environment=COCALC_PROJECT_HOST_AGENT=1
Environment=COCALC_PROJECT_HOST_AGENT_INDEX=0
ExecStart=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && ${project_host_exec}'
ExecStop=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 26 >/dev/null && ${project_host_stop}'
Restart=always
RestartSec=5
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
EOF

  cat >"$caddy_config" <<EOF
:80 {
  reverse_proxy 127.0.0.1:${STAR_BASE_PORT}
}
EOF

  grep -q '^ExecStart=' "$hub_unit" || die "generated hub systemd unit is invalid"
  grep -q '^ExecStart=' "$project_host_unit" || die "generated project-host systemd unit is invalid"
  install -m 0644 -o root -g root "$hub_unit" /etc/systemd/system/cocalc-star-hub.service
  install -m 0644 -o root -g root "$project_host_unit" /etc/systemd/system/cocalc-star-project-host.service
  install -m 0644 -o root -g root "$caddy_config" /etc/caddy/Caddyfile
  grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-hub.service || die "installed hub systemd unit is invalid"
  grep -q '^ExecStart=' /etc/systemd/system/cocalc-star-project-host.service || die "installed project-host systemd unit is invalid"
  rm -f "$hub_unit" "$project_host_unit" "$caddy_config"

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
  rm -f /etc/sudoers.d/cocalc-star-poc-admin
  cat >/etc/sudoers.d/cocalc-star-admin <<EOF
${STAR_USER} ALL=(root) NOPASSWD: /bin/systemctl *, /bin/journalctl *, /usr/bin/tee *, /usr/bin/install *, /bin/mount *, /bin/umount *, /usr/bin/loginctl *
EOF
  chmod 0440 /etc/sudoers.d/cocalc-star-admin
  remove_broad_sudoers_for_star_user
  if [ "$STAR_REMOVE_GCP_SUDOERS" = "1" ]; then
    if id -nG "$STAR_USER" | tr ' ' '\n' | grep -qx google-sudoers; then
      gpasswd -d "$STAR_USER" google-sudoers || true
    fi
    rm -f /etc/sudoers.d/google-sudoers /etc/sudoers.d/google_sudoers
  fi
}

remove_broad_sudoers_for_star_user() {
  local path tmp
  shopt -s nullglob
  for path in /etc/sudoers.d/*; do
    [ -f "$path" ] || continue
    case "$(basename "$path")" in
      cocalc-*) continue ;;
    esac
    if ! awk -v user="$STAR_USER" '
      $1 == user && $0 ~ /NOPASSWD:[[:space:]]*ALL([[:space:]]|$|,)/ {
        found = 1
      }
      END { exit found ? 0 : 1 }
    ' "$path"; then
      continue
    fi
    log "removing broad sudoers grant for ${STAR_USER} from ${path}"
    tmp="$(mktemp)"
    awk -v user="$STAR_USER" '
      $1 == user && $0 ~ /NOPASSWD:[[:space:]]*ALL([[:space:]]|$|,)/ {
        next
      }
      { print }
    ' "$path" >"$tmp"
    if [ -s "$tmp" ]; then
      install -m 0440 -o root -g root "$tmp" "$path"
    else
      rm -f "$path"
    fi
    rm -f "$tmp"
  done
  shopt -u nullglob
}

start_services() {
  systemctl restart caddy
  systemctl restart cocalc-star-hub
  systemctl restart cocalc-star-project-host
  log "waiting for ${STAR_BASE_URL}/customize"
  for _ in $(seq 1 60); do
    if curl -fsS "${STAR_BASE_URL}/customize" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  sync
  systemctl --no-pager --full status cocalc-star-hub cocalc-star-project-host || true
  cat "$STAR_ROOT/bootstrap-result.json"
}

require_root
install_packages
install_gpu_support
ensure_subuids
install_node
build_source
prepare_runtime_artifacts
stop_existing_services
ensure_btrfs
install_wrappers
configure_sudoers
configure_users_and_dirs
build_default_rootfs_image
write_env_files
ensure_default_rootfs_cache
seed_database
install_systemd
start_services
