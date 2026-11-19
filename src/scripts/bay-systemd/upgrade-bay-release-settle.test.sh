#!/usr/bin/env bash
# Tests for upgrade-bay-release.sh's settle_confirm (the post-upgrade settle
# check), hosts_at_expected_version and its ssh options. The script only runs
# main when executed, so it can be sourced here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"

# shellcheck source=upgrade-bay-release.sh
source "${SCRIPT_DIR}/upgrade-bay-release.sh"
trap 'chmod -R u+w "$TMP" 2>/dev/null; rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# fake_reader prints the next line of $READS (one read per call): "state#rc",
# where ';' in state separates output lines and "@none" prints nothing. Past the end it repeats the last.
fake_reader() {
  local n line state
  n=$(( $(cat "${TMP}/calls" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"${TMP}/calls"
  line="$(sed -n "${n}p" "$READS")"
  [[ -n "$line" ]] || line="$(tail -n 1 "$READS")"
  state="${line%#*}"
  # "@none" = the command prints nothing at all (no host rows).
  [[ "$state" == "@none" ]] || printf '%s\n' "${state//;/$'\n'}"
  return "${line##*#}"
}

# run_case <name> <expect rc> <expect reads> <tries> <confirms> <predicate> <reads...>
run_case() {
  local name="$1" want_rc="$2" want_reads="$3"
  HOST_SETTLE_TRIES="$4"
  HOST_SETTLE_CONFIRMS="$5"
  HOST_SETTLE_INTERVAL=0
  local predicate="$6"
  shift 6
  READS="${TMP}/${name}.reads"
  printf '%s\n' "$@" >"$READS"
  rm -f "${TMP}/calls"
  local rc=0
  settle_confirm "$name" "${PREFIX_DIR:-$TMP}/${name}" "$predicate" fake_reader >/dev/null 2>&1 || rc=$?
  local reads
  reads="$(cat "${TMP}/calls" 2>/dev/null || echo 0)"
  [[ "$rc" == "$want_rc" ]] || fail "$name: rc=$rc, expected $want_rc"
  [[ "$reads" == "$want_reads" ]] || fail "$name: $reads reads, expected $want_reads"
  if [[ "$want_rc" != 2 ]]; then
    [[ "$(grep -c ' read ' "${TMP}/${name}.settle.log")" == "$want_reads" ]] \
      || fail "$name: settle log does not have one line per read"
  fi
  if [[ "$want_rc" == 0 ]]; then
    [[ -f "${TMP}/${name}.txt" && -s "${TMP}/${name}.txt" ]] || fail "$name: no settled output"
  elif [[ "$want_rc" == 1 ]]; then
    [[ ! -e "${TMP}/${name}.txt" ]] || fail "$name: settled output written on failure"
  fi
  echo "ok: $name"
}

# --- stability (no target version) ---
# Stable from the first read: 1 read + 2 unchanged confirming reads.
run_case stable 0 3 20 2 true "a#0" "a#0" "a#0"
# Still changing after --wait, then stable.
run_case settles-late 0 5 20 2 true "old#0" "mixed#0" "new#0" "new#0" "new#0"
# Never the same twice in a row: fails after all tries.
run_case never 1 6 6 2 true "a#0" "b#0" "a#0" "b#0" "a#0" "b#0"
# One unchanged confirm is not enough when two are required.
run_case one-confirm-short 1 4 4 2 true "a#0" "a#0" "b#0" "b#0"
# A failed read resets the run, even if the state reads the same around it.
run_case failed-read-resets 0 6 20 2 true "a#0" "a#0" "a#1" "a#0" "a#0" "a#0"
# A read that keeps failing never passes, even with the same output.
run_case always-failing 1 5 5 2 true "a#1"
# --host-settle-tries 0: a single read, as before this check existed.
run_case single-read 0 1 0 2 true "a#0"
run_case single-read-failed 1 1 0 2 true "a#1"

# --- the target version on the exact upgraded set (hosts_at_expected_version) ---
A=11111111-1111-1111-1111-111111111111
B=22222222-2222-2222-2222-222222222222
C=33333333-3333-3333-3333-333333333333
HOST_TARGETS_FILE="${TMP}/targets"
printf '%s\n' "$A" "$B" >"$HOST_TARGETS_FILE"
HOST_EXPECT_VERSION=v2
# Every host stays on the OLD version: stable, but never the target.
run_case old-stable 1 6 6 2 hosts_at_expected_version "$A|h1|v1|s;$B|h2|v1|s#0"
# A partly upgraded fleet that holds still: never passes.
run_case partial-stable 1 6 6 2 hosts_at_expected_version "$A|h1|v2|s;$B|h2|v1|s#0"
# Delayed convergence: old, partial, then both at v2 and confirmed.
run_case converges 0 6 20 2 hosts_at_expected_version \
  "$A|h1|v1|s;$B|h2|v1|s#0" "$A|h1|v2|s;$B|h2|v1|s#0" "$A|h1|v2|s;$B|h2|v1|s#0" \
  "$A|h1|v2|s;$B|h2|v2|s#0" "$A|h1|v2|s;$B|h2|v2|s#0" "$A|h1|v2|s;$B|h2|v2|s#0"
# A targeted host missing from the read (e.g. it went away) never passes.
run_case target-missing 1 4 4 2 hosts_at_expected_version "$A|h1|v2|s#0"
# A host that was not targeted does not count.
run_case extra-host 1 4 4 2 hosts_at_expected_version "$A|h1|v2|s;$B|h2|v2|s;$C|h3|v2|s#0"
run_case other-host 1 4 4 2 hosts_at_expected_version "$A|h1|v2|s;$C|h3|v2|s#0"
# The same host twice is not two hosts.
run_case duplicate-host 1 4 4 2 hosts_at_expected_version "$A|h1|v2|s;$A|h1|v2|s#0"
# No rows at all.
run_case no-rows 1 4 4 2 hosts_at_expected_version "@none#0"
run_case blank-row 1 4 4 2 hosts_at_expected_version "#0"
# A version that merely starts with the target does not match it.
run_case prefix-version 1 4 4 2 hosts_at_expected_version "$A|h1|v2-old|s;$B|h2|v2|s#0"
# The single read also has to be at the target.
run_case single-read-old 1 1 0 2 hosts_at_expected_version "$A|h1|v1|s;$B|h2|v2|s#0"
# No target version, or no target set: never passes.
HOST_EXPECT_VERSION=""
# (rows with an empty version too: "" must not match an empty target)
run_case no-version 1 3 3 2 hosts_at_expected_version "$A|h1||s;$B|h2||s#0"
HOST_EXPECT_VERSION=v2
: >"$HOST_TARGETS_FILE"
run_case no-targets 1 3 3 2 hosts_at_expected_version "$A|h1|v2|s;$B|h2|v2|s#0"

# --- upgrade_targets: the upgraded set comes from the upgrade's own output ---
# targets_case <name> <expect rc> <expect ids or -> <json>
targets_case() {
  local name="$1" want_rc="$2" want="$3" rc=0 got
  printf '%s' "$4" >"${TMP}/${name}.json"
  got="$(upgrade_targets "${TMP}/${name}.json" 2>/dev/null)" || rc=$?
  if [[ "$want_rc" == 0 ]]; then
    [[ "$rc" == 0 ]] || fail "targets $name: rc=$rc, expected 0"
    [[ "$got" == "$want" ]] || fail "targets $name: got '$got', expected '$want'"
  else
    [[ "$rc" != 0 ]] || fail "targets $name: rc=0, expected a failure"
  fi
  echo "ok: targets $name"
}
targets_case many 0 "$A"$'\n'"$B" \
  '{"ok":true,"data":{"status":"succeeded","count":2,"hosts":[{"host_id":"'"$B"'","status":"succeeded"},{"host_id":"'"$A"'","status":"succeeded"}]}}'
targets_case one 0 "$A" '{"ok":true,"data":{"host_id":"'"$A"'","status":"succeeded"}}'
targets_case skipped 1 - '{"ok":true,"data":{"status":"skipped","hosts":[]}}'
targets_case not-ok 1 - '{"ok":false,"data":{"host_id":"'"$A"'","status":"succeeded"}}'
targets_case host-failed 1 - \
  '{"ok":true,"data":{"hosts":[{"host_id":"'"$A"'","status":"succeeded"},{"host_id":"'"$B"'","status":"failed"}]}}'
targets_case bad-id 1 - '{"ok":true,"data":{"hosts":[{"host_id":"x; DROP","status":"succeeded"}]}}'
targets_case duplicate 1 - \
  '{"ok":true,"data":{"hosts":[{"host_id":"'"$A"'","status":"succeeded"},{"host_id":"'"$A"'","status":"succeeded"}]}}'
targets_case not-json 1 - 'progress line
{"ok":true}'

# --- read_project_host_software reads exactly the target ids ---
# remote_psql is replaced by a stub that records the SQL it was given.
remote_psql() { cat >"${TMP}/sql"; echo called >"${TMP}/psql-called"; }
printf '%s\n' "$A" "$B" >"$HOST_TARGETS_FILE"
read_project_host_software >/dev/null || fail "reader: rc for good ids"
grep -qF "IN ('${A}','${B}')" "${TMP}/sql" || fail "reader: SQL does not name exactly the target ids"
grep -q 'deleted' "${TMP}/sql" && fail "reader: SQL filters on deleted (a targeted host could drop out)"
rm -f "${TMP}/psql-called"
printf '%s\n' "$A" "x') OR true --" >"$HOST_TARGETS_FILE"
rc=0; read_project_host_software >/dev/null 2>&1 || rc=$?
[[ "$rc" != 0 && ! -e "${TMP}/psql-called" ]] || fail "reader: a non-uuid target line reached psql"
: >"$HOST_TARGETS_FILE"
rc=0; read_project_host_software >/dev/null 2>&1 || rc=$?
[[ "$rc" != 0 && ! -e "${TMP}/psql-called" ]] || fail "reader: an empty target set reached psql"
echo "ok: reader target ids"

# --- a host upgrade without --expect-host-version is refused up front ---
rc=0
err="$(bash "${SCRIPT_DIR}/upgrade-bay-release.sh" --remote bay.example --api https://bay.example \
  --bundle-url https://bundles.example/b.tar.xz --admin-email a@b.example 2>&1)" || rc=$?
[[ "$rc" != 0 && "$err" == *"--expect-host-version"* ]] || fail "missing --expect-host-version was not refused (rc=$rc)"
echo "ok: version required"

# --- its own evidence must be written (rc 2) ---
mkdir "${TMP}/ro"
chmod a-w "${TMP}/ro"
# The read file itself cannot be written: no read happens, rc 2.
PREFIX_DIR="${TMP}/ro" run_case log-unwritable 2 0 20 2 true "a#0"
# The settle log cannot be appended (a read-only file): rc 2 after one read.
: >"${TMP}/log-ro.settle.log"
chmod a-w "${TMP}/log-ro.settle.log"
run_case log-ro 2 1 20 2 true "a#0"
# The settled copy cannot be written (a read-only directory in its place).
mkdir "${TMP}/copy-fails.txt"
chmod a-w "${TMP}/copy-fails.txt"
run_case copy-fails 2 3 20 2 true "a#0"

# --- ssh: non-interactive with a bounded connect by default ---
printf '%s\n' "${SSH_OPTS[@]}" | grep -qx 'BatchMode=yes' || fail "SSH_OPTS lacks BatchMode=yes"
printf '%s\n' "${SSH_OPTS[@]}" | grep -qx 'ConnectTimeout=30' || fail "SSH_OPTS lacks ConnectTimeout=30"
override="$(BAY_UPGRADE_SSH_OPTS="-o ConnectTimeout=5" bash -c \
  'source "$1"; printf "%s " "${SSH_OPTS[@]}"' _ "${SCRIPT_DIR}/upgrade-bay-release.sh")"
[[ "$override" == "-o ConnectTimeout=5 " ]] || fail "BAY_UPGRADE_SSH_OPTS override: got '$override'"
echo "ok: ssh options"

echo "PASS upgrade-bay-release-settle.test.sh"
