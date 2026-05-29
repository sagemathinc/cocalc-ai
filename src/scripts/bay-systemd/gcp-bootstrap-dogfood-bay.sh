#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_ROOT="$(realpath "${SCRIPT_DIR}/../..")"
REPO_ROOT="$(realpath "${SRC_ROOT}/..")"

GCP_PROJECT=""
VM_NAME=""
BAY_ID=""
ZONE=""
MACHINE_TYPE="t2d-standard-4"
BOOT_DISK_SIZE="50GB"
BOOT_DISK_TYPE="pd-balanced"
IMAGE_FAMILY="ubuntu-2404-lts-amd64"
IMAGE_PROJECT="ubuntu-os-cloud"
PUBLIC_URL=""
WORKER_COUNT="2"
LOCAL_FORWARD_HOST="127.0.0.1"
LOCAL_FORWARD_PORT="7001"
REMOTE_FORWARD_PORT="9300"
SITE_MASTER_KEY_PATH=""
REUSE_EXISTING_VM=0
SKIP_BUILD=0
SKIP_PORT_FORWARD=0
NETWORK=""
SUBNET=""
SERVICE_ACCOUNT=""
TAGS="cocalc-bay"

usage() {
  cat <<'EOF'
Usage: gcp-bootstrap-dogfood-bay.sh [options]

Create a GCP VM and bootstrap a CoCalc bay using the systemd deployment
scaffold. This is intentionally a dogfood/deployment bring-up helper, not a
general cloud provider abstraction.

Required:
  --gcp-project <project>       GCP project id
  --vm-name <name>              GCP VM instance name
  --bay-id <id>                 bay id, e.g. bay-0 or bay-1
  --zone <zone>                 GCP zone, e.g. us-south1-a

Common:
  --machine-type <type>         default: t2d-standard-4
  --boot-disk-size <size>       default: 50GB
  --boot-disk-type <type>       default: pd-balanced
  --public-url <url>            public/base URL to write into bay config
  --worker-count <n>            hub worker count, default: 2
  --local-forward-port <port>   local SSH forward port, default: 7001
  --remote-forward-port <port>  remote hub worker port, default: 9300
  --site-master-key <path>      local site master key path; default:
                                ~/.cocalc/dogfood/<gcp-project>/site-master-key

GCP:
  --image-family <family>       default: ubuntu-2404-lts-amd64
  --image-project <project>     default: ubuntu-os-cloud
  --network <network>           optional gcloud --network value
  --subnet <subnet>             optional gcloud --subnet value
  --service-account <email>     optional gcloud --service-account value
  --tags <tags>                 comma-separated instance tags, default: cocalc-bay
  --reuse-existing-vm           do not fail if the VM already exists

Control:
  --skip-build                  reuse existing Rocket bay bundle
  --skip-port-forward           do not start the local SSH port forward
  -h, --help                    show this help

Example:
  src/scripts/bay-systemd/gcp-bootstrap-dogfood-bay.sh \
    --gcp-project cocalc-demo \
    --vm-name demo-bay-0 \
    --bay-id bay-0 \
    --zone us-south1-a \
    --public-url https://demo.cocalc.ai \
    --local-forward-port 7001
EOF
}

