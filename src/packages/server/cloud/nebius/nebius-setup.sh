#!/usr/bin/env bash
set -euo pipefail

# This script auto-configures Nebius credentials for CoCalc by selecting one
# project per region, creating/reusing a service account, generating a key,
# and picking a subnet; it then prints a JSON block the wizard can parse.
#
# You can review/inspect this file before running it; it does not modify
# anything outside of the selected Nebius tenant/projects.

# Service account name and resource prefix used by CoCalc.
NEBIUS_SA_NAME="${NEBIUS_SA_NAME:-cocalc-launchpad}"
NEBIUS_PREFIX="${NEBIUS_PREFIX:-cocalc-host}"
# Default regions we support right now (one project per region).
REGIONS=("eu-north1" "eu-west1" "me-west1" "us-central1")

START_MARKER="=== COCALC NEBIUS CONFIG START ==="
END_MARKER="=== COCALC NEBIUS CONFIG END ==="

log() {
  echo ""
  echo "==> $*"
}

warn() {
  echo "Warning: $*" >&2
}

pick_id() {
  # Parse a Nebius list JSON payload and let the user choose a single ID.
  local label="$1"
  local json="$2"
  local tmp
  tmp=$(mktemp)
  printf "%s" "$json" > "$tmp"
  local list
  list=$(python3 - "$label" "$tmp" <<'PY'
import json, sys
label = sys.argv[1]
path = sys.argv[2]
data = json.load(open(path))
items = []
def visit(obj):
  if isinstance(obj, dict):
    meta = obj.get("metadata")
    if isinstance(meta, dict):
      mid = meta.get("id")
      name = meta.get("name") or ""
      if mid:
        items.append((mid, name))
    for v in obj.values():
      visit(v)
  elif isinstance(obj, list):
    for v in obj:
      visit(v)
visit(data)
seen = set()
for mid, name in items:
  if mid in seen:
    continue
  seen.add(mid)
  print(f"{mid}\t{name}")
PY
  )
  rm -f "$tmp"
  if [ -z "$list" ]; then
    echo "No $label found. Please create one in the Nebius console." >&2
    exit 1
  fi
  local count
  count=$(echo "$list" | grep -c . || true)
  if [ "$count" -eq 1 ]; then
    echo "$list" | cut -f1
    return
  fi
  echo "Select $label:" >&2
  nl -w2 -s") " <(echo "$list" | sed $'s/\t/  /') >&2
  read -r -p "Enter number: " idx
  echo "$list" | sed -n "${idx}p" | cut -f1
}

find_sa_id() {
  # Look up a service account by name in the project and return its ID.
  local parent="$1"
  local sa_id
  sa_id=$(nebius iam service-account get-by-name \
    --parent-id "$parent" \
    --name "$NEBIUS_SA_NAME" \
    --format jsonpath='{.metadata.id}' 2>/dev/null || true)
  if [ -n "$sa_id" ]; then
    echo "$sa_id"
    return
  fi
  local sa_list
  sa_list=$(nebius iam service-account list \
    --parent-id "$parent" \
    --page-size 200 \
    --format json 2>/dev/null || true)
  if [ -n "$sa_list" ]; then
    local tmp
    tmp=$(mktemp)
    printf "%s" "$sa_list" > "$tmp"
    NEBIUS_SA_NAME="$NEBIUS_SA_NAME" python3 - "$tmp" <<'PY'
import json, os, sys
path = sys.argv[1]
raw = open(path, "r", encoding="utf-8").read().strip()
if not raw:
    sys.exit(0)
data = json.loads(raw)
name = os.environ.get("NEBIUS_SA_NAME", "")
def find(obj):
  if isinstance(obj, dict):
    meta = obj.get("metadata")
    if isinstance(meta, dict) and meta.get("name") == name:
      print(meta.get("id") or "")
      return True
    for v in obj.values():
      if find(v):
        return True
  elif isinstance(obj, list):
    for v in obj:
      if find(v):
        return True
  return False
find(data)
PY
    rm -f "$tmp"
  fi
}

