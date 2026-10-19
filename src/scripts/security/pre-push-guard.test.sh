#!/usr/bin/env bash
# Self-contained test of pre-push-guard.sh and install-hooks.sh.  Everything
# happens in a temporary directory, with local bare repos standing in for the
# public and private GitHub repos: no network, nothing pushed anywhere, and no
# refs of the calling repository are touched.  Exits nonzero on any failure.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
H=$here/pre-push-guard.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_NOSYSTEM=1 HOME=$T GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export COCALC_PUBLIC_URL=$T/pub.git COCALC_PRIVATE_URL=$T/priv.git
Z=0000000000000000000000000000000000000000
pass=0
fail=0

git init -q --bare "$T/pub.git"
git init -q --bare "$T/priv.git"
git init -q "$T/work"
cd "$T/work" || exit 1
git config cocalc.privateUrl "$T/priv.git"
commit() { git commit -q --allow-empty -m "$1" && git rev-parse HEAD; }
C0=$(commit base)
git push -q "$T/pub.git" "$C0:refs/heads/main"
git push -q "$T/priv.git" "$C0:refs/heads/main"
PRIV=$(commit "private fix")                       # only on a private-repo branch
git push -q "$T/priv.git" "$PRIV:refs/heads/security/topic"
git reset -q --hard "$C0"
PUBFEAT=$(commit "already public on a feature branch") # public and private
git push -q "$T/pub.git" "$PUBFEAT:refs/heads/feature/x"
git push -q "$T/priv.git" "$PUBFEAT:refs/heads/security/topic2"
git reset -q --hard "$C0"
LOCAL=$(commit "unpushed local private work")
git branch -q security/local "$LOCAL"
git branch -q neutral "$LOCAL"
git reset -q --hard "$C0"

check() { # <expect> <desc> <url> <local_ref> <sha> <remote_ref> [env...]
  local expect=$1 desc=$2 url=$3 line="$4 $5 $6 $Z" rc
  shift 6
  printf '%s\n' "$line" | env "$@" bash "$H" origin "$url" >"$T/out" 2>&1
  rc=$?
  if [ "$rc" = "$expect" ]; then
    pass=$((pass + 1))
    echo "ok    $desc"
  else
    fail=$((fail + 1))
    echo "FAIL  $desc (rc=$rc, expected $expect)"
    sed 's/^/      /' "$T/out" | head -4
  fi
}

for url in "$T/pub.git" git@github.com:sagemathinc/cocalc-ai.git ssh://git@github.com:22/sagemathinc/cocalc-ai.git \
  https://GitHub.com/sagemathinc/cocalc-ai.git git@github.com:sagemathinc/cocalc-ai-doc.git \
  git@github.com:someone/cocalc-ai.git https://gitlab.com/x/y.git /tmp/elsewhere.git; do
  check 1 "private branch name refused -> $url" "$url" refs/heads/main "$C0" refs/heads/security/topic
done
check 1 "private source branch name refused" "$T/pub.git" refs/heads/security/local "$LOCAL" refs/heads/fix/innocent
# Trust is by exact URL (configured) or a supported GitHub form (official).
git config --add cocalc.privateUrl "ssh://alice@example.test:2222/team/repo.git"
git config --add cocalc.privateUrl "$T/private-repository.git"
for url in "ssh://bob@example.test:3333/team/repo.git" "$T/private-repository" \
  "evil://github.com/sagemathinc/cocalc-ai-private.git" "ssh://git@github.com:2222/sagemathinc/cocalc-ai-private.git" \
  "ssh://mallory@github.com/sagemathinc/cocalc-ai-private.git" "git@github.com:sagemathinc/cocalc-ai-private.git.evil"; do
  check 1 "look-alike of a private URL is not trusted: $url" "$url" refs/heads/security/local "$LOCAL" refs/heads/security/local
done
check 0 "configured private URL, exact match" "ssh://alice@example.test:2222/team/repo.git" refs/heads/security/local "$LOCAL" refs/heads/security/local
git config --unset-all cocalc.privateUrl
git config cocalc.privateUrl "$T/priv.git"
for url in git@github.com:SageMathInc/Cocalc-AI-Private.git https://github.com/sagemathinc/cocalc-ai-private/ \
  ssh://git@github.com:22/sagemathinc/cocalc-ai-private; do
  check 0 "supported GitHub form of the private repo: $url" "$url" refs/heads/security/local "$LOCAL" refs/heads/security/local
