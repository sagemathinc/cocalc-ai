#!/usr/bin/env bash
set -euo pipefail

# This script uses gcloud to create or reuse a service account and output a
# service account JSON key in a format the CoCalc wizard can parse.

PROJECT_ID="${PROJECT_ID:-}"
SA_NAME="${SA_NAME:-cocalc-host}"

START_MARKER="=== COCALC GCP CONFIG START ==="
END_MARKER="=== COCALC GCP CONFIG END ==="

log() {
  echo ""
  echo "==> $*"
}

warn() {
  echo "Warning: $*" >&2
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd not found. Install it first and run 'gcloud auth login'." >&2
    exit 1
  fi
}

require_cmd gcloud
require_cmd python3

if [ -z "$PROJECT_ID" ]; then
  if [ -t 0 ]; then
    read -r -p "Enter GCP Project ID: " PROJECT_ID
  elif [ -r /dev/tty ]; then
    read -r -p "Enter GCP Project ID: " PROJECT_ID < /dev/tty
  fi
fi

PROJECT_ID="${PROJECT_ID//[[:space:]]/}"
if [ -z "$PROJECT_ID" ]; then
  echo "Error: PROJECT_ID is required. Re-run with PROJECT_ID=your-project-id." >&2
  exit 1
fi

SA_NAME="${SA_NAME//[[:space:]]/}"
if [ -z "$SA_NAME" ]; then
  SA_NAME="cocalc-host"
fi

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

wait_for_service_account() {
  local attempt=1
  local max_attempts=10
  while [ "$attempt" -le "$max_attempts" ]; do
    if gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  return 1
}

add_project_binding() {
  local err
  err=$(mktemp)
  if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/editor" \
    --condition=None 2>"$err"; then
    rm -f "$err"
    return 0
  fi
  cat "$err" >&2
  rm -f "$err"
  return 1
}

# 1) Set the active project and ensure Compute Engine API is enabled.
log "Setting gcloud project to $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

log "Enabling Compute Engine API"
gcloud services enable compute.googleapis.com

# 2) Create or reuse the service account and grant editor role.
log "Ensuring service account $SA_EMAIL exists"
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="CoCalc Project Hosts" || true

if ! wait_for_service_account; then
  warn "Service account not visible yet; continuing to retry role binding."
fi

if ! add_project_binding; then
  warn "Failed to grant roles/editor on project."
  warn "If the error mentions invalid conditions, run:"
  warn "  gcloud alpha iam policies lint-condition --policy-file <your-policy.json>"
  warn "Then fix or remove the invalid conditional binding and retry."
  exit 1
fi

# 3) Generate a new service account key JSON and output it.
KEY_PATH=$(mktemp)
log "Generating service account key JSON"
gcloud iam service-accounts keys create "$KEY_PATH" --iam-account="$SA_EMAIL"

export KEY_PATH START_MARKER END_MARKER
python3 - <<'PY'
import json, os
path = os.environ["KEY_PATH"]
with open(path, "r", encoding="utf-8") as f:
  key = json.load(f)
out = {"google_cloud_service_account_json": key}
print(os.environ.get("START_MARKER"))
print(json.dumps(out, indent=2))
print(os.environ.get("END_MARKER"))
PY

rm -f "$KEY_PATH"