log() {
  printf '[gcp-dogfood-bay] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

run() {
  log "+ $*"
  "$@"
}

require_command() {
  local command="$1"
  if ! command -v "$command" >/dev/null 2>&1; then
    die "required command not found: ${command}"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --gcp-project)
        GCP_PROJECT="$2"
        shift 2
        ;;
      --vm-name)
        VM_NAME="$2"
        shift 2
        ;;
      --bay-id)
        BAY_ID="$2"
        shift 2
        ;;
      --zone)
        ZONE="$2"
        shift 2
        ;;
      --machine-type)
        MACHINE_TYPE="$2"
        shift 2
        ;;
      --boot-disk-size)
        BOOT_DISK_SIZE="$2"
        shift 2
        ;;
      --boot-disk-type)
        BOOT_DISK_TYPE="$2"
        shift 2
        ;;
      --image-family)
        IMAGE_FAMILY="$2"
        shift 2
        ;;
      --image-project)
        IMAGE_PROJECT="$2"
        shift 2
        ;;
      --public-url)
        PUBLIC_URL="$2"
        shift 2
        ;;
      --worker-count)
        WORKER_COUNT="$2"
        shift 2
        ;;
      --local-forward-port)
        LOCAL_FORWARD_PORT="$2"
        shift 2
        ;;
      --remote-forward-port)
        REMOTE_FORWARD_PORT="$2"
        shift 2
        ;;
      --site-master-key)
        SITE_MASTER_KEY_PATH="$2"
        shift 2
        ;;
      --network)
        NETWORK="$2"
        shift 2
        ;;
      --subnet)
        SUBNET="$2"
        shift 2
        ;;
      --service-account)
        SERVICE_ACCOUNT="$2"
        shift 2
        ;;
      --tags)
        TAGS="$2"
        shift 2
        ;;
      --reuse-existing-vm)
        REUSE_EXISTING_VM=1
        shift
        ;;
      --skip-build)
        SKIP_BUILD=1
        shift
        ;;
      --skip-port-forward)
        SKIP_PORT_FORWARD=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
}

validate_args() {
  [[ -n "$GCP_PROJECT" ]] || die "--gcp-project is required"
  [[ -n "$VM_NAME" ]] || die "--vm-name is required"
  [[ -n "$BAY_ID" ]] || die "--bay-id is required"
  [[ -n "$ZONE" ]] || die "--zone is required"
  [[ "$WORKER_COUNT" =~ ^[0-9]+$ ]] || die "--worker-count must be an integer"
  [[ "$WORKER_COUNT" -ge 1 ]] || die "--worker-count must be at least 1"
  [[ "$LOCAL_FORWARD_PORT" =~ ^[0-9]+$ ]] || die "--local-forward-port must be an integer"
  [[ "$REMOTE_FORWARD_PORT" =~ ^[0-9]+$ ]] || die "--remote-forward-port must be an integer"
  if [[ -z "$SITE_MASTER_KEY_PATH" ]]; then
    SITE_MASTER_KEY_PATH="${HOME}/.cocalc/dogfood/${GCP_PROJECT}/site-master-key"
  fi
}

require_tools() {
  require_command gcloud
  require_command openssl
  require_command pnpm
  require_command realpath
  require_command sha256sum
  require_command base64
}

gcloud_base() {
  gcloud --project "$GCP_PROJECT"
}

vm_exists() {
  gcloud compute instances describe "$VM_NAME" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    >/dev/null 2>&1
}

create_vm() {
  if vm_exists; then
    if [[ "$REUSE_EXISTING_VM" -eq 1 ]]; then
      log "VM already exists; reusing ${VM_NAME}"
      return 0
    fi
    die "VM ${VM_NAME} already exists in ${ZONE}; pass --reuse-existing-vm to reuse it"
  fi

  local args=(
    compute instances create "$VM_NAME"
    --project "$GCP_PROJECT"
    --zone "$ZONE"
    --machine-type "$MACHINE_TYPE"
    --provisioning-model STANDARD
    --boot-disk-size "$BOOT_DISK_SIZE"
    --boot-disk-type "$BOOT_DISK_TYPE"
    --image-family "$IMAGE_FAMILY"
    --image-project "$IMAGE_PROJECT"
    --labels "cocalc-bay=true,bay-id=${BAY_ID}"
  )
  if [[ -n "$TAGS" ]]; then
    args+=(--tags "$TAGS")
  fi
  if [[ -n "$NETWORK" ]]; then
    args+=(--network "$NETWORK")
  fi
  if [[ -n "$SUBNET" ]]; then
    args+=(--subnet "$SUBNET")
  fi
  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    args+=(--service-account "$SERVICE_ACCOUNT")
  fi

  run gcloud "${args[@]}"
}

