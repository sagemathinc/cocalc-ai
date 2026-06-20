#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
BUILD_RELEASE="${SRC_ROOT}/scripts/star/build-star-release.sh"

TAG="${COCALC_STAR_DOCKER_TAG:-cocalc/star:preview}"
RELEASE_ARTIFACT="${COCALC_STAR_DOCKER_RELEASE_ARTIFACT:-}"
BUILD_RUNTIME="${COCALC_STAR_DOCKER_BUILD_RUNTIME:-1}"
BUILD_ROOTFS_CACHE="${COCALC_STAR_DOCKER_BUILD_ROOTFS_CACHE:-1}"
ROOTFS_CACHE_ARTIFACT="${COCALC_STAR_DOCKER_ROOTFS_CACHE_ARTIFACT:-}"
CACHE_BTRFS_SIZE="${COCALC_STAR_DOCKER_CACHE_BTRFS_SIZE:-20G}"
BUILD_ROOTFS_CACHE_ALLOW_DEGRADED="${COCALC_STAR_DOCKER_CACHE_ALLOW_DEGRADED:-1}"
ROOTFS_BASE_IMAGE="${COCALC_STAR_DOCKER_ROOTFS_BASE_IMAGE:-docker.io/buildpack-deps:26.04}"
ROOTFS_VERSION="${COCALC_STAR_DOCKER_ROOTFS_VERSION:-20260609-python-venv}"
ROOTFS_IMAGE_NAME="${COCALC_STAR_DOCKER_ROOTFS_IMAGE_NAME:-containers-storage:localhost/cocalc-star-rootfs:latest}"
DOCKER="${DOCKER:-docker}"
CONTEXT_ROOT="${COCALC_STAR_DOCKER_CONTEXT_ROOT:-${REPO_ROOT}/dist/star/docker-preview}"
KEEP_CONTEXT=0

log() {
  printf '[star-docker-build] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage: build-image.sh [options]

Build the CoCalc Star Docker preview image.

Options:
  --tag <name>             Docker tag to produce (default: cocalc/star:preview)
  --release-artifact <tgz> Use an existing cocalc-star release artifact
  --skip-runtime-build     Package current runtime artifacts without rebuilding
  --rootfs-cache <tgz>     Use an existing prebuilt RootFS cache artifact
  --skip-rootfs-cache      Do not prebuild/embed the default RootFS cache
  --cache-btrfs-size <size>
                          Btrfs image size for the cache builder container
                          (default: 20G)
  --docker <command>       Docker-compatible CLI (default: docker; may be
                          "sudo docker")
  --keep-context           keep the temporary Docker build context
  -h, --help               show this help

Environment:
  COCALC_STAR_DOCKER_TAG
  COCALC_STAR_DOCKER_RELEASE_ARTIFACT
  COCALC_STAR_DOCKER_BUILD_RUNTIME=0
  COCALC_STAR_DOCKER_BUILD_ROOTFS_CACHE=0
  COCALC_STAR_DOCKER_ROOTFS_CACHE_ARTIFACT
  COCALC_STAR_DOCKER_CACHE_BTRFS_SIZE=20G
  COCALC_STAR_DOCKER_CACHE_ALLOW_DEGRADED=1
  COCALC_STAR_DOCKER_CONTEXT_ROOT

The generated image expects rootful Docker and systemd support at runtime, e.g.

  docker run --privileged --cgroupns=host \\
    --security-opt seccomp=unconfined \\
    --tmpfs /run --tmpfs /run/lock \\
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \\
    -v cocalc-star-data:/var/lib/cocalc \\
    -p 8170:80 cocalc/star:preview
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --release-artifact)
      RELEASE_ARTIFACT="$2"
      shift 2
      ;;
    --skip-runtime-build)
      BUILD_RUNTIME=0
      shift
      ;;
    --rootfs-cache)
      ROOTFS_CACHE_ARTIFACT="$2"
      BUILD_ROOTFS_CACHE=0
      shift 2
      ;;
    --skip-rootfs-cache)
      BUILD_ROOTFS_CACHE=0
      shift
      ;;
    --cache-btrfs-size)
      CACHE_BTRFS_SIZE="$2"
      shift 2
      ;;
    --docker)
      DOCKER="$2"
      shift 2
      ;;
    --keep-context)
      KEEP_CONTEXT=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