select_projects_by_region() {
  # From a project list, pick exactly one project per known region.
  # Prefers "default-project-<region>" if present.
  local json="$1"
  local tmp
  tmp=$(mktemp)
  printf "%s" "$json" > "$tmp"
  REGION_LIST="${REGIONS[*]}" python3 - "$tmp" <<'PY'
import json, os, sys
path = sys.argv[1]
regions = os.environ.get("REGION_LIST", "").split()
raw = open(path, "r", encoding="utf-8").read().strip()
if not raw:
    sys.exit(1)
data = json.loads(raw)
items = data.get("items") if isinstance(data, dict) else data
items = items or []
def region_from_item(item):
  if not isinstance(item, dict):
    return None
  spec = item.get("spec") or {}
  if isinstance(spec, dict):
    region = spec.get("region") or spec.get("location")
    if region in regions:
      return region
  meta = item.get("metadata") or {}
  name = meta.get("name") or ""
  for r in regions:
    if r in name:
      return r
  return None

candidates = {r: [] for r in regions}
for item in items:
  region = region_from_item(item)
  if region:
    candidates.setdefault(region, []).append(item)

def pick(region, items):
  if not items:
    return None
  def name(it):
    meta = it.get("metadata") or {}
    return meta.get("name") or ""
  for it in items:
    if name(it).startswith("default-project-"):
      return it
  return items[0]

for region in regions:
  selected = pick(region, candidates.get(region, []))
  if not selected:
    print(f"Warning: no project found for region {region}", file=sys.stderr)
    continue
  meta = selected.get("metadata") or {}
  pid = meta.get("id") or ""
  pname = meta.get("name") or ""
  if pid:
    print(f"{region}\t{pid}\t{pname}")
PY
  rm -f "$tmp"
}

first_id_from_list() {
  # Return the first resource ID from a list response, plus total count and name.
  local label="$1"
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  python3 - "$label" "$tmp" <<'PY'
import json, sys
label = sys.argv[1]
path = sys.argv[2]
raw = open(path, "r", encoding="utf-8").read().strip()
if not raw:
  sys.exit(1)
data = json.loads(raw)
items = []
def visit(obj):
  if isinstance(obj, dict):
    meta = obj.get("metadata")
    if isinstance(meta, dict):
      mid = meta.get("id")
      name = meta.get("name") or ""
      if mid:
        items.append((mid, name))
    for v in obj.values():
      visit(v)
  elif isinstance(obj, list):
    for v in obj:
      visit(v)
visit(data)
if not items:
  sys.exit(2)
mid, name = items[0]
print(f"{mid}\t{len(items)}\t{name}")
PY
  rm -f "$tmp"
}

# 1) Pick the tenant to operate under.
TENANT_JSON=$(nebius iam tenant list --format json --page-size 100)
TENANT_ID=$(pick_id "tenant" "$TENANT_JSON")

log "Selected tenant: $TENANT_ID"

# 2) Pick one project per region (so we can support multi-region usage).
PROJECT_JSON=$(nebius iam project list --format json --page-size 200 --parent-id "$TENANT_ID")
PROJECT_LIST=$(select_projects_by_region "$PROJECT_JSON")

if [ -z "$PROJECT_LIST" ]; then
  echo "No projects found for the default regions. Please create projects in Nebius." >&2
  exit 1
fi

# We'll collect one credentials JSON + subnet per region, then emit one blob.
CONFIG_TMP=$(mktemp)
CREDS_FILES=()

