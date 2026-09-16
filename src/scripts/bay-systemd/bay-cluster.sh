#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COMMAND="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

CLUSTER_ID=""
SEED_BAY_ID=""
TOPOLOGY_EPOCH=""
PEER_HEALTH_PORT="9402"
PEER_HEALTH_PATH="/peer-health"
PEER_LOCAL_HEALTH_TIMEOUT="3"
SEED_CONAT_SERVER=""
SECRET_FILE=""
ROTATE_SECRET=1
RESTART_HUB_WORKERS=0
BAYS=()
SSH_ARGS=()
TEMP_DIR=""
GENERATED_SECRET_FILE=0
BAY_CREDENTIAL_FILES=()
BAY_CREDENTIAL_BOOTSTRAP_FILE=""

usage() {
  cat <<'EOF'
Usage: bay-cluster.sh <command> [options] --bay <id>=<ssh-target>=<internal-ip>...

Operate a small systemd bay cluster.

Commands:
  install-topology   render and install /etc/cocalc/bay-topology.env on each bay
                     and install a shared COCALC_CLUSTER_SHARED_SECRET
  status             run bay-status on every bay
  health             run bay-health --peers on every bay

Required for all commands:
  --bay <id>=<ssh-target>=<internal-ip>
                     repeat for every bay, e.g.
                     bay-0=ubuntu@34.0.157.185=10.206.0.21

Required for install-topology:
  --cluster <id>     cluster id, e.g. bella
  --seed-bay <id>    seed bay id

Options:
  --topology-epoch <value>
  --peer-health-port <n>       default: 9402
  --peer-health-path <path>    default: /peer-health
  --peer-local-health-timeout <s>
                              default: 3
  --seed-conat-server <url>   HTTPS seed Conat URL used by attached bays
  --secret-file <path>         shared cluster secret file to install; otherwise
                              a new secret is generated for install-topology
  --no-rotate-secret           install topology only, preserving existing
                              COCALC_CLUSTER_SHARED_SECRET values
  --restart-hub-workers        rolling-restart hub workers after installing
                              topology/secrets so running processes use them
  --ssh-arg <arg>              repeatable ssh/scp argument
  -h, --help                   show this help

Examples:
  ./src/scripts/bay-systemd/bay-cluster.sh install-topology \
    --cluster bella \
    --seed-bay bay-0 \
    --seed-conat-server https://seed.internal.example/conat \
    --restart-hub-workers \
    --bay bay-0=ubuntu@34.0.157.185=10.206.0.21 \
    --bay bay-1=ubuntu@34.0.146.0=10.206.0.22

  ./src/scripts/bay-systemd/bay-cluster.sh health \
    --bay bay-0=ubuntu@34.0.157.185=10.206.0.21 \
    --bay bay-1=ubuntu@34.0.146.0=10.206.0.22
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

log() {
  printf '\n==> %s\n' "$*" >&2
}

cleanup() {
  if [[ -n "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
  if [[ "$GENERATED_SECRET_FILE" -eq 1 && -n "$SECRET_FILE" ]]; then
    rm -f "$SECRET_FILE"
  fi
}
trap cleanup EXIT

q() {
  printf '%q' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cluster)
        CLUSTER_ID="$2"
        shift 2
        ;;
      --seed-bay)
        SEED_BAY_ID="$2"
        shift 2
        ;;
      --topology-epoch)
        TOPOLOGY_EPOCH="$2"
        shift 2
        ;;
      --peer-health-port)
        PEER_HEALTH_PORT="$2"
        shift 2
        ;;
      --peer-health-path)
        PEER_HEALTH_PATH="$2"
        shift 2
        ;;
      --peer-local-health-timeout)
        PEER_LOCAL_HEALTH_TIMEOUT="$2"
        shift 2
        ;;
      --seed-conat-server)
        SEED_CONAT_SERVER="$2"
        shift 2
        ;;
      --secret-file)
        SECRET_FILE="$2"
        shift 2
        ;;
      --no-rotate-secret)
        ROTATE_SECRET=0
        shift
        ;;
      --restart-hub-workers)
        RESTART_HUB_WORKERS=1
        shift
        ;;
      --bay)
        BAYS+=("$2")
        shift 2
        ;;
      --ssh-arg)
        SSH_ARGS+=("$2")
        shift 2
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

bay_id_at() {
  local entry="$1"
  printf '%s' "${entry%%=*}"
}

bay_remote_at() {
  local entry="$1"
  local rest="${entry#*=}"
  printf '%s' "${rest%%=*}"
}