DOCKER_CMD=()
read -r -a DOCKER_CMD <<<"$DOCKER"
[ "${#DOCKER_CMD[@]}" -gt 0 ] || die "empty Docker CLI command"
command -v "${DOCKER_CMD[0]}" >/dev/null 2>&1 ||
  die "missing Docker CLI: ${DOCKER_CMD[0]}"

docker_cli() {
  "${DOCKER_CMD[@]}" "$@"
}

if ! docker_cli info >/dev/null 2>&1; then
  if [[ "${DOCKER_CMD[0]}" != "sudo" ]] && command -v sudo >/dev/null 2>&1; then
    if sudo -n "${DOCKER_CMD[@]}" info >/dev/null 2>&1; then
      DOCKER_CMD=(sudo -n "${DOCKER_CMD[@]}")
      log "using sudo for Docker CLI"
    else
      log "Docker CLI is not usable without sudo; trying sudo for Docker commands"
      DOCKER_CMD=(sudo "${DOCKER_CMD[@]}")
      docker_cli info >/dev/null ||
        die "Docker CLI failed even when invoked through sudo"
    fi
  else
    die "Docker CLI failed; ensure Docker is running and the current user can access the Docker socket"
  fi
fi
DOCKER_DISPLAY="${DOCKER_CMD[*]}"
[ -x "$BUILD_RELEASE" ] || die "missing Star release builder: $BUILD_RELEASE"

if [[ -z "$RELEASE_ARTIFACT" ]]; then
  release_dir="${REPO_ROOT}/dist/star/docker-preview"
  mkdir -p "$release_dir"
  release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf nogit)"
  RELEASE_ARTIFACT="${release_dir}/cocalc-star-docker-preview-${release_id}.tar.gz"
  log "building runtime Star release artifact: $RELEASE_ARTIFACT"
  (
    cd "$REPO_ROOT"
    STAR_RELEASE_MODE=runtime \
      STAR_RUNTIME_BUILD="$BUILD_RUNTIME" \
      STAR_RELEASE_ID="$release_id" \
      "$BUILD_RELEASE" "$RELEASE_ARTIFACT"
  )
else
  RELEASE_ARTIFACT="$(realpath "$RELEASE_ARTIFACT")"
  [ -f "$RELEASE_ARTIFACT" ] || die "release artifact does not exist: $RELEASE_ARTIFACT"
fi

context=""
cleanup() {
  if [[ -n "$context" && "$KEEP_CONTEXT" -eq 1 ]]; then
    log "kept Docker build context: $context"
  elif [[ -n "$context" ]]; then
    rm -rf "$context"
  fi
}
trap cleanup EXIT

make_context() {
  local rootfs_cache="${1:-}"
  if [[ -n "$context" && "$KEEP_CONTEXT" -ne 1 ]]; then
    rm -rf "$context"
  fi
  mkdir -p "$CONTEXT_ROOT"
  context="$(mktemp -d "${CONTEXT_ROOT}/docker-context.XXXXXX")"
  cp "$SCRIPT_DIR/Dockerfile" "$context/Dockerfile"
  cp "$SCRIPT_DIR/cocalc-star-docker-preflight.sh" "$context/cocalc-star-docker-preflight.sh"
  cp "$SCRIPT_DIR/cocalc-star-docker-init.sh" "$context/cocalc-star-docker-init.sh"
  cp "$SCRIPT_DIR/cocalc-star-docker-entrypoint.sh" "$context/cocalc-star-docker-entrypoint.sh"
  cp "$SCRIPT_DIR/cocalc-star-docker-init.service" "$context/cocalc-star-docker-init.service"
  cp "$RELEASE_ARTIFACT" "$context/cocalc-star-release.tar.gz"
  if [[ -n "$rootfs_cache" ]]; then
    cp "$rootfs_cache" "$context/cocalc-star-rootfs-cache.tar.gz"
  else
    : >"$context/cocalc-star-rootfs-cache.tar.gz"
  fi
}

build_image() {
  local tag="$1"
  local rootfs_cache="${2:-}"
  make_context "$rootfs_cache"
  log "building Docker image $tag"
  docker_cli build -t "$tag" "$context"
}

