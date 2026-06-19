#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"
BUILD_RELEASE="${SRC_ROOT}/scripts/star/build-star-release.sh"

TAG="${COCALC_STAR_DOCKER_TAG:-cocalc/star:preview}"
RELEASE_ARTIFACT="${COCALC_STAR_DOCKER_RELEASE_ARTIFACT:-}"
BUILD_RUNTIME="${COCALC_STAR_DOCKER_BUILD_RUNTIME:-1}"
DOCKER="${DOCKER:-docker}"
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
  --docker <path>          Docker-compatible CLI (default: docker)
  --keep-context           keep the temporary Docker build context
  -h, --help               show this help

Environment:
  COCALC_STAR_DOCKER_TAG
  COCALC_STAR_DOCKER_RELEASE_ARTIFACT
  COCALC_STAR_DOCKER_BUILD_RUNTIME=0

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

command -v "$DOCKER" >/dev/null 2>&1 || die "missing Docker CLI: $DOCKER"
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

context="$(mktemp -d)"
cleanup() {
  if [[ "$KEEP_CONTEXT" -eq 1 ]]; then
    log "kept Docker build context: $context"
  else
    rm -rf "$context"
  fi
}
trap cleanup EXIT

cp "$SCRIPT_DIR/Dockerfile" "$context/Dockerfile"
cp "$SCRIPT_DIR/cocalc-star-docker-preflight.sh" "$context/cocalc-star-docker-preflight.sh"
cp "$SCRIPT_DIR/cocalc-star-docker-init.sh" "$context/cocalc-star-docker-init.sh"
cp "$SCRIPT_DIR/cocalc-star-docker-init.service" "$context/cocalc-star-docker-init.service"
cp "$RELEASE_ARTIFACT" "$context/cocalc-star-release.tar.gz"

log "building Docker image $TAG"
"$DOCKER" build -t "$TAG" "$context"

cat <<EOF
Built ${TAG}

Run locally with:
  ${DOCKER} run --privileged --cgroupns=host \\
    --security-opt seccomp=unconfined \\
    --tmpfs /run --tmpfs /run/lock \\
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \\
    -v cocalc-star-data:/var/lib/cocalc \\
    -p 8170:80 ${TAG}
EOF
