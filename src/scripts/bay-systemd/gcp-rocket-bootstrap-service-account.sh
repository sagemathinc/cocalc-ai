#!/usr/bin/env bash
set -euo pipefail

# Create or reuse a project-scoped GCP service account for bootstrapping a
# Rocket/systemd bay VM, then print a raw service account JSON key. Run this in
# a powerful trusted gcloud shell, paste the emitted JSON into a CoCalc project
# secret, and pass that secret file to gcp-bootstrap-dogfood-bay.sh --key-file.

PROJECT_ID="${PROJECT_ID:-}"
SA_NAME="${SA_NAME:-cocalc-rocket-bootstrap}"
DISPLAY_NAME="${DISPLAY_NAME:-CoCalc Rocket Bootstrap}"
ENABLE_SERVICES="${ENABLE_SERVICES:-1}"

START_MARKER="=== COCALC ROCKET GCP BOOTSTRAP KEY START ==="
END_MARKER="=== COCALC ROCKET GCP BOOTSTRAP KEY END ==="

ROLES=(
  roles/compute.instanceAdmin.v1
  roles/compute.networkUser
  roles/iam.serviceAccountUser
)

log() {
  echo ""
  echo "==> $*" >&2
}

warn() {
  echo "Warning: $*" >&2
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd not found. Install it first and authenticate with an admin account." >&2
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Usage:
  PROJECT_ID=<gcp-project> [SA_NAME=cocalc-rocket-bootstrap] \
    ./gcp-rocket-bootstrap-service-account.sh

Creates/reuses a GCP service account for bootstrapping Rocket/systemd bay VMs
and prints a raw service account JSON key between markers.

The generated service account is intended for:
  - gcp-bootstrap-dogfood-bay.sh --key-file <json-file>
  - creating/reusing bay VMs in one project
  - SSH/SCP bootstrap through gcloud compute ssh/scp

Default roles granted on the project:
  - roles/compute.instanceAdmin.v1
  - roles/compute.networkUser
  - roles/iam.serviceAccountUser

Environment:
  PROJECT_ID        required unless entered interactively
  SA_NAME           default: cocalc-rocket-bootstrap
  DISPLAY_NAME      default: CoCalc Rocket Bootstrap
  ENABLE_SERVICES   default: 1; set 0 to skip gcloud services enable
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd gcloud

if [[ -z "$PROJECT_ID" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Enter GCP Project ID: " PROJECT_ID
  elif [[ -r /dev/tty ]]; then
    read -r -p "Enter GCP Project ID: " PROJECT_ID < /dev/tty
  fi
fi

PROJECT_ID="${PROJECT_ID//[[:space:]]/}"
SA_NAME="${SA_NAME//[[:space:]]/}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: PROJECT_ID is required. Re-run with PROJECT_ID=your-project-id." >&2
  exit 1
fi
if [[ -z "$SA_NAME" ]]; then
  echo "Error: SA_NAME must not be empty." >&2
  exit 1
fi

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

wait_for_service_account() {
  local attempt=1
  local max_attempts=10
  while [[ "$attempt" -le "$max_attempts" ]]; do
    if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

add_project_binding() {
  local role="$1"
  local err
  err="$(mktemp)"
  if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --condition=None 2>"$err" >/dev/null; then
    rm -f "$err"
    return 0
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

cleanup() {
  if [[ -n "${KEY_PATH:-}" ]]; then
    rm -f "$KEY_PATH"
  fi
}
trap cleanup EXIT

log "Setting gcloud project to ${PROJECT_ID}"
gcloud config set project "$PROJECT_ID" >/dev/null

if [[ "$ENABLE_SERVICES" != "0" ]]; then
  log "Enabling required GCP services"
  gcloud services enable \
    compute.googleapis.com \
    iam.googleapis.com \
    --project "$PROJECT_ID"
fi

log "Ensuring service account ${SA_EMAIL} exists"
gcloud iam service-accounts create "$SA_NAME" \
  --project "$PROJECT_ID" \
  --display-name="$DISPLAY_NAME" \
  >/dev/null 2>&1 || true

if ! wait_for_service_account; then
  warn "Service account was not visible after waiting; role binding may fail."
fi

for role in "${ROLES[@]}"; do
  log "Granting ${role}"
  if ! add_project_binding "$role"; then
    warn "Failed to grant ${role}."
    warn "If the error mentions invalid conditions, inspect/fix conditional IAM bindings and retry."
    exit 1
  fi
done

KEY_PATH="$(mktemp)"
log "Generating raw service account key JSON"
gcloud iam service-accounts keys create "$KEY_PATH" \
  --project "$PROJECT_ID" \
  --iam-account="$SA_EMAIL" \
  >/dev/null

cat <<EOF
${START_MARKER}
$(cat "$KEY_PATH")
${END_MARKER}
EOF

cat >&2 <<EOF

Created key for:
  project: ${PROJECT_ID}
  service_account: ${SA_EMAIL}

Paste only the JSON between the markers into a CoCalc project secret.
Then run the bay bootstrap helper with:
  --key-file /path/to/mounted/project/secret.json

Treat this JSON as a password. Delete old keys from IAM when they are no
longer needed.
EOF