dump_builder_diagnostics() {
  local container="$1"
  log "RootFS cache builder diagnostics for $container"
  log "--- docker logs: $container ---"
  docker_cli logs "$container" 2>&1 || true
  log "--- cocalc-star-docker-init log ---"
  docker_cli exec "$container" tail -n 400 /var/log/cocalc-star-docker-init.log 2>&1 || true
  log "--- systemd unit status ---"
  docker_cli exec "$container" systemctl status cocalc-star-docker-init.service --no-pager 2>&1 || true
  log "--- systemd unit journal ---"
  docker_cli exec "$container" journalctl -u cocalc-star-docker-init.service -n 400 --no-pager 2>&1 || true
  log "--- rootfs build containerfile ---"
  docker_cli exec "$container" sed -n '1,220p' /var/lib/cocalc/star/default-rootfs.Containerfile 2>&1 || true
  log "--- podman state ---"
  docker_cli exec "$container" sudo -u cocalc-star bash -lc 'podman ps -a && podman images' 2>&1 || true
}

wait_for_builder_container() {
  local container="$1"
  local deadline=$((SECONDS + 2400))
  local last_log=0
  while ((SECONDS < deadline)); do
    local result active
    result="$(docker_cli exec "$container" systemctl show -p Result --value cocalc-star-docker-init.service 2>/dev/null || true)"
    active="$(docker_cli exec "$container" systemctl is-active cocalc-star-docker-init.service 2>/dev/null || true)"
    if [[ "$result" == "success" && "$active" == "active" ]]; then
      return 0
    fi
    if [[ -n "$result" && "$result" != "success" ]]; then
      dump_builder_diagnostics "$container"
      die "RootFS cache builder failed: systemd result=$result"
    fi
    if ((SECONDS - last_log >= 30)); then
      log "waiting for RootFS cache builder: active=${active:-unknown} result=${result:-unknown}"
      last_log="$SECONDS"
    fi
    sleep 5
  done
  dump_builder_diagnostics "$container"
  die "RootFS cache builder timed out"
}

