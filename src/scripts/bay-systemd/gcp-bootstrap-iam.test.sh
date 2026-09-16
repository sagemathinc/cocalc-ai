#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT_SETUP="${SCRIPT_DIR}/gcp-rocket-bootstrap-service-account.sh"
BAY_BOOTSTRAP="${SCRIPT_DIR}/gcp-bootstrap-dogfood-bay.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

roles_block="$(sed -n '/^ROLES=(/,/^)/p' "$ACCOUNT_SETUP")"
if grep -q 'roles/iam.serviceAccountUser' <<<"$roles_block"; then
  echo "bootstrap identity must not receive project-wide Service Account User" >&2
  exit 1
fi

if ! grep -q 'Removing legacy project-wide.*LEGACY_PROJECT_ROLE' "$ACCOUNT_SETUP"; then
  echo "service-account setup does not remove the legacy critical role" >&2
  exit 1
fi

if ! grep -q 'args+=(--no-service-account)' "$BAY_BOOTSTRAP"; then
  echo "bay bootstrap does not disable the implicit default service account" >&2
  exit 1
fi

if ! grep -q 'args+=(--service-account.*SERVICE_ACCOUNT' "$BAY_BOOTSTRAP"; then
  echo "bay bootstrap no longer supports an explicit service account" >&2
  exit 1
fi

mkdir -p "${TMP_ROOT}/bin"
GCLOUD_LOG="${TMP_ROOT}/gcloud.log"
export GCLOUD_LOG
cat >"${TMP_ROOT}/bin/gcloud" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$GCLOUD_LOG"
if [[ "${1:-} ${2:-}" == "projects get-iam-policy" ]]; then
  printf '%s\n' roles/iam.serviceAccountUser
fi
EOF
chmod +x "${TMP_ROOT}/bin/gcloud"

PATH="${TMP_ROOT}/bin:${PATH}" \
  PROJECT_ID=test-project \
  SA_NAME=test-bootstrap \
  ENABLE_SERVICES=0 \
  GENERATE_KEY=0 \
  INCLUDE_FIREWALL_ADMIN=0 \
  "$ACCOUNT_SETUP" >/dev/null 2>"${TMP_ROOT}/setup.log"

for role in roles/compute.instanceAdmin.v1 roles/compute.networkUser; do
  if ! grep -q "projects add-iam-policy-binding test-project .*--role=${role}" "$GCLOUD_LOG"; then
    echo "service-account setup did not grant ${role}" >&2
    exit 1
  fi
done

if grep -q 'projects add-iam-policy-binding .*--role=roles/iam.serviceAccountUser' "$GCLOUD_LOG"; then
  echo "service-account setup granted the legacy critical role" >&2
  exit 1
fi

if ! grep -q 'projects remove-iam-policy-binding test-project .*--role=roles/iam.serviceAccountUser' "$GCLOUD_LOG"; then
  echo "service-account setup did not remove the legacy critical role" >&2
  exit 1
fi

echo "GCP bootstrap IAM checks passed"
