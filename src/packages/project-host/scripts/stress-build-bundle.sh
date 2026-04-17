#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ITERATIONS=10
SLEEP_SECONDS=2
HOST_SSH=""
LOG_DIR=""

usage() {
  cat <<'EOF'
Usage: stress-build-bundle.sh [options]

Run a bounded `pnpm build:bundle` stress test from the project-host package.

Options:
  --iterations N   Number of build iterations to run. Default: 10
  --sleep S        Seconds to sleep between iterations. Default: 2
  --host SSH       Optional SSH target for remote snapshots, e.g. ubuntu@34.106.144.109
  --log-dir DIR    Directory for logs. Default: <package>/tmp/stress-build-bundle/<timestamp>
  -h, --help       Show this help

The script writes:
  - summary.tsv with iteration timings and exit codes
  - build-<n>.log for each build iteration
  - remote snapshots before/after each iteration when --host is set

This is intentionally bounded. If you want a longer test, increase --iterations.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_int() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] || die "expected integer, got '$value'"
}

require_number() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "expected number, got '$value'"
}

timestamp() {
  date -u +"%Y%m%dT%H%M%SZ"
}

capture_remote_snapshot() {
  local label="$1"
  local out="$2"
  [[ -n "${HOST_SSH}" ]] || return 0
  ssh -o BatchMode=yes "${HOST_SSH}" "sudo -n bash -lc '
set -euo pipefail
echo __DATE__
date -Is
echo __UPTIME__
uptime
echo __SUPERVISION__
awk '\''/restart_requested|reconcile_failed|missing_process|started|rollback_/'\'' /mnt/cocalc/data/supervision-events.jsonl 2>/dev/null | tail -n 80 || true
echo __ROUTER_TRAFFIC__
grep -n \"project-host conat router traffic\" /mnt/cocalc/data/conat-router.log 2>/dev/null | tail -n 12 || true
echo __ACP_WARNINGS__
egrep '\''event loop stall|failed to publish live acp|publish slow|socket has been disconnected|once: timeout|once: \"ready\" not emitted'\'' /mnt/cocalc/data/logs/acp-worker.log 2>/dev/null | tail -n 80 || true
echo __PROJECT_HOST_WARNINGS__
egrep '\''event loop stall|TimeoutError|socket has been disconnected|health check failed|failed reading ACP worker control status'\'' /mnt/cocalc/data/log 2>/dev/null | tail -n 80 || true
' " >"${out}" 2>&1 || true
  printf '%s\t%s\n' "$(date -u -Is)" "${label}" >>"${LOG_DIR}/remote-snapshots.tsv"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iterations)
      shift
      [[ $# -gt 0 ]] || die "missing value for --iterations"
      require_int "$1"
      ITERATIONS="$1"
      ;;
    --sleep)
      shift
      [[ $# -gt 0 ]] || die "missing value for --sleep"
      require_number "$1"
      SLEEP_SECONDS="$1"
      ;;
    --host)
      shift
      [[ $# -gt 0 ]] || die "missing value for --host"
      HOST_SSH="$1"
      ;;
    --log-dir)
      shift
      [[ $# -gt 0 ]] || die "missing value for --log-dir"
      LOG_DIR="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
  shift
done

if [[ -z "${LOG_DIR}" ]]; then
  LOG_DIR="${PACKAGE_DIR}/tmp/stress-build-bundle/$(timestamp)"
fi
mkdir -p "${LOG_DIR}"

{
  echo "started_at=$(date -u -Is)"
  echo "package_dir=${PACKAGE_DIR}"
  echo "iterations=${ITERATIONS}"
  echo "sleep_seconds=${SLEEP_SECONDS}"
  echo "host_ssh=${HOST_SSH}"
  echo "git_commit=$(git -C "${PACKAGE_DIR}" rev-parse HEAD)"
} >"${LOG_DIR}/meta.env"

printf 'iteration\tstarted_at\tfinished_at\tduration_s\texit_code\tlog\n' >"${LOG_DIR}/summary.tsv"

echo "stress-build-bundle"
echo "  package: ${PACKAGE_DIR}"
echo "  iterations: ${ITERATIONS}"
echo "  sleep: ${SLEEP_SECONDS}s"
echo "  host snapshots: ${HOST_SSH:-disabled}"
echo "  logs: ${LOG_DIR}"

capture_remote_snapshot "before" "${LOG_DIR}/remote-before.log"

cd "${PACKAGE_DIR}"
for ((i = 1; i <= ITERATIONS; i += 1)); do
  started_at="$(date -u -Is)"
  start_s="$(date +%s)"
  build_log="${LOG_DIR}/build-${i}.log"
  echo "[${started_at}] iteration ${i}/${ITERATIONS}: pnpm build:bundle"

  set +e
  pnpm build:bundle >"${build_log}" 2>&1
  exit_code=$?
  set -e

  finished_at="$(date -u -Is)"
  finish_s="$(date +%s)"
  duration_s="$((finish_s - start_s))"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${i}" \
    "${started_at}" \
    "${finished_at}" \
    "${duration_s}" \
    "${exit_code}" \
    "${build_log}" >>"${LOG_DIR}/summary.tsv"

  capture_remote_snapshot "after-${i}" "${LOG_DIR}/remote-after-${i}.log"

  if [[ "${exit_code}" -ne 0 ]]; then
    echo "iteration ${i} failed; stopping"
    exit "${exit_code}"
  fi

  if [[ "${i}" -lt "${ITERATIONS}" && "${SLEEP_SECONDS}" != "0" ]]; then
    sleep "${SLEEP_SECONDS}"
  fi
done

capture_remote_snapshot "after" "${LOG_DIR}/remote-after.log"
echo "done"
echo "summary: ${LOG_DIR}/summary.tsv"
