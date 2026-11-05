#!/usr/bin/env bash
set -euo pipefail

# The deploy preflight fails closed: only the bay's own answer (no fence, the
# lock free) lets a deploy go on; an ssh failure never reads as either.

# Each case sources the script in its own bash, since its checks exit.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ssh stub: answers the fence probe with $STUB_FENCE_RC and the lock probe
# with $STUB_LOCK_RC, logging each remote command; anything else is a failure.
mkdir -p "${TMP_ROOT}/bin"
cat > "${TMP_ROOT}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
shift # the ssh target
printf '%s\n' "$*" >> "$STUB_LOG"
case "$*" in
  "test -e /etc/cocalc/bay-restore-fence") exit "$STUB_FENCE_RC" ;;
  "sudo flock -n -E 75 /etc/cocalc/bay-deploy.lock true") exit "$STUB_LOCK_RC" ;;
  *) echo "unexpected remote command: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "${TMP_ROOT}/bin/ssh"
export PATH="${TMP_ROOT}/bin:${PATH}"
export STUB_LOG="${TMP_ROOT}/ssh.log"
REMOTE="bay.example"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# expect_preflight FENCE_RC LOCK_RC WANT_RC WANT_PROBES [WANT_MESSAGE]
expect_preflight() {
  local fence_rc="$1" lock_rc="$2" want_rc="$3" want_probes="$4" want_message="${5:-}"
  local rc=0 err="${TMP_ROOT}/stderr"
  : > "$STUB_LOG"
  STUB_FENCE_RC="$fence_rc" STUB_LOCK_RC="$lock_rc" \
    bash -c 'source "$1"; REMOTE="$2"; check_remote_deployable' _ \
    "${SCRIPT_DIR}/upgrade-bay-release.sh" "$REMOTE" 2> "$err" || rc=$?
  local label="fence rc=${fence_rc}, lock rc=${lock_rc}"
  [[ "$rc" == "$want_rc" ]] || fail "${label}: exit ${rc}, want ${want_rc} ($(cat "$err"))"
  local probes
  probes="$(wc -l < "$STUB_LOG" | tr -d ' ')"
  [[ "$probes" == "$want_probes" ]] || fail "${label}: ${probes} remote commands, want ${want_probes}"
  if [[ -n "$want_message" ]]; then
    grep -qF -- "$want_message" "$err" || fail "${label}: stderr lacks '${want_message}': $(cat "$err")"
  else
    [[ ! -s "$err" ]] || fail "${label}: unexpected stderr: $(cat "$err")"
  fi
  echo "ok - ${label}: exit ${rc}"
}

# Sourcing the script runs nothing.
[[ -z "$(bash -c 'source "$1"' _ "${SCRIPT_DIR}/upgrade-bay-release.sh" 2>&1)" ]] \
  || fail "sourcing upgrade-bay-release.sh ran something"

# Unchanged: no fence and a free lock deploy; a fence or a held lock refuses.
expect_preflight 1 0 0 2
expect_preflight 0 0 1 1 "bay.example is fenced for a restore (/etc/cocalc/bay-restore-fence)"
expect_preflight 1 75 1 2 "a bay restore or another deploy is running on bay.example (it holds /etc/cocalc/bay-deploy.lock)"

# ssh failures fail closed, each naming its cause.
expect_preflight 255 0 1 1 "could not check bay.example for a restore fence: ssh failed (rc=255); not deploying"
expect_preflight 1 255 1 2 "could not check bay.example's deploy lock: ssh failed (rc=255); not deploying"

# Any other answer is unknown, never "no fence" or "lock held".
expect_preflight 2 0 1 1 "could not check bay.example for a restore fence: unknown (ssh rc=2); not deploying"
expect_preflight 127 0 1 1 "could not check bay.example for a restore fence: unknown (ssh rc=127); not deploying"
expect_preflight 1 1 1 2 "could not check bay.example's deploy lock: unknown (ssh rc=1); not deploying"

# expect_restart_failed RC WANT_RC [WANT_MESSAGE]
expect_restart_failed() {
  local in_rc="$1" want_rc="$2" want_message="${3:-}"
  local rc=0 err="${TMP_ROOT}/stderr"
  bash -c 'source "$1"; REMOTE="$2"; restart_section_failed "$3"' _ \
    "${SCRIPT_DIR}/upgrade-bay-release.sh" "$REMOTE" "$in_rc" 2> "$err" || rc=$?
  [[ "$rc" == "$want_rc" ]] || fail "restart rc=${in_rc}: exit ${rc}, want ${want_rc}"
  if [[ -n "$want_message" ]]; then
    grep -qF -- "$want_message" "$err" || fail "restart rc=${in_rc}: stderr lacks '${want_message}': $(cat "$err")"
  else
    [[ ! -s "$err" ]] || fail "restart rc=${in_rc}: unexpected stderr: $(cat "$err")"
  fi
  echo "ok - restart section rc=${in_rc}: exit ${rc}"
}

expect_restart_failed 75 1 "a bay restore holds /etc/cocalc/bay-deploy.lock on bay.example; not restarting the bay"
expect_restart_failed 255 1 "the restart on bay.example ended with rc=255 (ssh failed, or the remote section exited 255)"
expect_restart_failed 3 3

echo "upgrade-bay-release preflight: all tests passed"
