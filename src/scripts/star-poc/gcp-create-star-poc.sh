#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"

GCP_PROJECT="${GCP_PROJECT:-projecthosts}"
ZONE="${ZONE:-us-south1-a}"
VM_NAME="${VM_NAME:-cocalc-star-poc-$(date -u +%Y%m%d-%H%M%S)}"
MACHINE_TYPE="${MACHINE_TYPE:-t2d-standard-8}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-300GB}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
KEY_FILE="${KEY_FILE:-/run/secrets/cocalc/rocket-service-account.json}"
REMOTE_USER="${REMOTE_USER:-user}"
VALIDATION_USER="${VALIDATION_USER:-root}"
STAR_INSTALL_ROOT="${STAR_INSTALL_ROOT:-/opt/cocalc-star}"
REUSE_EXISTING_VM="${REUSE_EXISTING_VM:-0}"
DELETE_EXISTING_VM="${DELETE_EXISTING_VM:-0}"
STAR_BUILD="${STAR_BUILD:-1}"
STAR_BUILD_DEFAULT_ROOTFS="${STAR_BUILD_DEFAULT_ROOTFS:-1}"
STAR_DEFAULT_ROOTFS_IMAGE="${STAR_DEFAULT_ROOTFS_IMAGE:-containers-storage:localhost/cocalc-star-rootfs:latest}"
STAR_DEFAULT_ROOTFS_BASE_IMAGE="${STAR_DEFAULT_ROOTFS_BASE_IMAGE:-ubuntu:24.04}"
STAR_REMOVE_GCP_SUDOERS="${STAR_REMOVE_GCP_SUDOERS:-1}"
RUN_DOCTOR="${RUN_DOCTOR:-1}"
RUN_SMOKE="${RUN_SMOKE:-1}"
RUN_UPGRADE_ROLLBACK_TEST="${RUN_UPGRADE_ROLLBACK_TEST:-0}"
RUN_RESET_TEST="${RUN_RESET_TEST:-1}"
RESET_WAIT_SECONDS="${RESET_WAIT_SECONDS:-45}"
DOCTOR_RETRIES="${DOCTOR_RETRIES:-30}"
DOCTOR_RETRY_SECONDS="${DOCTOR_RETRY_SECONDS:-10}"

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

Creates a fresh GCP VM, uploads a CoCalc Star release artifact, runs the Star
installer, and validates the install with doctor/smoke/reset checks. Defaults:

  GCP_PROJECT=projecthosts
  ZONE=us-south1-a
  VM_NAME=cocalc-star-poc-YYYYMMDD-HHMMSS
  MACHINE_TYPE=t2d-standard-8
  BOOT_DISK_SIZE=300GB
  KEY_FILE=/run/secrets/cocalc/rocket-service-account.json
  VALIDATION_USER=root
  STAR_INSTALL_ROOT=/opt/cocalc-star

Useful overrides:
  REUSE_EXISTING_VM=1            skip instance creation if it exists
  DELETE_EXISTING_VM=1           delete VM_NAME before creating it
  STAR_BUILD=0                  skip pnpm build on the remote VM
  STAR_BUILD_DEFAULT_ROOTFS=0   skip building the local Jupyter/LaTeX rootfs
  STAR_DEFAULT_ROOTFS_IMAGE=... local rootfs image tag to seed as default
  STAR_DEFAULT_ROOTFS_BASE_IMAGE=ubuntu:24.04
  STAR_REMOVE_GCP_SUDOERS=0     keep the GCP sudo group after install
  VALIDATION_USER=user          validate through the VM user instead of root
                                requires STAR_REMOVE_GCP_SUDOERS=0
  RUN_DOCTOR=0                  skip star-poc doctor validation
  RUN_SMOKE=0                   skip star-poc smoke validation
  RUN_UPGRADE_ROLLBACK_TEST=1   install a second release, verify existing
                                smoke project, roll back, and verify again
  RUN_RESET_TEST=0              skip hard-reset durability validation
  RESET_WAIT_SECONDS=45         seconds to wait after reset before validation
  DOCTOR_RETRIES=30             doctor attempts while services are booting
  DOCTOR_RETRY_SECONDS=10       seconds between doctor attempts

