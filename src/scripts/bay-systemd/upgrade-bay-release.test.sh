#!/usr/bin/env bash
set -euo pipefail

# The deploy preflight fails closed: only the bay's own answer (no fence, the
# lock free) lets a deploy go on; an ssh failure never reads as either. And
# the check runs before anything else touches the bay, both at the start of
# the run and again right before staging.

# Each case runs the script in its own bash, since its checks exit.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/upgrade-bay-release.sh"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

FENCE_PROBE="test -e /etc/cocalc/bay-restore-fence"
LOCK_PROBE="sudo flock -n -E 75 /etc/cocalc/bay-deploy.lock true"

# ssh stub: answers the fence probe with $STUB_FENCE_RC and the lock probe
# with $STUB_LOCK_RC, and fails anything else with 99. It logs every remote
# command, one per line, in order.
mkdir -p "${TMP_ROOT}/bin"
cat > "${TMP_ROOT}/bin/ssh" <<EOF
#!/usr/bin/env bash
shift # the ssh target
printf '%s\n' "\$*" >> "\$STUB_LOG"
case "\$*" in
  "${FENCE_PROBE}") exit "\$STUB_FENCE_RC" ;;
  "${LOCK_PROBE}") exit "\$STUB_LOCK_RC" ;;
  *) exit 99 ;;
esac
EOF
cat > "${TMP_ROOT}/bin/scp" <<'EOF'
#!/usr/bin/env bash
echo "scp $*" >> "$STUB_LOG"
exit 99
EOF
# The CLI and node are never run: main stops at the bay first, or at the
# psql stub. main only requires that they exist.
printf '#!/usr/bin/env bash\nexit 99\n' > "${TMP_ROOT}/bin/cocalc-cli"
cp "${TMP_ROOT}/bin/cocalc-cli" "${TMP_ROOT}/bin/node"
chmod +x "${TMP_ROOT}/bin/ssh" "${TMP_ROOT}/bin/scp" "${TMP_ROOT}/bin/cocalc-cli" "${TMP_ROOT}/bin/node"
export PATH="${TMP_ROOT}/bin:${PATH}"
export STUB_LOG="${TMP_ROOT}/ssh.log"
ERR="${TMP_ROOT}/stderr"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# run_case MODE FENCE_RC LOCK_RC: sets RC; the remote commands are in
# $STUB_LOG, stderr in $ERR.
#   probe: check_remote_deployable alone
#   stage: stage_release (its own call site)
#   main:  the whole script, run by path as operators run it
run_case() {
  local mode="$1"
  : > "$STUB_LOG"
  RC=0
  export STUB_FENCE_RC="$2" STUB_LOCK_RC="$3"
  case "$mode" in
    probe)
      bash -c 'source "$1"; REMOTE=bay.example; check_remote_deployable' _ "$SCRIPT" 2> "$ERR" || RC=$?
      ;;
    stage)
      bash -c 'source "$1"; REMOTE=bay.example; BUNDLE_URL=https://bundles.example/bay-runtime.tar.xz
               REPORT_DIR="$2"; stage_release' _ "$SCRIPT" "${TMP_ROOT}/report-stage" > /dev/null 2> "$ERR" || RC=$?
      ;;
    main)
      "$SCRIPT" --remote bay.example --api https://bay.example \
        --bundle-url https://bundles.example/bay-runtime.tar.xz \
        --admin-email admin@bay.example --cli "${TMP_ROOT}/bin/cocalc-cli" \
        --report-dir "${TMP_ROOT}/report-main" \
        > /dev/null 2> "$ERR" || RC=$?
      ;;
  esac
  LABEL="${mode}: fence rc=${2}, lock rc=${3}"
}

expect_rc() {
  [[ "$RC" == "$1" ]] || fail "${LABEL}: exit ${RC}, want ${1} ($(cat "$ERR"))"
}

expect_message() {
  if [[ -n "$1" ]]; then
    grep -qF -- "$1" "$ERR" || fail "${LABEL}: stderr lacks '${1}': $(cat "$ERR")"
  else
    [[ ! -s "$ERR" ]] || fail "${LABEL}: unexpected stderr: $(cat "$ERR")"
  fi
}

# expect_remote_commands CMD...: the bay saw exactly these commands, in order.
expect_remote_commands() {
  local want
  want="$(printf '%s\n' "$@")"
  [[ "$(cat "$STUB_LOG")" == "$want" ]] \
    || fail "${LABEL}: remote commands were:"$'\n'"$(cat "$STUB_LOG")"$'\n'"want:"$'\n'"${want}"
}

ok() {
  echo "ok - ${LABEL}: exit ${RC}"
}

# Sourcing the script runs nothing.
[[ -z "$(bash -c 'source "$1"' _ "$SCRIPT" 2>&1)" ]] || fail "sourcing upgrade-bay-release.sh ran something"

