#!/usr/bin/env bash
# Tests for upgrade-bay-release.sh's settle_confirm (the post-upgrade settle
# check) and its ssh options. The script only runs main when executed, so it
# can be sourced here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"

# shellcheck source=upgrade-bay-release.sh
source "${SCRIPT_DIR}/upgrade-bay-release.sh"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# fake_reader prints the next line of $READS (one read per call) and exits
# with the rc given after a '|' on that line ("state|rc").
fake_reader() {
  local n line
  n=$(( $(cat "${TMP}/calls" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"${TMP}/calls"
  line="$(sed -n "${n}p" "$READS")"
  [[ -n "$line" ]] || line="$(tail -n 1 "$READS")"
  printf '%s\n' "${line%%|*}"
  return "${line##*|}"
}

# run_case <name> <expect rc> <expect reads> <tries> <confirms> <reads...>
run_case() {
  local name="$1" want_rc="$2" want_reads="$3"
  HOST_SETTLE_TRIES="$4"
  HOST_SETTLE_CONFIRMS="$5"
  HOST_SETTLE_INTERVAL=0
  shift 5
  READS="${TMP}/${name}.reads"
  printf '%s\n' "$@" >"$READS"
  rm -f "${TMP}/calls"
  local rc=0
  settle_confirm "$name" "${TMP}/${name}" fake_reader >/dev/null || rc=$?
  local reads
  reads="$(cat "${TMP}/calls")"
  [[ "$rc" == "$want_rc" ]] || fail "$name: rc=$rc, expected $want_rc"
  [[ "$reads" == "$want_reads" ]] || fail "$name: $reads reads, expected $want_reads"
  [[ "$(grep -c ' read ' "${TMP}/${name}.settle.log")" == "$want_reads" ]] \
    || fail "$name: settle log does not have one line per read"
  if [[ "$want_rc" == 0 ]]; then
    [[ -s "${TMP}/${name}.txt" ]] || fail "$name: no settled output"
  else
    [[ ! -e "${TMP}/${name}.txt" ]] || fail "$name: settled output written on failure"
  fi
  echo "ok: $name"
}

# Stable from the first read: 1 read + 2 unchanged confirming reads.
run_case stable 0 3 20 2 "a|0" "a|0" "a|0"
# Still changing after --wait, then stable.
run_case settles-late 0 5 20 2 "old|0" "mixed|0" "new|0" "new|0" "new|0"
# Never the same twice in a row: fails after all tries.
run_case never 1 6 6 2 "a|0" "b|0" "a|0" "b|0" "a|0" "b|0"
# One unchanged confirm is not enough when two are required.
run_case one-confirm-short 1 4 4 2 "a|0" "a|0" "b|0" "b|0"
# A failed read resets the run, even if the state reads the same around it.
run_case failed-read-resets 0 6 20 2 "a|0" "a|0" "a|1" "a|0" "a|0" "a|0"
# A read that keeps failing never passes, even with the same output.
run_case always-failing 1 5 5 2 "a|1"
# --host-settle-tries 0: a single read, as before this check existed.
run_case single-read 0 1 0 2 "a|0"
run_case single-read-failed 1 1 0 2 "a|1"

# ssh: non-interactive with a bounded connect by default.
printf '%s\n' "${SSH_OPTS[@]}" | grep -qx 'BatchMode=yes' || fail "SSH_OPTS lacks BatchMode=yes"
printf '%s\n' "${SSH_OPTS[@]}" | grep -qx 'ConnectTimeout=30' || fail "SSH_OPTS lacks ConnectTimeout=30"
override="$(BAY_UPGRADE_SSH_OPTS="-o ConnectTimeout=5" bash -c \
  'source "$1"; printf "%s " "${SSH_OPTS[@]}"' _ "${SCRIPT_DIR}/upgrade-bay-release.sh")"
[[ "$override" == "-o ConnectTimeout=5 " ]] || fail "BAY_UPGRADE_SSH_OPTS override: got '$override'"
echo "ok: ssh options"

echo "PASS upgrade-bay-release-settle.test.sh"