done
for url in "$T/priv.git" git@github.com:sagemathinc/cocalc-ai-private.git \
  https://GitHub.com/SageMathInc/cocalc-ai-ghsa-abcd-1234-wxyz \
  ssh://git@ssh.github.com:443/sagemathinc/cocalc-ai-content-security.git; do
  check 0 "private destination allowed: $url" "$url" refs/heads/security/local "$LOCAL" refs/heads/security/local
done
check 1 "private-repo commit under neutral names" "$T/pub.git" refs/heads/x "$PRIV" refs/heads/fix/innocent
check 1 "private-repo commit to the public cocalc-ai-doc repo" git@github.com:sagemathinc/cocalc-ai-doc.git refs/heads/x "$PRIV" refs/heads/fix/innocent
check 1 "unpushed local private-branch commit via a neutral branch" "$T/pub.git" refs/heads/neutral "$LOCAL" refs/heads/fix/innocent
check 0 "commit already public on a non-main branch" "$T/pub.git" refs/heads/x "$PUBFEAT" refs/heads/fix/ok
check 0 "public commit" "$T/pub.git" refs/heads/x "$C0" refs/heads/fix/ok
check 0 "deleting a remote branch" "$T/pub.git" "(delete)" "$Z" refs/heads/fix/old
check 0 "COCALC_DISCLOSE override" "$T/pub.git" refs/heads/x "$PRIV" refs/heads/fix/innocent COCALC_DISCLOSE=1

# An additional private remote whose tracking ref is stale: the secret commit
# reached the local repo only through a raw-URL fetch onto a neutral branch.
git init -q --bare "$T/extra.git"
git push -q "$T/extra.git" "$C0:refs/heads/security/topic"
git remote add extra "$T/extra.git"
git config --add cocalc.privateUrl "$T/extra.git"
git fetch -q extra
SECRET=$(commit "secret on the extra private repo")
git push -q "$T/extra.git" "$SECRET:refs/heads/security/topic"
git reset -q --hard "$C0"
git update-ref -d "refs/remotes/extra/security/topic" && git update-ref "refs/remotes/extra/security/topic" "$C0" # stale
git fetch -q "$T/extra.git" refs/heads/security/topic && git branch -q neutral2 FETCH_HEAD
check 1 "commit on an additional private remote with a stale tracking ref" "$T/pub.git" refs/heads/neutral2 "$SECRET" refs/heads/fix/innocent
fh=$(git rev-parse FETCH_HEAD)
check 0 "public commit (FETCH_HEAD check)" "$T/pub.git" refs/heads/x "$C0" refs/heads/fix/ok
[ "$(git rev-parse FETCH_HEAD)" = "$fh" ] && { pass=$((pass + 1)); echo "ok    guard leaves FETCH_HEAD alone"; } || { fail=$((fail + 1)); echo "FAIL  guard changed FETCH_HEAD"; }
# Two private URLs that a lossy key would conflate: a/b.git and a_b.git.
mkdir -p "$T/a" && git init -q --bare "$T/a/b.git" && git init -q --bare "$T/a_b.git"
git push -q "$T/a/b.git" "$C0:refs/heads/main"
SECRET2=$(commit "secret only on a_b")
git push -q "$T/a_b.git" "$SECRET2:refs/heads/security/topic"
git reset -q --hard "$C0"
git config --add cocalc.privateUrl "$T/a/b.git"
git config --add cocalc.privateUrl "$T/a_b.git"
git fetch -q "$T/a_b.git" refs/heads/security/topic && git branch -q neutral3 FETCH_HEAD
check 1 "secret on the second of two similar private URLs" "$T/pub.git" refs/heads/neutral3 "$SECRET2" refs/heads/fix/innocent
git branch -q -D neutral3
git config --add cocalc.privateUrl "$T/unreachable.git"
check 1 "fail closed: an additional private repo cannot be fetched" "$T/pub.git" refs/heads/x "$C0" refs/heads/fix/ok
git config --unset-all cocalc.privateUrl
git remote remove extra
git branch -q -D neutral2
git config cocalc.privateUrl "$T/priv.git"

