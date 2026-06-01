#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-}"
ZONE="${ZONE:-}"
INSTANCE="${INSTANCE:-}"
RELEASE_A="${RELEASE_A:-}"
RELEASE_B="${RELEASE_B:-}"
REMOTE_DIR="${REMOTE_DIR:-/tmp/cocalc-star-release-validation}"
RESTORE_B="${RESTORE_B:-1}"
HARD_RESET="${HARD_RESET:-1}"
SSH_USER="${SSH_USER:-root}"

log() {
  printf '[star-validate-gce] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  validate-gce-release-upgrade.sh \
    --project PROJECT \
    --zone ZONE \
    --instance INSTANCE \
    --release-a /path/to/cocalc-star-A.tar.gz \
    --release-b /path/to/cocalc-star-B.tar.gz

Validates the full CoCalc Star two-release path on a GCE VM:

  1. copy release A and release B to the VM,
  2. install release A,
  3. run doctor and smoke,
  4. install release B,
  5. run doctor and smoke,
  6. rollback to release A,
  7. run doctor and smoke,
  8. hard-reset the VM,
  9. verify release A still boots and doctor passes,
  10. restore release B by default and verify doctor.

Environment/flags:
  PROJECT, --project       GCP project id. Defaults to current gcloud project.
  ZONE, --zone             GCE zone.
  INSTANCE, --instance     GCE instance name.
  RELEASE_A, --release-a   First Star release artifact.
  RELEASE_B, --release-b   Second Star release artifact.
  REMOTE_DIR               Remote staging directory.
  SSH_USER                 SSH user; default root.
  RESTORE_B=0              Leave the VM on release A after validation.
  HARD_RESET=0             Skip the GCE hard reset step.

This script mutates the target VM and starts/stops Star services. Run it only
against a dedicated test Star VM.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --zone)
      ZONE="${2:-}"
      shift 2
      ;;
    --instance)
      INSTANCE="${2:-}"
      shift 2
      ;;
    --release-a)
      RELEASE_A="${2:-}"
      shift 2
      ;;
    --release-b)
      RELEASE_B="${2:-}"
      shift 2
      ;;
    --leave-rollback)
      RESTORE_B=0
      shift
      ;;
    --skip-hard-reset)
      HARD_RESET=0
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

command -v gcloud >/dev/null 2>&1 || die "gcloud is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

if [ -z "$PROJECT" ]; then
  PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
fi

[ -n "$PROJECT" ] || die "missing --project"
[ -n "$ZONE" ] || die "missing --zone"
[ -n "$INSTANCE" ] || die "missing --instance"
[ -f "$RELEASE_A" ] || die "missing --release-a artifact: $RELEASE_A"
[ -f "$RELEASE_B" ] || die "missing --release-b artifact: $RELEASE_B"

release_id() {
  local artifact="$1"
  local listing top
  listing="$(tar -tzf "$artifact")"
  top="$(printf '%s\n' "$listing" | awk 'NR == 1 { split($0, parts, "/"); print parts[1] }')"
  [ -n "$top" ] || die "could not find top-level release directory in $artifact"
  tar -xOzf "$artifact" "${top}/release.json" | jq -r '.release_id'
}

RELEASE_A_ID="$(release_id "$RELEASE_A")"
RELEASE_B_ID="$(release_id "$RELEASE_B")"
[ -n "$RELEASE_A_ID" ] && [ "$RELEASE_A_ID" != "null" ] || die "release A has no release_id"
[ -n "$RELEASE_B_ID" ] && [ "$RELEASE_B_ID" != "null" ] || die "release B has no release_id"
[ "$RELEASE_A_ID" != "$RELEASE_B_ID" ] || die "release ids must differ"

GCLOUD_BASE=(gcloud --project="$PROJECT" compute)
SSH_BASE=("${GCLOUD_BASE[@]}" ssh "${SSH_USER}@${INSTANCE}" --zone="$ZONE")
SCP_BASE=("${GCLOUD_BASE[@]}" scp --zone="$ZONE")

remote_artifact_path() {
  local release_id="$1"
  printf '%s/%s.tar.gz' "$REMOTE_DIR" "$release_id"
}

ssh_run() {
  "${SSH_BASE[@]}" --command="$1"
}

run_star() {
  ssh_run "set -euo pipefail; /opt/cocalc-star/source/src/scripts/star/star.sh $*"
}

install_remote_release() {
  local release_id="$1"
  local remote_artifact
  remote_artifact="$(remote_artifact_path "$release_id")"
  ssh_run "set -euo pipefail
    rm -rf '${REMOTE_DIR}/extract-${release_id}'
    mkdir -p '${REMOTE_DIR}/extract-${release_id}'
    tar -xzf '$remote_artifact' -C '${REMOTE_DIR}/extract-${release_id}'
    cd '${REMOTE_DIR}/extract-${release_id}/cocalc-star-${release_id}'
    STAR_ASSUME_YES=1 ./install.sh"
}

doctor_smoke() {
  local label="$1"
  log "$label: current release"
  run_star current-release
  log "$label: doctor"
  run_star doctor
  log "$label: smoke"
  run_star smoke
}

wait_for_ssh() {
  local i
  for i in $(seq 1 120); do
    if ssh_run 'true' >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  die "timed out waiting for SSH after reset"
}

copy_artifact() {
  local artifact="$1"
  local release_id="$2"
  local remote_artifact
  remote_artifact="$(remote_artifact_path "$release_id")"
  log "copying $release_id to $remote_artifact"
  "${SCP_BASE[@]}" "$artifact" "${SSH_USER}@${INSTANCE}:${remote_artifact}"
}

log "target: project=$PROJECT zone=$ZONE instance=$INSTANCE"
log "release A: $RELEASE_A_ID"
log "release B: $RELEASE_B_ID"

ssh_run "set -euo pipefail; mkdir -p '$REMOTE_DIR'"
copy_artifact "$RELEASE_A" "$RELEASE_A_ID"
copy_artifact "$RELEASE_B" "$RELEASE_B_ID"

log "installing release A"
install_remote_release "$RELEASE_A_ID"
doctor_smoke "release A"

log "installing release B"
install_remote_release "$RELEASE_B_ID"
doctor_smoke "release B"

log "rolling back to release A"
run_star "rollback '$RELEASE_A_ID'"
doctor_smoke "rollback to release A"

if [ "$HARD_RESET" = "1" ]; then
  log "hard-resetting VM"
  "${GCLOUD_BASE[@]}" instances reset "$INSTANCE" --zone="$ZONE" --quiet
  wait_for_ssh
  log "post-reset current release"
  current="$(ssh_run '/opt/cocalc-star/source/src/scripts/star/star.sh current-release' | tr -d '\r')"
  if [ "$current" != "$RELEASE_A_ID" ]; then
    die "expected release $RELEASE_A_ID after reset, got $current"
  fi
  log "post-reset doctor"
  run_star doctor
fi

if [ "$RESTORE_B" = "1" ]; then
  log "restoring release B"
  run_star "rollback '$RELEASE_B_ID'"
  run_star current-release
  run_star doctor
fi

log "validation complete"
