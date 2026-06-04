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
GENERATE_KEY="${GENERATE_KEY:-1}"
INCLUDE_FIREWALL_ADMIN="${INCLUDE_FIREWALL_ADMIN:-1}"
FIREWALL_ROLE_ID="${FIREWALL_ROLE_ID:-cocalcRocketFirewallAdmin}"
FIREWALL_ROLE_TITLE="${FIREWALL_ROLE_TITLE:-CoCalc Rocket Firewall Admin}"

START_MARKER="=== COCALC ROCKET GCP BOOTSTRAP KEY START ==="
END_MARKER="=== COCALC ROCKET GCP BOOTSTRAP KEY END ==="

ROLES=(
  roles/compute.instanceAdmin.v1
  roles/compute.networkUser
  roles/iam.serviceAccountUser
)

FIREWALL_PERMISSIONS=(
  compute.firewalls.create
  compute.firewalls.delete
  compute.firewalls.get
  compute.firewalls.list
  compute.firewalls.update
  compute.networks.updatePolicy
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
  PROJECT_ID                 required unless entered interactively
  SA_NAME                    default: cocalc-rocket-bootstrap
  DISPLAY_NAME               default: CoCalc Rocket Bootstrap
  ENABLE_SERVICES            default: 1; set 0 to skip gcloud services enable
  GENERATE_KEY               default: 1; set 0 to update IAM only
  INCLUDE_FIREWALL_ADMIN     default: 1; create/grant a custom firewall role
  FIREWALL_ROLE_ID           default: cocalcRocketFirewallAdmin

Firewall role:
  When INCLUDE_FIREWALL_ADMIN=1, this creates/reuses a project custom role with:
  - compute.firewalls.create
  - compute.firewalls.delete
  - compute.firewalls.get
  - compute.firewalls.list
  - compute.firewalls.update
  - compute.networks.updatePolicy

  This is narrower than roles/compute.securityAdmin and is enough for scripts
  that idempotently create, inspect, update, or remove VPC firewall rules.
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

custom_role_name() {
  printf 'projects/%s/roles/%s' "$PROJECT_ID" "$FIREWALL_ROLE_ID"
}

ensure_firewall_custom_role() {
  local role_name permissions
  role_name="$(custom_role_name)"
  permissions="$(IFS=,; printf '%s' "${FIREWALL_PERMISSIONS[*]}")"

  if gcloud iam roles describe "$FIREWALL_ROLE_ID" --project "$PROJECT_ID" >/dev/null 2>&1; then
    log "Updating custom firewall role ${role_name}"
    gcloud iam roles update "$FIREWALL_ROLE_ID" \
      --project "$PROJECT_ID" \
      --title="$FIREWALL_ROLE_TITLE" \
      --permissions="$permissions" \
      --stage=GA \
      >/dev/null
    return 0
  fi

  log "Creating custom firewall role ${role_name}"
  gcloud iam roles create "$FIREWALL_ROLE_ID" \
    --project "$PROJECT_ID" \
    --title="$FIREWALL_ROLE_TITLE" \
    --description="Least-privilege firewall rule management for CoCalc Rocket bay operations." \
    --permissions="$permissions" \
    --stage=GA \
    >/dev/null
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

if [[ "$INCLUDE_FIREWALL_ADMIN" != "0" ]]; then
  ensure_firewall_custom_role
  role="$(custom_role_name)"
  log "Granting ${role}"
  if ! add_project_binding "$role"; then
    warn "Failed to grant ${role}."
    warn "This requires permission to create/update custom roles and bind IAM."
    warn "Fallback: grant roles/compute.securityAdmin to ${SA_EMAIL} manually."
    exit 1
  fi
fi

if [[ "$GENERATE_KEY" != "0" ]]; then
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
fi

cat >&2 <<EOF

Updated service account:
  project: ${PROJECT_ID}
  service_account: ${SA_EMAIL}
  firewall_role: $(if [[ "$INCLUDE_FIREWALL_ADMIN" != "0" ]]; then custom_role_name; else printf 'disabled'; fi)
  generated_key: ${GENERATE_KEY}

$(if [[ "$GENERATE_KEY" != "0" ]]; then cat <<'KEY_NOTE'
Paste only the JSON between the markers into a CoCalc project secret.
Then run the bay bootstrap helper with:
  --key-file /path/to/mounted/project/secret.json

Treat this JSON as a password. Delete old keys from IAM when they are no
longer needed.
KEY_NOTE
else cat <<'NO_KEY_NOTE'
No key was generated. Existing service account keys continue to work after IAM
propagates.
NO_KEY_NOTE
fi)
EOF