build_rootfs_cache_artifact() {
  local output="$1"
  local suffix rootfs_context rootfs_tag rootfs_container packer volume
  suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mkdir -p "$CONTEXT_ROOT"
  rootfs_context="$(mktemp -d "${CONTEXT_ROOT}/rootfs-context.XXXXXX")"
  rootfs_tag="cocalc-star-rootfs-cache-source:${suffix}"
  rootfs_container="cocalc-star-rootfs-cache-source-${suffix}"
  packer="cocalc-star-rootfs-cache-pack-${suffix}"
  volume="cocalc-star-rootfs-cache-pack-${suffix}"

  cleanup_builder() {
    docker_cli rm -f "$rootfs_container" >/dev/null 2>&1 || true
    docker_cli rm -f "$packer" >/dev/null 2>&1 || true
    docker_cli volume rm "$volume" >/dev/null 2>&1 || true
    docker_cli image rm "$rootfs_tag" >/dev/null 2>&1 || true
    rm -rf "$rootfs_context"
  }
  trap 'cleanup_builder; cleanup' EXIT

  cat >"$rootfs_context/Dockerfile" <<EOF
FROM ${ROOTFS_BASE_IMAGE}

LABEL com.cocalc.star.default_rootfs_version="${ROOTFS_VERSION}"

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
  && /opt/cocalc-jupyter/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \\
  && /opt/cocalc-jupyter/bin/pip install --no-cache-dir \\
    ipykernel \\
    ipywidgets \\
    jupyterlab \\
    matplotlib \\
    notebook \\
    numpy \\
    pandas \\
    scipy \\
    scikit-learn \\
    sympy \\
    uv \\
  && /opt/cocalc-jupyter/bin/python -m ipykernel install --prefix=/usr/local --name python3 \\
  && ln -s /opt/cocalc-jupyter/bin/python /usr/local/bin/python \\
  && ln -s /opt/cocalc-jupyter/bin/python /usr/local/bin/python3 \\
  && ln -s /opt/cocalc-jupyter/bin/pip /usr/local/bin/pip \\
  && ln -s /opt/cocalc-jupyter/bin/pip /usr/local/bin/pip3 \\
  && ln -s /opt/cocalc-jupyter/bin/uv /usr/local/bin/uv \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter /usr/local/bin/jupyter \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-lab /usr/local/bin/jupyter-lab \\
  && ln -s /opt/cocalc-jupyter/bin/jupyter-notebook /usr/local/bin/jupyter-notebook \\
  && chown -R 2001:2001 /opt/cocalc-jupyter \\
  && mkdir -p \\
    /home/user \\
    /scratch \\
    /run/secrets/cocalc \\
    /opt/cocalc/bin \\
    /opt/cocalc/bin2 \\
    /opt/cocalc/lib \\
    /opt/cocalc/runtime-lib \\
    /opt/cocalc/src \\
    /opt/cocalc/project-bundle \\
    /opt/cocalc/project-bundles \\
  && chmod 0755 /home/user /scratch /run/secrets /run/secrets/cocalc /opt/cocalc \\
  && rm -rf /var/lib/apt/lists/*
EOF

  log "building RootFS cache source image $rootfs_tag"
  docker_cli build --pull=always -t "$rootfs_tag" "$rootfs_context"
  docker_cli create --name "$rootfs_container" "$rootfs_tag" >/dev/null

  local cache_key metadata_path inspect_path
  cache_key="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$ROOTFS_IMAGE_NAME")"
  metadata_path="${rootfs_context}/normalized.json"
  inspect_path="${rootfs_context}/inspect.json"
  docker_cli image inspect "$rootfs_tag" --format '{{json .}}' >"$inspect_path"
  node - "$metadata_path" "$ROOTFS_IMAGE_NAME" "$cache_key" <<'EOF'
const fs = require("fs");
const [file, image, cacheKey] = process.argv.slice(2);
fs.writeFileSync(
  file,
  `${JSON.stringify(
    {
      version: 11,
      normalized_at: new Date().toISOString(),
      image,
      rootfs_path: `/mnt/cocalc/data/cache/images/${cacheKey}`,
      distro_family: "debian",
      package_manager: "apt-get",
      shell: "/bin/bash",
      glibc: true,
      sudo_present: true,
      ca_certificates_present: true,
    },
    null,
    2,
  )}\n`,
);
EOF

  docker_cli pull ubuntu:24.04 >/dev/null
  docker_cli create --name "$packer" -v "${volume}:/cache" ubuntu:24.04 sleep infinity >/dev/null
  docker_cli start "$packer" >/dev/null
  docker_cli export "$rootfs_container" | docker_cli exec -i "$packer" sh -c 'cat >/tmp/rootfs.tar'
  docker_cli cp "$inspect_path" "${packer}:/tmp/inspect.json"
  docker_cli cp "$metadata_path" "${packer}:/tmp/normalized.json"
  log "packing prebuilt RootFS cache artifact $output"
  docker_cli exec "$packer" bash -lc '
set -euo pipefail
cache_key="$1"
mkdir -p "/cache/images/${cache_key}"
tar --numeric-owner -C "/cache/images/${cache_key}" -xf /tmp/rootfs.tar
cp /tmp/inspect.json "/cache/images/.${cache_key}.json"
cp /tmp/normalized.json "/cache/images/.${cache_key}.normalized.json"
tar --numeric-owner -C /cache/images -czf /tmp/cocalc-star-rootfs-cache.tar.gz .
' _ "$cache_key"
  docker_cli cp "${packer}:/tmp/cocalc-star-rootfs-cache.tar.gz" "$output"
  cleanup_builder
  trap cleanup EXIT
}

if [[ -n "$ROOTFS_CACHE_ARTIFACT" ]]; then
  ROOTFS_CACHE_ARTIFACT="$(realpath "$ROOTFS_CACHE_ARTIFACT")"
  [ -f "$ROOTFS_CACHE_ARTIFACT" ] || die "RootFS cache artifact does not exist: $ROOTFS_CACHE_ARTIFACT"
elif [[ "$BUILD_ROOTFS_CACHE" == "1" ]]; then
  rootfs_cache_dir="${REPO_ROOT}/dist/star/docker-preview"
  mkdir -p "$rootfs_cache_dir"
  ROOTFS_CACHE_ARTIFACT="${rootfs_cache_dir}/cocalc-star-rootfs-cache-$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf nogit).tar.gz"
  build_rootfs_cache_artifact "$ROOTFS_CACHE_ARTIFACT"
fi

build_image "$TAG" "$ROOTFS_CACHE_ARTIFACT"

cat <<EOF
Built ${TAG}

RootFS cache: ${ROOTFS_CACHE_ARTIFACT:-not embedded}

Run locally with:
  ${DOCKER_DISPLAY} run --privileged --cgroupns=host \\
    --security-opt seccomp=unconfined \\
    --tmpfs /run --tmpfs /run/lock \\
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \\
    -v cocalc-star-data:/var/lib/cocalc \\
    -p 8170:80 ${TAG}
EOF
