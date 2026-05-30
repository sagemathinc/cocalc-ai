#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"

GCP_PROJECT="${GCP_PROJECT:-projecthosts}"
ZONE="${ZONE:-us-south1-a}"
VM_NAME="${VM_NAME:-cocalc-star-poc-1}"
MACHINE_TYPE="${MACHINE_TYPE:-t2d-standard-8}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-160GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
KEY_FILE="${KEY_FILE:-/run/secrets/cocalc/rocket-service-account.json}"
REMOTE_USER="${REMOTE_USER:-user}"
REUSE_EXISTING_VM="${REUSE_EXISTING_VM:-0}"
STAR_BUILD="${STAR_BUILD:-1}"

log() {
  printf '[gcp-star-poc] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

run() {
  log "+ $*"
  "$@"
}

usage() {
  cat <<'EOF'
Usage: gcp-create-star-poc.sh [env overrides]

Creates a fresh GCP VM, copies the current source tree, and runs the Star POC
bootstrap script. Defaults:

  GCP_PROJECT=projecthosts
  ZONE=us-south1-a
  VM_NAME=cocalc-star-poc-1
  MACHINE_TYPE=t2d-standard-8
  BOOT_DISK_SIZE=160GB
  KEY_FILE=/run/secrets/cocalc/rocket-service-account.json

Useful overrides:
  REUSE_EXISTING_VM=1      skip instance creation if it exists
  STAR_BUILD=0            skip pnpm build on the remote VM

After success, port-forward from your laptop or this machine with:
  gcloud compute ssh user@VM_NAME --project GCP_PROJECT --zone ZONE -- -L 7001:127.0.0.1:9100
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

GCLOUD_CONFIG="$(mktemp -d)"
ARCHIVE="$(mktemp -t cocalc-star-src.XXXXXX.tar.gz)"
cleanup() {
  rm -rf "$GCLOUD_CONFIG" "$ARCHIVE"
}
trap cleanup EXIT

export CLOUDSDK_CONFIG="$GCLOUD_CONFIG"
if [ -n "$KEY_FILE" ]; then
  [ -f "$KEY_FILE" ] || die "KEY_FILE does not exist: $KEY_FILE"
  run gcloud auth activate-service-account --key-file="$KEY_FILE" --quiet
fi
run gcloud config set project "$GCP_PROJECT" --quiet
run gcloud config set compute/zone "$ZONE" --quiet

if gcloud compute instances describe "$VM_NAME" --project "$GCP_PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  if [ "$REUSE_EXISTING_VM" != "1" ]; then
    die "VM already exists: $VM_NAME (set REUSE_EXISTING_VM=1 to reuse)"
  fi
  log "reusing existing VM $VM_NAME"
else
  run gcloud compute instances create "$VM_NAME" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --machine-type "$MACHINE_TYPE" \
    --boot-disk-size "$BOOT_DISK_SIZE" \
    --boot-disk-type pd-balanced \
    --image-family "$IMAGE_FAMILY" \
    --image-project "$IMAGE_PROJECT" \
    --tags cocalc-star-poc \
    --quiet
fi

log "waiting for SSH"
for _ in $(seq 1 60); do
  if gcloud compute ssh "${REMOTE_USER}@${VM_NAME}" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --command "true" \
    --quiet >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

log "creating source archive"
tar -C "$REPO_ROOT" \
  --exclude='.git' \
  --exclude='src/packages/node_modules' \
  --exclude='src/packages/*/node_modules' \
  --exclude='src/packages/*/dist' \
  --exclude='src/packages/*/build' \
  --exclude='src/data' \
  --exclude='src/.local' \
  --exclude='src/.next' \
  --exclude='src/log' \
  --exclude='src/logs' \
  --exclude='src/*.log' \
  --exclude='src/tmp' \
  --exclude='src/.turbo' \
  --exclude='src/.pnpm-store' \
  -czf "$ARCHIVE" src

run gcloud compute ssh "${REMOTE_USER}@${VM_NAME}" \
  --project "$GCP_PROJECT" \
  --zone "$ZONE" \
  --command "rm -rf /home/${REMOTE_USER}/cocalc-ai && mkdir -p /home/${REMOTE_USER}/cocalc-ai" \
  --quiet

run gcloud compute scp "$ARCHIVE" "${REMOTE_USER}@${VM_NAME}:/tmp/cocalc-star-src.tar.gz" \
  --project "$GCP_PROJECT" \
  --zone "$ZONE" \
  --quiet

run gcloud compute ssh "${REMOTE_USER}@${VM_NAME}" \
  --project "$GCP_PROJECT" \
  --zone "$ZONE" \
  --command "tar -xzf /tmp/cocalc-star-src.tar.gz -C /home/${REMOTE_USER}/cocalc-ai && sudo STAR_BUILD='${STAR_BUILD}' SRC_ROOT=/home/${REMOTE_USER}/cocalc-ai/src bash /home/${REMOTE_USER}/cocalc-ai/src/scripts/star-poc/bootstrap-star-poc.sh" \
  --quiet

log "VM ready: $VM_NAME"
log "Port-forward: gcloud compute ssh ${REMOTE_USER}@${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} -- -L 7001:127.0.0.1:9100"
log "Bootstrap result: cat /var/lib/cocalc/star/bootstrap-result.json"