# Fail closed: only the guard's cached private refs mark this clone as having
# private work (no private remote, no private-named branch); private repo down.
git branch -q -D security/local neutral
git config --unset cocalc.privateUrl
check 1 "fail closed: private repo unreachable, cached private refs" "$T/pub.git" refs/heads/x "$C0" refs/heads/fix/ok COCALC_PRIVATE_URL=$T/missing.git
# An unrelated clone with no private work is not blocked by the outage.
git init -q "$T/outsider" && cd "$T/outsider" && git commit -q --allow-empty -m o
check 0 "clone without private work: private repo unreachable" "$T/pub.git" refs/heads/x "$(git rev-parse HEAD)" refs/heads/fix/ok COCALC_PRIVATE_URL=$T/missing.git

# Deleting an accidentally pushed private branch must work.
check 0 "deleting a private-named remote branch" "$T/pub.git" "(delete)" "$Z" refs/heads/security/accidental

# A configured private source that reports "repository not found" (GitHub
# says that for inaccessible repos too) fails closed.
mkdir -p "$T/bin"
printf '#!/bin/sh\necho "fatal: repository not found" >&2\nexit 128\n' >"$T/bin/git-remote-missing"
chmod +x "$T/bin/git-remote-missing"
git init -q "$T/cfgonly" && cd "$T/cfgonly" && git commit -q --allow-empty -m maybe-private
git config cocalc.privateUrl "missing::repo"
check 1 "fail closed: private source says 'not found'" "$T/pub.git" refs/heads/x "$(git rev-parse HEAD)" refs/heads/fix/ok PATH="$T/bin:$PATH"
# Config alone marks private work (fresh clone, no cached guard refs): every
# private fetch fails -> refuse.
git init -q "$T/cfgonly2" && cd "$T/cfgonly2" && git commit -q --allow-empty -m maybe-private2
git config cocalc.privateUrl "$T/missing-too.git"
check 1 "fail closed: only cocalc.privateUrl configured, all private fetches fail" "$T/pub.git" refs/heads/x "$(git rev-parse HEAD)" refs/heads/fix/ok COCALC_PRIVATE_URL=$T/missing.git

# Retiring the remote of a deleted private repo keeps its commits private.
git init -q --bare "$T/old.git"
git init -q "$T/retire" && cd "$T/retire" || exit 1
git commit -q --allow-empty -m base2 && git push -q "$T/pub.git" HEAD:refs/heads/base2
OLD=$(commit "secret on a later-deleted advisory fork")
git push -q "$T/old.git" "$OLD:refs/heads/main"
git reset -q --hard HEAD~1
git remote add old "$T/old.git" && git fetch -q old
git config cocalc.privateUrl "$T/old.git" # stand-in for the GitHub allowlist
git config --add cocalc.privateUrl "$T/old.git" # duplicate value
git branch -q neutral4 "$OLD"
rm -rf "$T/old.git"
check 1 "deleted private repo still configured: fail closed" "$T/pub.git" refs/heads/x "$(git rev-parse HEAD)" refs/heads/fix/ok
bash "$here/private-fix.sh" retire-remote old >/dev/null
rc=$?
[ $rc = 0 ] && ! git remote | grep -qx old && { pass=$((pass + 1)); echo "ok    retire-remote succeeds and removes the remote (duplicate config values)"; } || { fail=$((fail + 1)); echo "FAIL  retire-remote rc=$rc or remote left behind"; }
[ -z "$(git config --get-all cocalc.privateUrl)" ] && { pass=$((pass + 1)); echo "ok    retire-remote removes the matching cocalc.privateUrl"; } || { fail=$((fail + 1)); echo "FAIL  retire-remote left cocalc.privateUrl"; }
check 1 "after retire-remote: its commit is still private" "$T/pub.git" refs/heads/neutral4 "$OLD" refs/heads/fix/innocent
check 0 "after retire-remote: public commits push normally" "$T/pub.git" refs/heads/x "$(git rev-parse HEAD)" refs/heads/fix/ok
# retire-remote refuses non-private remotes and remotes with nothing to keep.
git remote add pubremote "$T/pub.git"
bash "$here/private-fix.sh" retire-remote pubremote >/dev/null 2>&1 && { fail=$((fail + 1)); echo "FAIL  retired a non-private remote"; } || { pass=$((pass + 1)); echo "ok    retire-remote refuses a non-private remote"; }
git init -q --bare "$T/empty.git" && git remote add empty "$T/empty.git" && git config --add cocalc.privateUrl "$T/empty.git"
bash "$here/private-fix.sh" retire-remote empty >/dev/null 2>&1 && { fail=$((fail + 1)); echo "FAIL  retired a remote with no refs"; } || { pass=$((pass + 1)); echo "ok    retire-remote refuses a remote with no refs to keep"; }
git remote | grep -qx empty && { pass=$((pass + 1)); echo "ok    the refused remote is still configured"; } || { fail=$((fail + 1)); echo "FAIL  refused remote was removed"; }
git remote remove empty; git remote remove pubremote; git config --unset-all cocalc.privateUrl

