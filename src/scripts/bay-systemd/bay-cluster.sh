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
SEED_CONAT_PORT="10300"
SECRET_FILE=""
SEED_CONAT_PASSWORD_FILE=""
ROTATE_SECRET=1
RESTART_HUB_WORKERS=0
BAYS=()
SSH_ARGS=()
TEMP_DIR=""
GENERATED_SECRET_FILE=0

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
  --seed-conat-port <n>       seed hub-worker Conat fabric port, default: 10300
  --seed-conat-password-file <path>
                              seed Conat password file; otherwise fetched from
                              the seed bay's secrets/conat-password
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
      --seed-conat-port)
        SEED_CONAT_PORT="$2"
        shift 2
        ;;
      --seed-conat-password-file)
        SEED_CONAT_PASSWORD_FILE="$2"
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
    if [[ -n "$SEED_CONAT_PASSWORD_FILE" && ! -r "$SEED_CONAT_PASSWORD_FILE" ]]; then
      die "--seed-conat-password-file is not readable: ${SEED_CONAT_PASSWORD_FILE}"
    fi
  fi
  [[ "$PEER_HEALTH_PORT" =~ ^[0-9]+$ ]] || die "--peer-health-port must be an integer"
  [[ "$PEER_LOCAL_HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || die "--peer-local-health-timeout must be an integer"
  [[ "$SEED_CONAT_PORT" =~ ^[0-9]+$ ]] || die "--seed-conat-port must be an integer"
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
    "--seed-conat-port" "$SEED_CONAT_PORT"
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

prepare_seed_conat_password_file() {
  if [[ -n "$SEED_CONAT_PASSWORD_FILE" ]]; then
    return 0
  fi
  local seed_entry seed_remote
  seed_entry="$(seed_bay_entry)" || die "--seed-bay is not present in --bay entries: ${SEED_BAY_ID}"
  seed_remote="$(bay_remote_at "$seed_entry")"
  SEED_CONAT_PASSWORD_FILE="${TEMP_DIR}/seed-conat-password"
  log "Fetch seed Conat password from ${SEED_BAY_ID} (${seed_remote})"
  ssh_remote "$seed_remote" "sudo cat /mnt/cocalc/bays/$(q "$SEED_BAY_ID")/secrets/conat-password" \
    > "$SEED_CONAT_PASSWORD_FILE"
  chmod 0600 "$SEED_CONAT_PASSWORD_FILE"
}

remote_install_command() {
  local remote_topology="$1"
  local remote_secret="$2"
  local remote_seed_conat_password="$3"
  cat <<EOF
set -euo pipefail
sudo install -o root -g root -m 0644 $(q "$remote_topology") /etc/cocalc/bay-topology.env
sudo python3 - $(q "$remote_secret") $(q "$remote_seed_conat_password") <<'PY'
from pathlib import Path
import sys

cluster_secret_path = Path(sys.argv[1]) if sys.argv[1] else None
seed_conat_password_path = Path(sys.argv[2]) if sys.argv[2] else None
path = Path("/etc/cocalc/bay-secrets.env")
text = path.read_text(encoding="utf-8") if path.exists() else ""
lines = text.splitlines()

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

if seed_conat_password_path and seed_conat_password_path.is_file():
    seed_conat_password = seed_conat_password_path.read_text(encoding="utf-8").strip()
    set_env("COCALC_CLUSTER_SEED_CONAT_PASSWORD", seed_conat_password)
    set_env("COCALC_INTER_BAY_CONAT_PASSWORD", seed_conat_password)

path.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
PY
sudo chmod 0600 /etc/cocalc/bay-secrets.env
rm -f $(q "$remote_topology") $(q "$remote_secret") $(q "$remote_seed_conat_password")
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
  prepare_seed_conat_password_file
  if [[ -z "$TOPOLOGY_EPOCH" ]]; then
    TOPOLOGY_EPOCH="$(date +%s)"
  fi

  local entry bay_id remote topology_file remote_topology remote_secret remote_seed_conat_password
  for entry in "${BAYS[@]}"; do
    bay_id="$(bay_id_at "$entry")"
    remote="$(bay_remote_at "$entry")"
    topology_file="${TEMP_DIR}/${bay_id}-topology.env"
    render_topology_for_bay "$bay_id" "$topology_file"
    remote_topology="/tmp/cocalc-${bay_id}-topology.$$"
    remote_secret=""
    log "Install topology on ${bay_id} (${remote})"
    scp_to_remote "$topology_file" "$remote" "$remote_topology"
    if [[ "$ROTATE_SECRET" -eq 1 ]]; then
      remote_secret="/tmp/cocalc-${bay_id}-cluster-secret.$$"
      scp_to_remote "$SECRET_FILE" "$remote" "$remote_secret"
    fi
    remote_seed_conat_password="/tmp/cocalc-${bay_id}-seed-conat-password.$$"
    scp_to_remote "$SEED_CONAT_PASSWORD_FILE" "$remote" "$remote_seed_conat_password"
    ssh_remote "$remote" "$(remote_install_command "$remote_topology" "$remote_secret" "$remote_seed_conat_password")"
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

main "$@"