# --- check_remote_deployable

# Unchanged: no fence and a free lock deploy; a fence or a held lock refuses.
run_case probe 1 0; expect_rc 0; expect_message ""; expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok
run_case probe 0 0; expect_rc 1
expect_message "bay.example is fenced for a restore (/etc/cocalc/bay-restore-fence)"
expect_remote_commands "$FENCE_PROBE"; ok
run_case probe 1 75; expect_rc 1
expect_message "a bay restore or another deploy is running on bay.example (it holds /etc/cocalc/bay-deploy.lock)"
expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok

# ssh failures fail closed, each naming its cause.
run_case probe 255 0; expect_rc 1
expect_message "could not check bay.example for a restore fence: ssh failed (rc=255); not deploying"
expect_remote_commands "$FENCE_PROBE"; ok
run_case probe 1 255; expect_rc 1
expect_message "could not check bay.example's deploy lock: ssh failed (rc=255); not deploying"
expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok

# Any other answer is unknown, never "no fence" or "lock held".
for rc in 2 127; do
  run_case probe "$rc" 0; expect_rc 1
  expect_message "could not check bay.example for a restore fence: unknown (ssh rc=${rc}); not deploying"
  expect_remote_commands "$FENCE_PROBE"; ok
done
run_case probe 1 1; expect_rc 1
expect_message "could not check bay.example's deploy lock: unknown (ssh rc=1); not deploying"
expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok

# --- stage_release: the check comes before its first remote change

run_case stage 255 0; expect_rc 1
expect_message "could not check bay.example for a restore fence: ssh failed (rc=255); not deploying"
expect_remote_commands "$FENCE_PROBE"; ok
run_case stage 0 0; expect_rc 1
expect_message "bay.example is fenced for a restore"
expect_remote_commands "$FENCE_PROBE"; ok
run_case stage 1 255; expect_rc 1
expect_message "could not check bay.example's deploy lock: ssh failed (rc=255); not deploying"
expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok
# Allowed: the probes, then the work directory (the stub fails it, and the
# EXIT trap removes the directory).
run_case stage 1 0; expect_rc 99
[[ "$(sed -n 1p "$STUB_LOG")" == "$FENCE_PROBE" && "$(sed -n 2p "$STUB_LOG")" == "$LOCK_PROBE" ]] \
  || fail "${LABEL}: the probes were not the first remote commands: $(cat "$STUB_LOG")"
[[ "$(sed -n 3p "$STUB_LOG")" == "sudo rm -rf /tmp/cocalc-bay-upgrade-"*" && mkdir -p /tmp/cocalc-bay-upgrade-"*"/bay-systemd" ]] \
  || fail "${LABEL}: the third remote command was not the work directory: $(cat "$STUB_LOG")"
ok

# --- the whole run: nothing touches the bay before the check, not even the
# CLI-auth preflight's temporary login cookie (--admin-email)

run_case main 255 0; expect_rc 1
expect_message "could not check bay.example for a restore fence: ssh failed (rc=255); not deploying"
expect_remote_commands "$FENCE_PROBE"; ok
run_case main 0 0; expect_rc 1
expect_message "bay.example is fenced for a restore"
expect_remote_commands "$FENCE_PROBE"; ok
run_case main 1 75; expect_rc 1
expect_message "a bay restore or another deploy is running on bay.example"
expect_remote_commands "$FENCE_PROBE" "$LOCK_PROBE"; ok
# Allowed: the probes, then the preflight's admin lookup (psql over ssh).
run_case main 1 0; expect_rc 99
[[ "$(sed -n 1p "$STUB_LOG")" == "$FENCE_PROBE" && "$(sed -n 2p "$STUB_LOG")" == "$LOCK_PROBE" ]] \
  || fail "${LABEL}: the probes were not the first remote commands: $(cat "$STUB_LOG")"
[[ "$(sed -n 3p "$STUB_LOG")" == "sudo runuser -u cocalc-bay -- "*"psql"* ]] \
  || fail "${LABEL}: the third remote command was not the preflight's psql: $(cat "$STUB_LOG")"
ok

# --- restart_section_failed

# expect_restart_failed RC WANT_RC [WANT_MESSAGE]
expect_restart_failed() {
  RC=0
  LABEL="restart section rc=${1}"
  bash -c 'source "$1"; REMOTE=bay.example; restart_section_failed "$2"' _ "$SCRIPT" "$1" 2> "$ERR" || RC=$?
  expect_rc "$2"; expect_message "${3:-}"; ok
}

expect_restart_failed 75 1 "a bay restore holds /etc/cocalc/bay-deploy.lock on bay.example; not restarting the bay"
expect_restart_failed 255 1 "the restart on bay.example ended with rc=255 (ssh failed, or the remote section exited 255)"
expect_restart_failed 3 3

echo "upgrade-bay-release preflight: all tests passed"