wait_for_ssh() {
  log "waiting for SSH to ${VM_NAME}"
  local i
  for i in $(seq 1 60); do
    if gcloud compute ssh "$VM_NAME" \
      --project "$GCP_PROJECT" \
      --zone "$ZONE" \
      --command "true" \
      --quiet \
      >/dev/null 2>&1; then
      log "SSH is ready"
      return 0
    fi
    sleep 5
  done
  die "timed out waiting for SSH to ${VM_NAME}"
}

remote_ssh() {
  gcloud compute ssh "$VM_NAME" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --quiet \
    --command "$1"
}

remote_scp() {
  gcloud compute scp \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --quiet \
    "$@"
}

build_bundle() {
  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    log "skipping Rocket bay bundle build"
  else
    run pnpm -C "${SRC_ROOT}/packages" --filter @cocalc/rocket run build:bay-bundle >&2
  fi

  local bundle
  bundle="$(
    find "${SRC_ROOT}/packages/rocket/build" \
      -name 'cocalc-bay-runtime-linux-*.tar.xz' \
      -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr \
      | awk 'NR==1 {print $2}'
  )"
  [[ -n "$bundle" && -f "$bundle" ]] || die "Rocket bay bundle not found; build failed?"
  printf '%s\n' "$bundle"
}

ensure_site_master_key() {
  if [[ ! -f "$SITE_MASTER_KEY_PATH" ]]; then
    log "creating site master key at ${SITE_MASTER_KEY_PATH}"
    mkdir -p "$(dirname "$SITE_MASTER_KEY_PATH")"
    umask 077
    openssl rand -base64 32 > "$SITE_MASTER_KEY_PATH"
    chmod 0600 "$SITE_MASTER_KEY_PATH"
  else
    log "using existing site master key at ${SITE_MASTER_KEY_PATH}"
  fi

  local decoded_len
  decoded_len="$(base64 -d "$SITE_MASTER_KEY_PATH" 2>/dev/null | wc -c | tr -d ' ')"
  [[ "$decoded_len" == "32" ]] || die "site master key must decode to 32 bytes: ${SITE_MASTER_KEY_PATH}"
}

copy_inputs() {
  local bundle="$1"
  local remote_bundle="/tmp/$(basename "$bundle")"

  run remote_ssh "rm -rf /tmp/bay-systemd /tmp/site-master-key /tmp/cocalc-bay-runtime-linux-*.tar.xz" >&2
  run remote_scp --recurse "$SCRIPT_DIR" "${VM_NAME}:/tmp/bay-systemd" >&2
  run remote_scp "$bundle" "${VM_NAME}:${remote_bundle}" >&2
  run remote_scp "$SITE_MASTER_KEY_PATH" "${VM_NAME}:/tmp/site-master-key" >&2

  printf '%s\n' "$remote_bundle"
}

bootstrap_remote_bay() {
  local remote_bundle="$1"
  local public_url_arg=()
  if [[ -n "$PUBLIC_URL" ]]; then
    public_url_arg=(--public-url "$PUBLIC_URL")
  fi

  run remote_ssh "sudo install -o root -g root -m 0600 /tmp/site-master-key /etc/cocalc/site-master-key"
  run remote_ssh "sudo /tmp/bay-systemd/bay-bootstrap-host.sh --bay-id '${BAY_ID}' --install-nodejs"
  run remote_ssh "$(
    printf "sudo /tmp/bay-systemd/bay-bootstrap-release.sh --bundle %q --bay-id %q --worker-count %q" \
      "$remote_bundle" "$BAY_ID" "$WORKER_COUNT"
    if [[ "${#public_url_arg[@]}" -gt 0 ]]; then
      printf " --public-url %q" "$PUBLIC_URL"
    fi
    printf " --start"
  )"
}

