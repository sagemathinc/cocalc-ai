#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID=""
PROJECT=""
ZONE=""
REGISTRY=""
TAG=""
ZONE_AMD64=""
ZONE_ARM64=""
PASSTHRU=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE_ID="$2"; shift 2;;
    --project) PROJECT="$2"; shift 2;;
    --zone) ZONE="$2"; shift 2;;
    --registry) REGISTRY="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --zone-amd64) ZONE_AMD64="$2"; shift 2;;
    --zone-arm64) ZONE_ARM64="$2"; shift 2;;
    --arch) echo "error: --arch is managed by gcp-build-multi.sh"; exit 1;;
    *) PASSTHRU+=("$1"); shift;;
  esac
done

if [[ -z "$IMAGE_ID" || -z "$PROJECT" || -z "$ZONE" || -z "$REGISTRY" ]]; then
  echo "usage: gcp-build-multi.sh --image <id> --project <gcp-project> --zone <zone> --registry <artifact-registry> [--tag <tag>] [--zone-amd64 <zone>] [--zone-arm64 <zone>] [-- ... passthru args to gcp-builder.sh]" >&2
  exit 1
fi

if [[ -z "$ZONE_AMD64" ]]; then
  ZONE_AMD64="$ZONE"
fi
if [[ -z "$ZONE_ARM64" ]]; then
  ZONE_ARM64="$ZONE"
fi

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOTFS_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

eval "$(python3 - <<PY
import shlex
from datetime import datetime
from pathlib import Path
import yaml

root = Path("$ROOTFS_DIR")
image_id = "$IMAGE_ID"
path = root / "images" / image_id / "image.yaml"
data = yaml.safe_load(path.read_text())
gpu = bool(data.get("gpu"))
arch = data.get("arch") or ["amd64"]
if isinstance(arch, str):
  arch = [arch]
component = data.get("component_version", "0")
tag = f"{component}-{datetime.utcnow().strftime('%Y.%m.%d')}"
print(f"GPU={'1' if gpu else '0'}")
print(f"ARCH_LIST={shlex.quote(','.join(arch))}")
print(f"DEFAULT_TAG={shlex.quote(tag)}")
PY
)"

if [[ -z "$TAG" ]]; then
  TAG="$DEFAULT_TAG"
fi

IFS=',' read -ra ARCHES <<< "$ARCH_LIST"
if [[ "$GPU" == "1" ]]; then
  ARCHES=("amd64")
fi

build_one() {
  local arch="$1"
  local zone="$2"
  "$SCRIPT_DIR/gcp-builder.sh" \
    --image "$IMAGE_ID" \
    --project "$PROJECT" \
    --zone "$zone" \
    --registry "$REGISTRY" \
    --arch "$arch" \
    --tag "$TAG" \
    --wait \
    "${PASSTHRU[@]}"
}

if [[ "${#ARCHES[@]}" -gt 1 ]]; then
  echo "Starting parallel builds for ${ARCHES[*]} with tag $TAG"
  build_one "amd64" "$ZONE_AMD64" &
  PID_AMD64=$!
  build_one "arm64" "$ZONE_ARM64" &
  PID_ARM64=$!
  set +e
  wait "$PID_AMD64"
  STATUS_AMD64=$?
  wait "$PID_ARM64"
  STATUS_ARM64=$?
  set -e
  if [[ "$STATUS_AMD64" -ne 0 || "$STATUS_ARM64" -ne 0 ]]; then
    echo "Build failed: amd64=$STATUS_AMD64 arm64=$STATUS_ARM64"
    exit 1
  fi
  python3 "$SCRIPT_DIR/manifest-merge.py" \
    --image "$IMAGE_ID" \
    --registry "$REGISTRY" \
    --project "$PROJECT" \
    --tag "$TAG"
else
  echo "Starting build for ${ARCHES[0]} with tag $TAG"
  build_one "${ARCHES[0]}" "$ZONE_AMD64"
fi