bay_internal_ip_at() {
  local entry="$1"
  local rest="${entry#*=}"
  printf '%s' "${rest#*=}"
}

validate_bays() {
  [[ "${#BAYS[@]}" -gt 0 ]] || die "at least one --bay is required"
  local entry bay_id remote internal_ip
  for entry in "${BAYS[@]}"; do
    [[ "$entry" == *=*=* ]] || die "--bay must be id=ssh-target=internal-ip: ${entry}"
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    internal_ip="$(bay_internal_ip_at "$entry")"
    [[ -n "$bay_id" ]] || die "empty bay id in --bay ${entry}"
    [[ -n "$remote" ]] || die "empty ssh target in --bay ${entry}"
    [[ -n "$internal_ip" ]] || die "empty internal ip in --bay ${entry}"
  done
}

validate_args() {
  case "$COMMAND" in
    install-topology|status|health)
      ;;
    ""|-h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown command: ${COMMAND}"
      ;;
  esac
  validate_bays
  if [[ "$COMMAND" == "install-topology" ]]; then
    [[ -n "$CLUSTER_ID" ]] || die "--cluster is required for install-topology"
    [[ -n "$SEED_BAY_ID" ]] || die "--seed-bay is required for install-topology"
    if [[ -n "$SECRET_FILE" && ! -r "$SECRET_FILE" ]]; then
      die "--secret-file is not readable: ${SECRET_FILE}"
    fi
    if [[ "${#BAYS[@]}" -gt 1 ]]; then
      [[ -n "$SEED_CONAT_SERVER" ]] || die "--seed-conat-server is required for multibay topology"
      case "$SEED_CONAT_SERVER" in
        https://*) ;;
        http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
        *) die "--seed-conat-server must use HTTPS outside loopback" ;;
      esac
    fi
  fi
  [[ "$PEER_HEALTH_PORT" =~ ^[0-9]+$ ]] || die "--peer-health-port must be an integer"
  [[ "$PEER_LOCAL_HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "--peer-local-health-timeout must be an integer"
  [[ "$PEER_HEALTH_PATH" == /* ]] || die "--peer-health-path must start with /"
}

ssh_remote() {
  local remote="$1"
  shift
  ssh "${SSH_ARGS[@]}" "$remote" "$@"
}

scp_to_remote() {
  local src="$1"
  local remote="$2"
  local dst="$3"
  scp "${SSH_ARGS[@]}" "$src" "${remote}:${dst}"
}

render_topology_for_bay() {
  local local_bay_id="$1"
  local output="$2"
  local args=(
    "--cluster" "$CLUSTER_ID"
    "--seed-bay" "$SEED_BAY_ID"
    "--local-bay" "$local_bay_id"
    "--peer-health-port" "$PEER_HEALTH_PORT"
    "--peer-health-path" "$PEER_HEALTH_PATH"
    "--peer-local-health-timeout" "$PEER_LOCAL_HEALTH_TIMEOUT"
    "--seed-conat-server" "$SEED_CONAT_SERVER"
  )
  if [[ -n "$TOPOLOGY_EPOCH" ]]; then
    args+=("--topology-epoch" "$TOPOLOGY_EPOCH")
  fi
  local entry
  for entry in "${BAYS[@]}"; do
    args+=("--bay" "$(bay_id_at "$entry")=$(bay_internal_ip_at "$entry")")
  done
  "${SCRIPT_DIR}/render-bay-topology-env.sh" "${args[@]}" > "$output"
}

prepare_secret_file() {
  if [[ "$ROTATE_SECRET" -eq 0 ]]; then
    return 0
  fi
  if [[ -n "$SECRET_FILE" ]]; then
    return 0
  fi
  SECRET_FILE="$(mktemp)"
  GENERATED_SECRET_FILE=1
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 0600 "$SECRET_FILE"
}

seed_bay_entry() {
  local entry
  for entry in "${BAYS[@]}"; do
    if [[ "$(bay_id_at "$entry")" == "$SEED_BAY_ID" ]]; then
      printf '%s' "$entry"
      return 0
    fi
  done
  return 1
}

prepare_bay_credentials() {
  BAY_CREDENTIAL_BOOTSTRAP_FILE="${TEMP_DIR}/bay-credential-bootstrap.json"
  local entry bay_id remote credential_file status
  for entry in "${BAYS[@]}"; do
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    credential_file="${TEMP_DIR}/${bay_id}-credential"
    # install-topology is routinely rerun to change addresses and ports. Keep
    # the enrolled credential stable; rotation is a separate, explicit
    # operator action that updates the live seed before replacing the bay file.
    if ssh_remote "$remote" "sudo sh -c 'test -s /etc/cocalc/bay-credential && exit 0; exit 44'"; then
      log "Reuse existing credential for ${bay_id} (${remote})"
      ssh_remote "$remote" "sudo cat /etc/cocalc/bay-credential" \
        > "$credential_file"
    else
      status=$?
      if [[ "$status" -ne 44 ]]; then
        die "failed to inspect existing credential on ${bay_id} (${remote}); ssh exited ${status}"
      fi
      log "Generate initial credential for ${bay_id} (${remote})"
      printf 'cocalc-bay-v1.%s.%s\n' "$(cat /proc/sys/kernel/random/uuid)" "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" > "$credential_file"
    fi
    chmod 0600 "$credential_file"
    BAY_CREDENTIAL_FILES+=("${bay_id}=${credential_file}")
  done
  python3 - "$CLUSTER_ID" "$BAY_CREDENTIAL_BOOTSTRAP_FILE" "${BAY_CREDENTIAL_FILES[@]}" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

cluster_id = sys.argv[1]
output = Path(sys.argv[2])
entries = []
for item in sys.argv[3:]:
    bay_id, filename = item.split("=", 1)
    credential = Path(filename).read_text(encoding="utf-8").strip()
    prefix, credential_id, secret = credential.split(".")
    if prefix != "cocalc-bay-v1":
        raise SystemExit("invalid generated bay credential")
    entries.append({
        "cluster_id": cluster_id,
        "bay_id": bay_id,
        "credential_id": credential_id,
        "secret_digest": hashlib.sha256(secret.encode()).hexdigest(),
    })
output.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
PY
  chmod 0600 "$BAY_CREDENTIAL_BOOTSTRAP_FILE"
}

bay_credential_file() {
  local requested="$1" item
  for item in "${BAY_CREDENTIAL_FILES[@]}"; do
    if [[ "${item%%=*}" == "$requested" ]]; then
      printf '%s' "${item#*=}"
      return 0
    fi
  done
  return 1
}

remote_install_command() {
  local remote_dir="$1"
  local bay_id="$2"
  local install_secret="$3"
  local install_bootstrap="$4"
  local remote_topology="${remote_dir}/topology.env"
  local remote_secret=""
  local remote_bay_credential="${remote_dir}/bay-credential"
  local remote_credential_bootstrap=""
  local installed_bootstrap="/mnt/cocalc/bays/${SEED_BAY_ID}/state/bay-credential-bootstrap.json"
  if [[ "$install_secret" == "1" ]]; then
    remote_secret="${remote_dir}/cluster-secret"
  fi
  if [[ "$install_bootstrap" == "1" ]]; then
    remote_credential_bootstrap="${remote_dir}/credential-bootstrap.json"
  fi
  cat <<EOF
set -euo pipefail
trap 'rm -rf $(q "$remote_dir")' EXIT
sudo install -o root -g root -m 0644 $(q "$remote_topology") /etc/cocalc/bay-topology.env
sudo install -o cocalc-bay -g cocalc-bay -m 0600 $(q "$remote_bay_credential") /etc/cocalc/bay-credential
if [[ -n $(q "$remote_credential_bootstrap") ]]; then
  sudo install -d -o cocalc-bay -g cocalc-bay -m 0700 $(q "/mnt/cocalc/bays/${SEED_BAY_ID}/state")
  sudo install -o cocalc-bay -g cocalc-bay -m 0600 $(q "$remote_credential_bootstrap") $(q "${installed_bootstrap}.new")
  sudo mv $(q "${installed_bootstrap}.new") $(q "$installed_bootstrap")
fi
sudo python3 - $(q "$remote_secret") $(q "$bay_id") $(q "$installed_bootstrap") $(q "$SEED_BAY_ID") <<'PY'
from pathlib import Path
import sys

cluster_secret_path = Path(sys.argv[1]) if sys.argv[1] else None
bay_id = sys.argv[2]
credential_bootstrap_path = sys.argv[3]
seed_bay_id = sys.argv[4]
path = Path("/etc/cocalc/bay-secrets.env")
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = [
    line for line in text.splitlines()
    if not line.startswith("COCALC_CLUSTER_SEED_CONAT_PASSWORD=")
]

def set_env(name: str, value: str) -> None:
    global lines
    for i, line in enumerate(lines):
        if line.startswith(f"{name}="):
            lines[i] = f"{name}={value}"
            return
    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"{name}={value}")

if cluster_secret_path and cluster_secret_path.is_file():
    set_env("COCALC_CLUSTER_SHARED_SECRET", cluster_secret_path.read_text(encoding="utf-8").strip())

set_env("COCALC_BAY_CREDENTIAL_FILE", "/etc/cocalc/bay-credential")
set_env(
    "COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE",
    credential_bootstrap_path if bay_id == seed_bay_id else "",
)

path.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
PY
sudo chmod 0600 /etc/cocalc/bay-secrets.env
sudo systemctl daemon-reload
sudo systemctl restart cocalc-bay-peer-health.service
if [[ $(q "$RESTART_HUB_WORKERS") == "1" ]]; then
  # shellcheck disable=SC1091
  source /opt/cocalc/bay/current/bin/lib.sh
  sudo /opt/cocalc/bay/current/bin/bay-rollout-workers "\$(current_version)"
fi
sudo /opt/cocalc/bay/current/bin/bay-status
EOF
}

install_topology() {
  require_command openssl
  require_command scp
  require_command ssh
  TEMP_DIR="$(mktemp -d)"
  prepare_secret_file
  prepare_bay_credentials
  if [[ -z "$TOPOLOGY_EPOCH" ]]; then
    TOPOLOGY_EPOCH="$(date +%s)"
  fi

  local ordered=() entry
  ordered+=("$(seed_bay_entry)")
  for entry in "${BAYS[@]}"; do
    if [[ "$(bay_id_at "$entry")" != "$SEED_BAY_ID" ]]; then
      ordered+=("$entry")
    fi
  done

  local bay_id remote topology_file remote_dir credential_file install_bootstrap
  for entry in "${ordered[@]}"; do
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    topology_file="${TEMP_DIR}/${bay_id}-topology.env"
    render_topology_for_bay "$bay_id" "$topology_file"
    log "Install topology on ${bay_id} (${remote})"
    remote_dir="$(ssh_remote "$remote" "umask 077; d=\$(mktemp -d /tmp/cocalc-bay.XXXXXXXX); chmod 0700 \"\$d\"; printf '%s' \"\$d\"")"
    [[ "$remote_dir" == /tmp/cocalc-bay.* ]] || die "invalid remote temporary directory from ${remote}"
    scp_to_remote "$topology_file" "$remote" "${remote_dir}/topology.env"
    if [[ "$ROTATE_SECRET" -eq 1 ]]; then
      scp_to_remote "$SECRET_FILE" "$remote" "${remote_dir}/cluster-secret"
    fi
    credential_file="$(bay_credential_file "$bay_id")"
    scp_to_remote "$credential_file" "$remote" "${remote_dir}/bay-credential"
    install_bootstrap=0
    if [[ "$bay_id" == "$SEED_BAY_ID" ]]; then
      install_bootstrap=1
      scp_to_remote "$BAY_CREDENTIAL_BOOTSTRAP_FILE" "$remote" "${remote_dir}/credential-bootstrap.json"
    fi
    ssh_remote "$remote" "$(remote_install_command "$remote_dir" "$bay_id" "$ROTATE_SECRET" "$install_bootstrap")"
    if [[ "$bay_id" == "$SEED_BAY_ID" ]]; then
      log "Wait for seed to consume credential enrollment"
      ssh_remote "$remote" "for i in \$(seq 1 30); do sudo test ! -e $(q "/mnt/cocalc/bays/${SEED_BAY_ID}/state/bay-credential-bootstrap.json") && exit 0; sleep 1; done; echo 'seed did not consume bay credential enrollment; restart hub workers and retry' >&2; exit 1"
    fi
  done
}

status_all() {
  local entry bay_id remote
  for entry in "${BAYS[@]}"; do
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    log "Status ${bay_id} (${remote})"
    ssh_remote "$remote" "sudo /opt/cocalc/bay/current/bin/bay-status"
  done
}

health_all() {
  local entry bay_id remote
  for entry in "${BAYS[@]}"; do
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    log "Peer health ${bay_id} (${remote})"
    ssh_remote "$remote" "sudo /opt/cocalc/bay/current/bin/bay-health --peers"
  done
}

main() {
  parse_args "$@"
  validate_args
  case "$COMMAND" in
    install-topology)
      install_topology
      health_all
      ;;
    status)
      status_all
      ;;
    health)
      health_all
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