while IFS=$'\t' read -r REGION PROJECT_ID PROJECT_NAME; do
  if [ -z "$PROJECT_ID" ]; then
    continue
  fi
  log "Selected project for ${REGION}: ${PROJECT_NAME:-$PROJECT_ID}"

  # 3) Ensure service account exists (create if missing, otherwise reuse).
  log "Ensuring service account '$NEBIUS_SA_NAME' exists..."
  CREATE_ERR=$(mktemp)
  nebius iam service-account create \
    --parent-id "$PROJECT_ID" \
    --name "$NEBIUS_SA_NAME" \
    --async true \
    --format json >/dev/null 2>"$CREATE_ERR" || true

  if [ -s "$CREATE_ERR" ]; then
    echo "Warning: service-account create returned a message (often means it already exists):" >&2
    sed -n '1,120p' "$CREATE_ERR" >&2
  fi
  rm -f "$CREATE_ERR"

  # Wait briefly for eventual consistency after creation.
  SA_ID=""
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [ "$attempt" -eq 1 ]; then
      log "Waiting for service account lookup..."
    fi
    SA_ID=$(find_sa_id "$PROJECT_ID")
    if [ -n "$SA_ID" ]; then
      break
    fi
    sleep 2
  done

  if [ -z "$SA_ID" ]; then
    echo "Failed to create or lookup service account '$NEBIUS_SA_NAME' in $PROJECT_ID." >&2
    exit 1
  fi

  log "Service account: $SA_ID"

  # 4) Attach service account to editors group (needed for compute ops).
  EDITORS_GROUP_ID=$(nebius iam group get-by-name \
    --name editors \
    --parent-id "$TENANT_ID" \
    --format jsonpath='{.metadata.id}' 2>/dev/null || true)

  if [ -z "$EDITORS_GROUP_ID" ]; then
    echo "Failed to lookup editors group for tenant $TENANT_ID." >&2
    exit 1
  fi

  nebius iam group-membership create \
    --parent-id "$EDITORS_GROUP_ID" \
    --member-id "$SA_ID" >/dev/null || true

  # 5) Generate credentials JSON for the service account.
  CREDS_PATH=$(mktemp)
  CREDS_FILES+=("$CREDS_PATH")
  log "Generating service account credentials..."
  nebius iam auth-public-key generate \
    --parent-id "$PROJECT_ID" \
    --service-account-id "$SA_ID" \
    --output "$CREDS_PATH"

  # 6) Pick a subnet for the project (auto-select the first subnet).
  SUBNET_JSON=$(nebius vpc subnet list --format json --page-size 100 --parent-id "$PROJECT_ID")
  SUBNET_INFO=$(first_id_from_list "subnet" <<<"$SUBNET_JSON" || true)
  if [ -z "$SUBNET_INFO" ]; then
    warn "No subnet found for ${REGION}. Skipping region."
    continue
  fi
  SUBNET_ID=$(echo "$SUBNET_INFO" | cut -f1)
  SUBNET_COUNT=$(echo "$SUBNET_INFO" | cut -f2)
  SUBNET_NAME=$(echo "$SUBNET_INFO" | cut -f3)
  if [ "${SUBNET_COUNT:-1}" -gt 1 ]; then
    warn "Multiple subnets found for ${REGION}; using the first (${SUBNET_NAME:-$SUBNET_ID})."
  fi

  log "Selected subnet: $SUBNET_ID"

  printf "%s\t%s\t%s\t%s\n" "$REGION" "$PROJECT_ID" "$SUBNET_ID" "$CREDS_PATH" >> "$CONFIG_TMP"
done <<<"$PROJECT_LIST"

if [ ! -s "$CONFIG_TMP" ]; then
  echo "No regions were configured. Please ensure projects and subnets exist in Nebius." >&2
  exit 1
fi

# 7) Emit a JSON blob that the wizard can parse and apply.
export CONFIG_TMP NEBIUS_PREFIX START_MARKER END_MARKER

python3 - <<'PY'
import json, os
config_path = os.environ["CONFIG_TMP"]
prefix = os.environ.get("NEBIUS_PREFIX", "cocalc-host")
region_config = {}
with open(config_path, "r", encoding="utf-8") as f:
  for line in f:
    line = line.strip()
    if not line:
      continue
    region, project_id, subnet_id, creds_path = line.split("\t", 3)
    creds = open(creds_path, "r", encoding="utf-8").read()
    region_config[region] = {
      "nebius_credentials_json": creds,
      "nebius_parent_id": project_id,
      "nebius_subnet_id": subnet_id,
    }
out = {
  "nebius_region_config_json": region_config,
  "project_hosts_nebius_prefix": prefix,
}
print(os.environ.get("START_MARKER"))
print(json.dumps(out, indent=2))
print(os.environ.get("END_MARKER"))
PY

# 8) Cleanup temp files with credentials.
rm -f "$CONFIG_TMP"
for f in "${CREDS_FILES[@]}"; do
  rm -f "$f"
done
