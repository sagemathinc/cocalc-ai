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
      docker_cli exec "$container" journalctl -u cocalc-star-docker-init.service -n 240 --no-pager || true
      die "RootFS cache builder failed: systemd result=$result"
    fi
    if ((SECONDS - last_log >= 30)); then
      log "waiting for RootFS cache builder: active=${active:-unknown} result=${result:-unknown}"
      last_log="$SECONDS"
    fi
    sleep 5
  done
  docker_cli exec "$container" journalctl -u cocalc-star-docker-init.service -n 240 --no-pager || true
  die "RootFS cache builder timed out"
}

build_rootfs_cache_artifact() {
  local output="$1"
  local suffix container volume temp_tag
  suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  container="cocalc-star-rootfs-cache-${suffix}"
  volume="cocalc-star-rootfs-cache-${suffix}"
  temp_tag="cocalc-star-rootfs-cache-builder:${suffix}"

  build_image "$temp_tag" ""
  log "running RootFS cache builder container $container"
  docker_cli run -d \
    --name "$container" \
    --privileged \
    --cgroupns=host \
    --security-opt seccomp=unconfined \
    --tmpfs /run \
    --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    -v "${volume}:/var/lib/cocalc" \
    -e COCALC_STAR_BTRFS_SIZE="$CACHE_BTRFS_SIZE" \
    -e COCALC_STAR_DOCKER_ALLOW_DEGRADED="$BUILD_ROOTFS_CACHE_ALLOW_DEGRADED" \
    "$temp_tag" >/dev/null

  cleanup_builder() {
    docker_cli rm -f "$container" >/dev/null 2>&1 || true
    docker_cli volume rm "$volume" >/dev/null 2>&1 || true
    docker_cli image rm "$temp_tag" >/dev/null 2>&1 || true
  }
  trap 'cleanup_builder; cleanup' EXIT

  wait_for_builder_container "$container"
  log "exporting prebuilt RootFS cache to $output"
  docker_cli exec "$container" tar --numeric-owner -C /mnt/cocalc/data/cache/images -czf /tmp/cocalc-star-rootfs-cache.tar.gz .
  docker_cli cp "${container}:/tmp/cocalc-star-rootfs-cache.tar.gz" "$output"
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
