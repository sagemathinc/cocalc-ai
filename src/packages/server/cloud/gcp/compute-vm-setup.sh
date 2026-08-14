#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID=${PROJECT_ID:-}
SA_NAME=${SA_NAME:-cocalc-compute-vm}
NETWORK=${NETWORK:-cocalc-compute-vm}
SUBNET_POOL=${SUBNET_POOL:-10.128.0.0/9}
SUBNET_PREFIX_LENGTH=${SUBNET_PREFIX_LENGTH:-20}
NETWORK_TAG=${NETWORK_TAG:-cocalc-compute-vm}
REGIONS=${REGIONS:-}
SUBNET_CONCURRENCY=${SUBNET_CONCURRENCY:-8}

if [[ -z "$PROJECT_ID" ]]; then
  echo "PROJECT_ID is required" >&2
  exit 1
fi

if [[ ! "$SUBNET_CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
  echo "SUBNET_CONCURRENCY must be a positive integer" >&2
  exit 1
fi

gcloud services enable compute.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  --project "$PROJECT_ID"

gcloud compute networks describe "$NETWORK" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute networks create "$NETWORK" --project "$PROJECT_ID" --subnet-mode=custom

TMP_DIR=$(mktemp -d)
KEY_FILE="$TMP_DIR/service-account.json"
trap 'rm -rf "$TMP_DIR"' EXIT

gcloud compute regions list --project "$PROJECT_ID" --format=json >"$TMP_DIR/regions.json"
gcloud compute networks subnets list --project "$PROJECT_ID" --format=json >"$TMP_DIR/subnets.json"

python3 - \
  "$TMP_DIR/regions.json" \
  "$TMP_DIR/subnets.json" \
  "$TMP_DIR/subnet-plan.tsv" \
  "$PROJECT_ID" \
  "$NETWORK" \
  "$SUBNET_POOL" \
  "$SUBNET_PREFIX_LENGTH" \
  "$REGIONS" <<'PY'
import ipaddress
import json
import re
import sys

(
    regions_path,
    subnets_path,
    plan_path,
    project,
    network,
    pool_text,
    prefix_text,
    requested_text,
) = sys.argv[1:]

with open(regions_path) as f:
    region_rows = json.load(f)
with open(subnets_path) as f:
    subnet_rows = json.load(f)

available = sorted(
    row["name"]
    for row in region_rows
    if row.get("name") and row.get("status", "UP") == "UP"
)
if requested_text.strip():
    requested = sorted(set(filter(None, re.split(r"[\s,]+", requested_text.strip()))))
    unavailable = sorted(set(requested) - set(available))
    if unavailable:
        raise SystemExit(f"requested GCP regions are not active: {', '.join(unavailable)}")
    regions = requested
else:
    regions = available
if not regions:
    raise SystemExit("GCP returned no active regions")

def resource_path(value):
    return re.sub(r"^https://[^/]+/compute/v1/", "", str(value or ""))

network_uri = f"projects/{project}/global/networks/{network}"
managed = []
used = []
for row in subnet_rows:
    if resource_path(row.get("network")) != network_uri:
        continue
    ip_range = row.get("ipCidrRange")
    if ip_range:
        used.append(ipaddress.ip_network(ip_range))
    managed.append(row)

by_name = {row.get("name"): row for row in managed if row.get("name")}
pool = ipaddress.ip_network(pool_text)
prefix = int(prefix_text)
if pool.version != 4 or prefix < pool.prefixlen or prefix > 29:
    raise SystemExit("SUBNET_POOL and SUBNET_PREFIX_LENGTH must define usable IPv4 subnets")

candidates = iter(pool.subnets(new_prefix=prefix))

def allocate():
    for candidate in candidates:
        if any(candidate.overlaps(existing) for existing in used):
            continue
        used.append(candidate)
        return candidate
    raise SystemExit(f"no unused /{prefix} remains in {pool}")

plan = []
for region in regions:
    name = f"{network}-{region}"
    existing = by_name.get(name)
    if existing:
        observed_region = resource_path(existing.get("region")).split("/")[-1]
        if observed_region != region:
            raise SystemExit(
                f"subnet {name} exists in {observed_region}, expected {region}"
            )
        cidr = ipaddress.ip_network(existing["ipCidrRange"])
        log_config = existing.get("logConfig") or {}
        flow_logs_enabled = (
            existing.get("enableFlowLogs") is True
            or log_config.get("enable") is True
        )
        aggregation_interval = str(log_config.get("aggregationInterval") or "").upper()
        flow_sampling = float(log_config.get("flowSampling") or 0)
        metadata = str(log_config.get("metadata") or "").upper()
        action = "keep" if (
            flow_logs_enabled
            and aggregation_interval == "INTERVAL_5_SEC"
            and flow_sampling == 1.0
            and metadata == "INCLUDE_ALL_METADATA"
        ) else "update"
        plan.append((region, name, str(cidr), action))
    else:
        plan.append((region, name, str(allocate()), "create"))

with open(plan_path, "w") as f:
    for row in plan:
        f.write("\t".join(row) + "\n")
print(f"Planned {len(plan)} regional subnets on {network_uri}.")
PY

SUBNET_WORKER="$TMP_DIR/provision-subnet.sh"
cat >"$SUBNET_WORKER" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

project_id=$1
network=$2
log_dir=$3
region=$4
subnet=$5
subnet_range=$6
action=$7
log_file="$log_dir/subnet-${region}.log"

if [[ "$action" == "create" ]]; then
  echo "Creating $subnet in $region with $subnet_range"
  if gcloud compute networks subnets create "$subnet" \
    --project "$project_id" --region "$region" --network "$network" \
    --range "$subnet_range" --enable-flow-logs \
    --logging-aggregation-interval=interval-5-sec \
    --logging-flow-sampling=1.0 --logging-metadata=include-all \
    >"$log_file" 2>&1; then
    echo "Created $subnet in $region"
  else
    cat "$log_file" >&2
    echo "Failed to create $subnet in $region" >&2
    exit 1
  fi
elif [[ "$action" == "update" ]]; then
  echo "Ensuring VPC Flow Logs are enabled for $subnet in $region"
  if gcloud compute networks subnets update "$subnet" \
    --project "$project_id" --region "$region" --enable-flow-logs \
    --logging-aggregation-interval=interval-5-sec \
    --logging-flow-sampling=1.0 --logging-metadata=include-all \
    >"$log_file" 2>&1; then
    echo "Updated $subnet in $region"
  else
    cat "$log_file" >&2
    echo "Failed to update $subnet in $region" >&2
    exit 1
  fi
else
  echo "Unsupported subnet action '$action' for $subnet" >&2
  exit 1
fi
SH

subnet_task_count=$(awk -F $'\t' '$4 != "keep" { count++ } END { print count + 0 }' \
  "$TMP_DIR/subnet-plan.tsv")
if ((subnet_task_count > 0)); then
  echo "Provisioning $subnet_task_count regional subnets with up to $SUBNET_CONCURRENCY concurrent operations."
  python3 - "$TMP_DIR/subnet-plan.tsv" <<'PY' |
import csv
import sys

with open(sys.argv[1], newline="") as f:
    for row in csv.reader(f, delimiter="\t"):
        if len(row) != 4 or row[3] == "keep":
            continue
        for value in row:
            sys.stdout.buffer.write(value.encode() + b"\0")
PY
    xargs -0 -n 4 -P "$SUBNET_CONCURRENCY" \
      bash "$SUBNET_WORKER" "$PROJECT_ID" "$NETWORK" "$TMP_DIR"
fi

while IFS=$'\t' read -r region subnet _ action; do
  if [[ "$action" == "keep" ]]; then
    echo "Keeping configured subnet $subnet in $region"
  fi
done <"$TMP_DIR/subnet-plan.tsv"

if gcloud compute firewall-rules describe cocalc-compute-ssh --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules update cocalc-compute-ssh \
    --project "$PROJECT_ID" --network "$NETWORK" --direction=INGRESS \
    --priority=1000 --action=ALLOW --rules=tcp:22 \
    --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG"
else
  gcloud compute firewall-rules create cocalc-compute-ssh \
    --project "$PROJECT_ID" --network "$NETWORK" --direction=INGRESS \
    --priority=1000 --action=ALLOW --rules=tcp:22 \
    --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG"
fi

if gcloud compute firewall-rules describe cocalc-compute-https --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute firewall-rules update cocalc-compute-https \
    --project "$PROJECT_ID" --network "$NETWORK" --direction=INGRESS \
    --priority=1000 --action=ALLOW --rules=tcp:443 \
    --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG"
else
  gcloud compute firewall-rules create cocalc-compute-https \
    --project "$PROJECT_ID" --network "$NETWORK" --direction=INGRESS \
    --priority=1000 --action=ALLOW --rules=tcp:443 \
    --source-ranges=0.0.0.0/0 --target-tags="$NETWORK_TAG"
fi

# Guests need the metadata endpoint for normal GCE boot, but cannot reach
# private VPC, peering, VPN, or link-local destinations. Always update existing
# rules so rerunning setup repairs policy drift.
ensure_egress_rule() {
  local name="$1" priority="$2" action="$3" ranges="$4"
  if gcloud compute firewall-rules describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud compute firewall-rules update "$name" \
      --project "$PROJECT_ID" --network "$NETWORK" --direction=EGRESS \
      --priority="$priority" --action="$action" --rules=all \
      --destination-ranges="$ranges" --target-tags="$NETWORK_TAG"
  else
    gcloud compute firewall-rules create "$name" \
      --project "$PROJECT_ID" --network "$NETWORK" --direction=EGRESS \
      --priority="$priority" --action="$action" --rules=all \
      --destination-ranges="$ranges" --target-tags="$NETWORK_TAG"
  fi
}

ensure_egress_rule cocalc-compute-metadata 800 ALLOW 169.254.169.254/32
ensure_egress_rule cocalc-compute-deny-private 900 DENY 0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.0.2.0/24,192.88.99.0/24,192.168.0.0/16,198.18.0.0/15,198.51.100.0/24,199.36.153.4/30,199.36.153.8/30,203.0.113.0/24,224.0.0.0/4,240.0.0.0/4
ensure_egress_rule cocalc-compute-public-egress 1000 ALLOW 0.0.0.0/0

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
    --display-name="CoCalc managed compute VM controller"

for role in \
  roles/compute.instanceAdmin.v1 \
  roles/compute.networkUser \
  roles/compute.networkViewer \
  roles/compute.publicIpAdmin \
  roles/monitoring.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" \
    --condition=None --quiet >/dev/null
done

gcloud iam service-accounts keys create "$KEY_FILE" \
  --project "$PROJECT_ID" --iam-account "$SA_EMAIL"

python3 - "$KEY_FILE" "$PROJECT_ID" "$NETWORK" <<'PY'
import json, sys
key_path, project, network = sys.argv[1:]
with open(key_path) as f:
    key = json.load(f)
payload = {
    "compute_vm_gcp_service_account_json": key,
    "compute_vm_gcp_network": f"projects/{project}/global/networks/{network}",
}
print("=== COCALC GCP CONFIG START ===")
print(json.dumps(payload, indent=2))
print("=== COCALC GCP CONFIG END ===")
PY

if [[ -n "${COCALC_SETUP_UPLOAD_URL:-}" && -n "${COCALC_SETUP_TOKEN:-}" ]]; then
  UPLOAD_PAYLOAD="$TMP_DIR/upload-payload.json"
  UPLOAD_RESPONSE="$TMP_DIR/upload-response.json"
  python3 - "$KEY_FILE" "$PROJECT_ID" "$NETWORK" >"$UPLOAD_PAYLOAD" <<'PY'
import json, sys
key_path, project, network = sys.argv[1:]
with open(key_path) as f:
    key = json.load(f)
print(json.dumps({
    "compute_vm_gcp_service_account_json": key,
    "compute_vm_gcp_network": f"projects/{project}/global/networks/{network}",
}))
PY
  if ! upload_status=$(curl -sS -o "$UPLOAD_RESPONSE" -w '%{http_code}' \
    -X POST -H "Authorization: Bearer ${COCALC_SETUP_TOKEN}" \
    -H 'Content-Type: application/json' --data-binary "@$UPLOAD_PAYLOAD" \
    "$COCALC_SETUP_UPLOAD_URL"); then
    [[ ! -s "$UPLOAD_RESPONSE" ]] || cat "$UPLOAD_RESPONSE" >&2
    echo "Failed to upload the CoCalc provider configuration." >&2
    exit 1
  fi
  if [[ ! "$upload_status" =~ ^2[0-9][0-9]$ ]]; then
    [[ ! -s "$UPLOAD_RESPONSE" ]] || cat "$UPLOAD_RESPONSE" >&2
    echo "Provider configuration upload failed with HTTP $upload_status." >&2
    exit 1
  fi
  cat "$UPLOAD_RESPONSE"
fi