After success, port-forward from your laptop or this machine with:
  gcloud compute ssh user@VM_NAME --project GCP_PROJECT --zone ZONE -- -L 7001:127.0.0.1:9100
EOF
}

validation_ssh() {
  gcloud compute ssh "${VALIDATION_USER}@${VM_NAME}" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --command "$1" \
    --quiet
}

wait_for_doctor() {
  local label="$1"
  local attempt

  for attempt in $(seq 1 "$DOCTOR_RETRIES"); do
    log "running doctor (${label}, attempt ${attempt}/${DOCTOR_RETRIES})"
    if validation_ssh "$remote_star doctor"; then
      return
    fi
    sleep "$DOCTOR_RETRY_SECONDS"
  done

  die "doctor did not pass for ${label}"
}

build_release_artifact() {
  local output="$1"
  run "${SRC_ROOT}/scripts/star/build-star-release.sh" "$output"
}

upload_release_artifact() {
  local local_archive="$1"
  local remote_archive="$2"
  run gcloud compute scp "$local_archive" "${REMOTE_USER}@${VM_NAME}:${remote_archive}" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --quiet
}

install_remote_release() {
  local remote_archive="$1"
  local remote_extract_dir="$2"
  local install_command
  install_command="rm -rf ${remote_extract_dir} && mkdir -p ${remote_extract_dir} && tar -xzf ${remote_archive} -C ${remote_extract_dir} --strip-components=1 && STAR_ASSUME_YES=1 STAR_USER=${REMOTE_USER} STAR_INSTALL_ROOT=${STAR_INSTALL_ROOT} STAR_BUILD=${STAR_BUILD} STAR_BUILD_DEFAULT_ROOTFS=${STAR_BUILD_DEFAULT_ROOTFS} STAR_DEFAULT_ROOTFS_IMAGE=${STAR_DEFAULT_ROOTFS_IMAGE} STAR_DEFAULT_ROOTFS_BASE_IMAGE=${STAR_DEFAULT_ROOTFS_BASE_IMAGE} STAR_REMOVE_GCP_SUDOERS=${STAR_REMOVE_GCP_SUDOERS} bash ${remote_extract_dir}/install.sh"
  if [ "$VALIDATION_USER" != "root" ]; then
    install_command="sudo bash -lc '${install_command}'"
  else
    install_command="bash -lc '${install_command}'"
  fi
  run gcloud compute ssh "${VALIDATION_USER}@${VM_NAME}" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --command "$install_command" \
    --quiet
}

run_smoke() {
  local label="$1"
  local reuse_project="${2:-0}"
  log "running smoke (${label}, reuse_project=${reuse_project})"
  run validation_ssh "STAR_SMOKE_REUSE_PROJECT=${reuse_project} ${remote_star} smoke"
}