# Local paths are case-sensitive: Private.git is private, private.git is not.
git init -q --bare "$T/Private.git" && git init -q --bare "$T/private.git"
git push -q "$T/private.git" "$(git rev-parse HEAD):refs/heads/main"
CASESECRET=$(commit "secret in Private.git")
git push -q "$T/Private.git" "$CASESECRET:refs/heads/security/topic"
git reset -q --hard HEAD~1
git config cocalc.privateUrl "$T/Private.git"
git branch -q neutral5 "$CASESECRET"
check 1 "case-distinct local path is not treated as the private repo" "$T/private.git" refs/heads/neutral5 "$CASESECRET" refs/heads/fix/innocent

# Deleting or force-pushing a private branch early does not erase the evidence.
check 1 "private commit (first run caches it)" "$T/pub.git" refs/heads/neutral5 "$CASESECRET" refs/heads/fix/innocent
git push -q "$T/Private.git" :refs/heads/security/topic
check 1 "after the private branch was deleted" "$T/pub.git" refs/heads/neutral5 "$CASESECRET" refs/heads/fix/innocent
FORCED=$(commit "secret 2")
git push -q "$T/Private.git" "$FORCED:refs/heads/security/t2"
git push -q "$T/Private.git" "$FORCED:refs/heads/security/t2-same-tip" # two branches, one tip
git reset -q --hard HEAD~1
git branch -q neutral6 "$FORCED"
check 1 "private commit before a force-push" "$T/pub.git" refs/heads/neutral6 "$FORCED" refs/heads/fix/innocent
git push -q -f "$T/Private.git" "$(git rev-parse HEAD):refs/heads/security/t2"
git push -q -f "$T/Private.git" "$(git rev-parse HEAD):refs/heads/security/t2-same-tip"
check 1 "after the private branch was force-pushed away" "$T/pub.git" refs/heads/neutral6 "$FORCED" refs/heads/fix/innocent
[ -n "$(git for-each-ref "refs/cocalc-guard/seen/$FORCED")" ] && { pass=$((pass + 1)); echo "ok    tip shared by two private branches is archived"; } || { fail=$((fail + 1)); echo "FAIL  shared tip not archived"; }

# install-hooks.sh
inst() { # <expect> <desc>
  local rc
  bash "$here/install-hooks.sh" >"$T/out" 2>&1
  rc=$?
  if [ "$rc" = "$1" ]; then pass=$((pass + 1)); echo "ok    $2"; else
    fail=$((fail + 1)); echo "FAIL  $2 (rc=$rc)"; sed 's/^/      /' "$T/out" | head -3; fi
}
git init -q "$T/inst" && cd "$T/inst" || exit 1
inst 0 "install into a fresh clone"
inst 0 "re-install over its own hook"
printf '#!/bin/sh\n# my wrapper\nexec %s "$@"\n' "$H" >.git/hooks/pre-push
inst 1 "refuses to overwrite a wrapper hook that calls the guard"
grep -q "my wrapper" .git/hooks/pre-push && { pass=$((pass + 1)); echo "ok    wrapper left intact"; } || { fail=$((fail + 1)); echo "FAIL  wrapper was modified"; }
rm .git/hooks/pre-push && git config core.hooksPath .custom-hooks
inst 1 "refuses when core.hooksPath is set"

echo "pass=$pass fail=$fail"
[ $fail = 0 ]