health_check() {
  run remote_ssh "sudo /opt/cocalc/bay/current/bin/bay-status"
  run remote_ssh "sudo /opt/cocalc/bay/current/bin/bay-health"
}

extract_bootstrap_url() {
  local raw
  raw="$(
    remote_ssh "sudo journalctl -u cocalc-bay-hub@1.service -n 500 --no-pager | grep -Eo 'https?://[^[:space:]]+' | grep 'registrationToken=' | tail -n 1" \
      2>/dev/null || true
  )"
  if [[ -z "$raw" ]]; then
    return 0
  fi
  printf '%s\n' "$raw" \
    | sed -E "s#https?://(127\\.0\\.0\\.1|localhost):[0-9]+#http://${LOCAL_FORWARD_HOST}:${LOCAL_FORWARD_PORT}#"
}

start_port_forward() {
  if [[ "$SKIP_PORT_FORWARD" -eq 1 ]]; then
    return 0
  fi

  log "starting SSH local port forward ${LOCAL_FORWARD_HOST}:${LOCAL_FORWARD_PORT} -> ${VM_NAME}:127.0.0.1:${REMOTE_FORWARD_PORT}"
  gcloud compute ssh "$VM_NAME" \
    --project "$GCP_PROJECT" \
    --zone "$ZONE" \
    --quiet \
    -- \
    -f -N -L "${LOCAL_FORWARD_HOST}:${LOCAL_FORWARD_PORT}:127.0.0.1:${REMOTE_FORWARD_PORT}"
}

print_summary() {
  local bundle="$1"
  local bootstrap_url="$2"
  local key_sha
  key_sha="$(sha256sum "$SITE_MASTER_KEY_PATH" | awk '{print $1}')"

  cat <<EOF

Dogfood bay bootstrap complete.

Bay:
  gcp_project:       ${GCP_PROJECT}
  vm_name:           ${VM_NAME}
  zone:              ${ZONE}
  bay_id:            ${BAY_ID}
  bundle:            ${bundle}

Site master key:
  local_path:        ${SITE_MASTER_KEY_PATH}
  sha256:            ${key_sha}
  vm_path:           /etc/cocalc/site-master-key

Store the site master key in 1Password now. For example:
  op item create --category=password --title "CoCalc dogfood ${GCP_PROJECT} site master key" "key[file]=${SITE_MASTER_KEY_PATH}"

Useful commands:
  gcloud compute ssh ${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE}
  gcloud compute ssh ${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command 'sudo /opt/cocalc/bay/current/bin/bay-status'
  gcloud compute ssh ${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command 'sudo journalctl -u cocalc-bay-hub@1.service -n 200 --no-pager'

EOF

  if [[ "$SKIP_PORT_FORWARD" -eq 0 ]]; then
    cat <<EOF
Local access:
  forwarded_url:     http://${LOCAL_FORWARD_HOST}:${LOCAL_FORWARD_PORT}

EOF
  fi

  if [[ -n "$bootstrap_url" ]]; then
    cat <<EOF
Bootstrap admin URL:
  ${bootstrap_url}

EOF
  else
    cat <<EOF
Bootstrap admin URL:
  Not found in hub logs yet. Check:
    gcloud compute ssh ${VM_NAME} --project ${GCP_PROJECT} --zone ${ZONE} --command 'sudo journalctl -u cocalc-bay-hub@1.service -n 500 --no-pager'

EOF
  fi
}

main() {
  parse_args "$@"
  validate_args
  require_tools

  log "repo root: ${REPO_ROOT}"
  log "src root: ${SRC_ROOT}"

  local bundle
  bundle="$(build_bundle)"
  ensure_site_master_key
  create_vm
  wait_for_ssh

  local remote_bundle
  remote_bundle="$(copy_inputs "$bundle")"
  bootstrap_remote_bay "$remote_bundle"
  health_check

  local bootstrap_url
  bootstrap_url="$(extract_bootstrap_url)"
  start_port_forward
  print_summary "$bundle" "$bootstrap_url"
}

main "$@"
