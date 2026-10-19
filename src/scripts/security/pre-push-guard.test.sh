#!/usr/bin/env bash
# Manual test of pre-push-guard.sh: feeds it push lines directly, so nothing is
# pushed. Run inside a cocalc-ai clone
# that can fetch the private repo (it fetches from both repos).
H=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-push-guard.sh
Z=0000000000000000000000000000000000000000
pass=0; fail=0
t() { # <expect> <desc> <url> <local_ref> <sha> <remote_ref>
  local expect=$1 desc=$2 url=$3
  printf '%s %s %s %s\n' "$4" "$5" "$6" "$Z" | bash "$H" origin "$url" >/tmp/guard-out 2>&1
  local rc=$?
  if [ "$rc" = "$expect" ]; then pass=$((pass+1)); r=ok; else fail=$((fail+1)); r=FAIL; fi
  echo "$r rc=$rc expect=$expect  $desc"
  [ $r = FAIL ] && sed 's/^/     /' /tmp/guard-out | head -4
}
git fetch -q git@github.com:sagemathinc/cocalc-ai.git main && PUB=$(git rev-parse FETCH_HEAD)
git fetch -q git@github.com:sagemathinc/cocalc-ai-private.git refs/heads/security/content-origin-phase1 && PRIVC=$(git rev-parse FETCH_HEAD)
# a brand-new local commit on a private-named branch, never pushed anywhere
NEW=$(git commit-tree "$PUB^{tree}" -p "$PUB" -m "guard test: local private commit")
git branch -f security/guardtest "$NEW" >/dev/null
git branch -f guardtest-neutral "$NEW" >/dev/null

for url in git@github.com:sagemathinc/cocalc-ai.git ssh://git@github.com:22/sagemathinc/cocalc-ai.git \
  https://GitHub.com/sagemathinc/cocalc-ai.git git@github.com:someone/cocalc-ai.git \
  https://gitlab.com/x/y.git /tmp/some-bare.git; do
  t 1 "private branch name -> $url" "$url" refs/heads/main "$PUB" refs/heads/security/topic
done
for url in git@github.com:sagemathinc/cocalc-ai-private.git https://github.com/SageMathInc/cocalc-ai-private \
  ssh://git@ssh.github.com:443/sagemathinc/cocalc-ai-ghsa-x.git; do
  t 0 "private destination allowed: $url" "$url" refs/heads/security/guardtest "$NEW" refs/heads/security/guardtest
done
U=git@github.com:sagemathinc/cocalc-ai.git
t 1 "local security/* source -> neutral name (reviewer repro)" $U refs/heads/security/guardtest "$NEW" refs/heads/fix/innocent
t 1 "neutral local branch holding an unpushed private-branch commit" $U refs/heads/guardtest-neutral "$NEW" refs/heads/fix/innocent
t 1 "commit only on a private-repo branch" $U refs/heads/x "$PRIVC" refs/heads/fix/innocent
t 1 "same, to a fork" git@github.com:someone/cocalc-ai.git refs/heads/x "$PRIVC" refs/heads/fix/innocent
t 0 "current public main to a neutral branch (stale-origin case)" $U refs/heads/x "$PUB" refs/heads/fix/ok
t 0 "deleting a remote branch" $U "(delete)" "$Z" refs/heads/fix/old
printf 'refs/heads/x %s refs/heads/fix/innocent %s\n' "$PRIVC" "$Z" | COCALC_DISCLOSE=1 bash "$H" origin $U >/dev/null 2>&1 && { pass=$((pass+1)); echo "ok rc=0 expect=0  COCALC_DISCLOSE override"; } || { fail=$((fail+1)); echo "FAIL override"; }
# fail closed: unreachable private repo while the clone has private work
printf 'refs/heads/x %s refs/heads/fix/ok %s\n' "$PUB" "$Z" | COCALC_PRIVATE_URL=git@github.com:sagemathinc/does-not-exist-xyz.git bash "$H" origin $U >/tmp/guard-out 2>&1
rc=$?; [ $rc = 1 ] && { pass=$((pass+1)); echo "ok rc=1 expect=1  fail closed when the private fetch fails"; } || { fail=$((fail+1)); echo "FAIL fail-closed rc=$rc"; }
git branch -D security/guardtest guardtest-neutral >/dev/null
echo "pass=$pass fail=$fail"