run_upgrade_rollback_test() {
  local before_release after_release rollback_release upgrade_archive
  before_release="$(validation_ssh "$remote_star current-release" | tr -d '\r\n')"
  [ -n "$before_release" ] || die "could not determine release before upgrade"
  log "upgrade test starting from release ${before_release}"

  upgrade_archive="$(mktemp -t cocalc-star-upgrade-release.XXXXXX.tar.gz)"
  build_release_artifact "$upgrade_archive"
  upload_release_artifact "$upgrade_archive" "/tmp/cocalc-star-release-upgrade.tar.gz"
  rm -f "$upgrade_archive"

  install_remote_release "/tmp/cocalc-star-release-upgrade.tar.gz" "/tmp/cocalc-star-release-upgrade"
  if [ "$RUN_DOCTOR" = "1" ]; then
    wait_for_doctor "post-upgrade"
  fi
  after_release="$(validation_ssh "$remote_star current-release" | tr -d '\r\n')"
  [ -n "$after_release" ] || die "could not determine release after upgrade"
  [ "$after_release" != "$before_release" ] || die "upgrade did not change release id (${after_release})"
  log "upgrade test installed release ${after_release}"
  run_smoke "post-upgrade existing-project" 1

  run validation_ssh "${remote_star} rollback ${before_release}"
  if [ "$RUN_DOCTOR" = "1" ]; then
    wait_for_doctor "post-rollback"
  fi
  rollback_release="$(validation_ssh "$remote_star current-release" | tr -d '\r\n')"
  [ "$rollback_release" = "$before_release" ] || die "rollback active release was ${rollback_release}, expected ${before_release}"
  run_smoke "post-rollback existing-project" 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || die "gcloud is required"
command -v git >/dev/null 2>&1 || die "git is required"

GCLOUD_CONFIG="$(mktemp -d)"
ARCHIVE="$(mktemp -t cocalc-star-release.XXXXXX.tar.gz)"
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
  if [ "$DELETE_EXISTING_VM" = "1" ]; then
    run gcloud compute instances delete "$VM_NAME" \
      --project "$GCP_PROJECT" \
      --zone "$ZONE" \
      --quiet
  elif [ "$REUSE_EXISTING_VM" != "1" ]; then
    die "VM already exists: $VM_NAME (set REUSE_EXISTING_VM=1 to reuse or DELETE_EXISTING_VM=1 to recreate)"
  fi
fi

if gcloud compute instances describe "$VM_NAME" --project "$GCP_PROJECT" --zone "$ZONE" >/dev/null 2>&1; then
  if [ "$REUSE_EXISTING_VM" != "1" ]; then
    die "VM still exists after delete attempt: $VM_NAME"
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

if ! gcloud compute ssh "${REMOTE_USER}@${VM_NAME}" \
  --project "$GCP_PROJECT" \
  --zone "$ZONE" \
  --command "true" \
  --quiet >/dev/null 2>&1; then
  die "SSH did not become ready for ${REMOTE_USER}@${VM_NAME}"
fi

log "creating Star release artifact"
build_release_artifact "$ARCHIVE"
upload_release_artifact "$ARCHIVE" "/tmp/cocalc-star-release.tar.gz"
install_remote_release "/tmp/cocalc-star-release.tar.gz" "/tmp/cocalc-star-release"

remote_star="${STAR_INSTALL_ROOT}/source/src/scripts/star/star.sh"

if [ "$RUN_DOCTOR" = "1" ]; then
  wait_for_doctor "post-bootstrap"
fi

if [ "$RUN_SMOKE" = "1" ]; then
  run_smoke "post-bootstrap" 0
fi

if [ "$RUN_UPGRADE_ROLLBACK_TEST" = "1" ]; then
  [ "$RUN_SMOKE" = "1" ] || die "RUN_UPGRADE_ROLLBACK_TEST=1 requires RUN_SMOKE=1"
  run_upgrade_rollback_test
fi

if [ "$RUN_RESET_TEST" = "1" ]; then
  log "syncing VM disks before hard-reset durability validation"
  run validation_ssh "sync"
  log "hard-resetting VM for durability validation"
  run gcloud compute instances reset "$VM_NAME" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --quiet
  sleep "$RESET_WAIT_SECONDS"
  if [ "$RUN_DOCTOR" = "1" ]; then
    wait_for_doctor "post-reset"
  fi
  if [ "$RUN_SMOKE" = "1" ]; then
    run_smoke "post-reset" 1
  fi
fi

log "VM ready: $VM_NAME"
log "Port-forward: gcloud compute ssh ${REMOTE_USER}@${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} -- -L 7001:127.0.0.1:9100"
log "Status: gcloud compute ssh ${REMOTE_USER}@${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command '${remote_star} status'"
log "Doctor: gcloud compute ssh ${VALIDATION_USER}@${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command '${remote_star} doctor'"
log "Smoke test: gcloud compute ssh ${VALIDATION_USER}@${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command '${remote_star} smoke'"
log "Bootstrap result: cat /var/lib/cocalc/star/bootstrap-result.json"
