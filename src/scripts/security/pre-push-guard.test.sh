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

# Deletion-only pushes need no analysis, even when private sources are down;
# a mixed push is still analyzed.
git init -q "$T/del" && cd "$T/del" && git commit -q --allow-empty -m d
git config cocalc.privateUrl "$T/missing-private.git"
check 0 "deletion-only push while private sources are down" "$T/pub.git" "(delete)" "$Z" refs/heads/security/accidental COCALC_PRIVATE_URL=$T/missing.git
printf '(delete) %s refs/heads/security/accidental %s\nrefs/heads/x %s refs/heads/fix/ok %s\n' "$Z" "$Z" "$(git rev-parse HEAD)" "$Z" |
  COCALC_PRIVATE_URL=$T/missing.git bash "$H" origin "$T/pub.git" >/dev/null 2>&1 &&
  { fail=$((fail + 1)); echo "FAIL  mixed deletion + push was not analyzed"; } || { pass=$((pass + 1)); echo "ok    mixed deletion + push is still analyzed (fails closed)"; }

# A remote with no URL: its private-named tracking branches are private.
git init -q "$T/nourl" && cd "$T/nourl" || exit 1
git fetch -q "$T/pub.git" main && git reset -q --hard FETCH_HEAD
NOURL_SECRET=$(commit "secret on a URL-less remote's tracking branch")
git reset -q --hard HEAD~1
git branch -q neutral "$NOURL_SECRET"
git config remote.nourl.fetch '+refs/heads/*:refs/remotes/nourl/*'
git update-ref refs/remotes/nourl/security/topic "$NOURL_SECRET"
check 1 "URL-less remote's security/* tracking ref (private repo down)" "$T/pub.git" refs/heads/neutral "$NOURL_SECRET" refs/heads/fix/innocent COCALC_PRIVATE_URL=$T/missing.git
check 1 "URL-less remote's security/* tracking ref (private repo up)" "$T/pub.git" refs/heads/neutral "$NOURL_SECRET" refs/heads/fix/innocent
git update-ref refs/remotes/nourl/feature/ordinary "$(git rev-parse HEAD)"
ORD=$(commit "ordinary new work") && git reset -q --hard HEAD~1
check 0 "URL-less remote does not block an ordinary push" "$T/pub.git" refs/heads/x "$ORD" refs/heads/fix/ok

# Rewritten private work: cherry-pick, rebase onto a newer base, squash.
git init -q --bare "$T/pub2.git" && git init -q --bare "$T/priv2.git"
git init -q "$T/rw" && cd "$T/rw" || exit 1
E2="COCALC_PUBLIC_URL=$T/pub2.git"
P2="COCALC_PRIVATE_URL=$T/priv2.git"
echo base >a && echo base >b && git add a b && git commit -q -m base && BASE2=$(git rev-parse HEAD)
git push -q "$T/pub2.git" HEAD:refs/heads/main && git push -q "$T/priv2.git" HEAD:refs/heads/main
echo fix >>a && git commit -q -am "private fix" && PFIX=$(git rev-parse HEAD)
echo more >>a && git commit -q -am "private fix, part 2" && PFIX2=$(git rev-parse HEAD)
git push -q "$T/priv2.git" HEAD:refs/heads/security/topic
git reset -q --hard "$BASE2"
git cherry-pick -n "$PFIX" && git commit -q -m "innocent-looking rewrite" && RW=$(git rev-parse HEAD)
check 1 "cherry-picked private commit (same tree)" "$T/pub2.git" refs/heads/main "$RW" refs/heads/main "$E2" "$P2"
git reset -q --hard "$BASE2"
git merge -q --squash "$PFIX2" >/dev/null && git commit -q -m "squashed" && SQ=$(git rev-parse HEAD)
check 1 "squashed private commits (same final tree)" "$T/pub2.git" refs/heads/main "$SQ" refs/heads/main "$E2" "$P2"
git reset -q --hard "$BASE2"
echo public-change >>b && git commit -q -am "public moves on" && git push -q "$T/pub2.git" HEAD:refs/heads/main
git cherry-pick -n "$PFIX" && git commit -q -m "rebased rewrite" && RB=$(git rev-parse HEAD)
check 1 "private commit rebased onto a newer public main (same patch-id)" "$T/pub2.git" refs/heads/main "$RB" refs/heads/main "$E2" "$P2"
git reset -q --hard HEAD~1
echo unrelated >c && git add c && git commit -q -m "unrelated work" && UN=$(git rev-parse HEAD)
check 0 "unrelated new commit is allowed" "$T/pub2.git" refs/heads/main "$UN" refs/heads/main "$E2" "$P2"
# Once the change is public under another commit id, rewrites of it are fine.
git push -q "$T/pub2.git" "$RW:refs/heads/disclosed"
check 0 "rewrite of private work already disclosed under another commit id" "$T/pub2.git" refs/heads/main "$RB" refs/heads/main "$E2" "$P2"

# Private-named local and tracking branches are archived when observed, so
# deleting them afterwards does not erase the evidence.
git init -q "$T/obs" && cd "$T/obs" || exit 1
git fetch -q "$T/pub.git" main && git reset -q --hard FETCH_HEAD && OBASE=$(git rev-parse HEAD)
OSECRET=$(commit "secret on a local private branch")
git branch -q security/local "$OSECRET" && git branch -q neutral "$OSECRET"
OTRACK=$(commit "secret on a URL-less remote's tracking branch")
git update-ref refs/remotes/nourl/security/t "$OTRACK" && git branch -q neutral2 "$OTRACK"
git reset -q --hard "$OBASE"
check 0 "observation run (public commit)" "$T/pub.git" refs/heads/x "$OBASE" refs/heads/fix/ok
git branch -q -D security/local
git update-ref -d refs/remotes/nourl/security/t
check 1 "local private branch deleted after observation" "$T/pub.git" refs/heads/neutral "$OSECRET" refs/heads/fix/innocent
check 1 "private-named tracking ref deleted after observation" "$T/pub.git" refs/heads/neutral2 "$OTRACK" refs/heads/fix/innocent

# Non-commit objects pushed directly (blob, tree, or a tag of one) are refused;
# an annotated tag of a commit is checked as that commit.
cd "$T/work" || exit 1
check 1 "blob pushed as a tag" "$T/pub.git" refs/tags/blob-leak "$(git rev-parse "$PRIV:"$(git ls-tree --name-only "$PRIV" | head -1) 2>/dev/null || git hash-object -w --stdin <<<TOP-SECRET)" refs/tags/blob-leak
check 1 "tree pushed as a tag" "$T/pub.git" refs/tags/tree-leak "$(git rev-parse "$PRIV^{tree}")" refs/tags/tree-leak
git tag -a -m "annotated, private" ann-private "$PRIV"
check 1 "annotated tag of a private commit" "$T/pub.git" refs/tags/ann-private "$(git rev-parse ann-private)" refs/tags/ann-private
git tag -a -m "annotated, public" ann-public "$C0"
check 0 "annotated tag of a public commit" "$T/pub.git" refs/tags/ann-public "$(git rev-parse ann-public)" refs/tags/ann-public
git tag -a -m "tag of a blob" ann-blob "$(git hash-object -w --stdin <<<TOP-SECRET)"
check 1 "annotated tag of a blob" "$T/pub.git" refs/tags/ann-blob "$(git rev-parse ann-blob)" refs/tags/ann-blob

# A remote whose name contains "/": its security/* tracking refs are private.
git init -q "$T/slash" && cd "$T/slash" || exit 1
git fetch -q "$T/pub.git" main && git reset -q --hard FETCH_HEAD
SL=$(commit "secret behind a remote named foo/bar") && git reset -q --hard HEAD~1
git config remote.foo/bar.url "$T/nowhere.git"
git config remote.foo/bar.fetch '+refs/heads/*:refs/remotes/foo/bar/*'
git update-ref refs/remotes/foo/bar/security/topic "$SL" && git branch -q neutral "$SL"
check 1 "security/* tracking ref of a remote named foo/bar" "$T/pub.git" refs/heads/neutral "$SL" refs/heads/fix/innocent
# ... but feature/security/topic on remote "fork", or branch "topic" on remote
# "foo/security", are not private names.
git branch -q -D neutral && git update-ref -d refs/remotes/foo/bar/security/topic
NOTPRIV=$(commit "ordinary work on public forks") && git reset -q --hard HEAD~1
git config remote.fork.url "$T/nowhere2.git"
git config remote.foo/security.url "$T/nowhere3.git"
git update-ref refs/remotes/fork/feature/security/topic "$NOTPRIV"
git update-ref refs/remotes/foo/security/topic "$NOTPRIV"
git branch -q neutral "$NOTPRIV"
check 0 "branch feature/security/topic on remote fork is not private" "$T/pub.git" refs/heads/neutral "$NOTPRIV" refs/heads/fix/ok

# A broken patch-id cache fails closed: a rebased private patch followed by an
# unrelated commit is only recognizable through the cache-backed patch-ids.
git init -q --bare "$T/pub5.git" && git init -q --bare "$T/priv5.git"
git init -q "$T/brk" && cd "$T/brk" || exit 1
E5="COCALC_PUBLIC_URL=$T/pub5.git"
P5="COCALC_PRIVATE_URL=$T/priv5.git"
echo base >a && echo base >b && git add a b && git commit -q -m base && B5=$(git rev-parse HEAD)
git push -q "$T/pub5.git" HEAD:refs/heads/main && git push -q "$T/priv5.git" HEAD:refs/heads/main
echo fix >>a && git commit -q -am "private fix" && PF5=$(git rev-parse HEAD) && git push -q "$T/priv5.git" HEAD:refs/heads/security/x
git reset -q --hard "$B5" && echo pub >>b && git commit -q -am "public moves on" && git push -q "$T/pub5.git" HEAD:refs/heads/main
git cherry-pick -n "$PF5" && git commit -q -m "rebased" && echo other >c && git add c && git commit -q -m "unrelated" && BR5=$(git rev-parse HEAD)
check 1 "rebased private patch + unrelated commit (cache OK)" "$T/pub5.git" refs/heads/main "$BR5" refs/heads/main "$E5" "$P5"
rm -f .git/cocalc-guard-patch-ids && mkdir .git/cocalc-guard-patch-ids
check 1 "same, with the patch-id cache broken (fail closed)" "$T/pub5.git" refs/heads/main "$BR5" refs/heads/main "$E5" "$P5"
rmdir .git/cocalc-guard-patch-ids

# A commit pushed to a private repo is recorded at that push, so deleting or
# force-pushing the private branch before any public check loses nothing.
git init -q --bare "$T/pub7.git" && git init -q --bare "$T/priv7.git"
git init -q "$T/unobs" && cd "$T/unobs" || exit 1
E7="COCALC_PUBLIC_URL=$T/pub7.git"
P7="COCALC_PRIVATE_URL=$T/priv7.git"
git config cocalc.privateUrl "$T/priv7.git"
B7=$(commit base7) && git push -q "$T/pub7.git" HEAD:refs/heads/main && git push -q "$T/priv7.git" HEAD:refs/heads/main
U7=$(commit "secret pushed only to private") && git branch -q security/topic "$U7" && git branch -q neutral "$U7"
git reset -q --hard "$B7"
check 0 "push to the private repo (records the commit)" "$T/priv7.git" refs/heads/security/topic "$U7" refs/heads/security/topic "$E7" "$P7"
git push -q "$T/priv7.git" "$U7:refs/heads/security/topic"
git push -q "$T/priv7.git" :refs/heads/security/topic
git branch -q -D security/topic
check 1 "private branch deleted before any public check" "$T/pub7.git" refs/heads/neutral "$U7" refs/heads/fix/innocent "$E7" "$P7"
U8=$(commit "second secret, force-pushed away") && git branch -q neutral8 "$U8" && git reset -q --hard "$B7"
check 0 "push to the private repo (records the commit)" "$T/priv7.git" refs/heads/security/t8 "$U8" refs/heads/security/t8 "$E7" "$P7"
git push -q "$T/priv7.git" "$U8:refs/heads/security/t8" && git push -q -f "$T/priv7.git" "$B7:refs/heads/security/t8"
check 1 "private branch force-pushed away before any public check" "$T/pub7.git" refs/heads/neutral8 "$U8" refs/heads/fix/innocent "$E7" "$P7"

# Several private commits squashed onto a newer public main: new tree and a
# combined patch-id (Codex/@review repro).
git init -q --bare "$T/pub4.git" && git init -q --bare "$T/priv4.git"
git init -q "$T/sq" && cd "$T/sq" || exit 1
E4="COCALC_PUBLIC_URL=$T/pub4.git"
P4="COCALC_PRIVATE_URL=$T/priv4.git"
echo base >a && echo base >b && git add a b && git commit -q -m base && B4=$(git rev-parse HEAD)
git push -q "$T/pub4.git" HEAD:refs/heads/main && git push -q "$T/priv4.git" HEAD:refs/heads/main
echo one >>a && git commit -q -am "private 1" && echo two >>a && git commit -q -am "private 2" && PT4=$(git rev-parse HEAD)
git push -q "$T/priv4.git" HEAD:refs/heads/security/multi
git reset -q --hard "$B4"
echo public >>b && git commit -q -am "public moves on" && git push -q "$T/pub4.git" HEAD:refs/heads/main
git merge -q --squash "$PT4" >/dev/null 2>&1 && git commit -q -m "squash onto newer main" && SQ4=$(git rev-parse HEAD)
check 1 "multi-commit private squash onto a newer public main" "$T/pub4.git" refs/heads/main "$SQ4" refs/heads/main "$E4" "$P4"
# The same change recreated as two different public-looking commits.
git reset -q --hard HEAD~1
echo one >>a && git commit -q -am "step A" && echo two >>a && git commit -q -am "step B" && RE4=$(git rev-parse HEAD)
check 1 "private change recreated as several new commits (combined patch)" "$T/pub4.git" refs/heads/main "$RE4" refs/heads/main "$E4" "$P4"

# A private series recreated on top of another public branch, re-split by
# file: matched through the pushed branch's combined change from its public
# boundary (not only from public main).
git init -q --bare "$T/pub6.git" && git init -q --bare "$T/priv6.git"
git init -q "$T/fb" && cd "$T/fb" || exit 1
E6="COCALC_PUBLIC_URL=$T/pub6.git"
P6="COCALC_PRIVATE_URL=$T/priv6.git"
echo base >a && echo base >b && echo base >c && git add a b c && git commit -q -m base && B6=$(git rev-parse HEAD)
git push -q "$T/pub6.git" HEAD:refs/heads/main && git push -q "$T/priv6.git" HEAD:refs/heads/main
echo p1 >>a && echo p1 >>b && git commit -q -am "private 1" && echo p2 >>a && echo p2 >>b && git commit -q -am "private 2"
git push -q "$T/priv6.git" HEAD:refs/heads/security/series
git reset -q --hard "$B6" && echo side >>c && git commit -q -am "public side branch" && git push -q "$T/pub6.git" HEAD:refs/heads/feature/side
printf 'p1\np2\n' >>a && git commit -q -am "split: a" && printf 'p1\np2\n' >>b && git commit -q -am "split: b" && FB6=$(git rev-parse HEAD)
check 1 "private series re-split on top of a public side branch" "$T/pub6.git" refs/heads/feature/side "$FB6" refs/heads/feature/side "$E6" "$P6"

# Injected failures fail closed: a failing sort of the boundary list (signature
# step) and a failing `git remote` (input collection).
mkdir -p "$T/fbin" "$T/gbin"
# Real binaries, not wrappers that may themselves call through PATH.
REALSORT=$(PATH=/usr/bin:/bin command -v sort) REALGIT=$(PATH=/usr/bin:/bin command -v git)
printf '#!/bin/sh\ncase "$*" in *boundaries*) exit 97 ;; esac\nexec %s "$@"\n' "$REALSORT" >"$T/fbin/sort"
printf '#!/bin/sh\n[ "$1" = remote ] && [ $# -eq 1 ] && exit 97\nexec %s "$@"\n' "$REALGIT" >"$T/gbin/git"
chmod +x "$T/fbin/sort" "$T/gbin/git"
cd "$T/fb" || exit 1
check 1 "boundary sort fails (signature step): fail closed" "$T/pub6.git" refs/heads/feature/side "$FB6" refs/heads/feature/side "$E6" "$P6" PATH="$T/fbin:$PATH"
REALAWK=$(PATH=/usr/bin:/bin command -v awk)
mkdir -p "$T/abin"
printf '#!/bin/sh\nfor a; do case "$a" in */private-patch-ids) exit 96 ;; esac; done\nexec %s "$@"\n' "$REALAWK" >"$T/abin/awk"
chmod +x "$T/abin/awk"
check 1 "awk on private-patch-ids fails (membership test): fail closed" "$T/pub6.git" refs/heads/feature/side "$FB6" refs/heads/feature/side "$E6" "$P6" PATH="$T/abin:$PATH"
REALCOMM=$(PATH=/usr/bin:/bin command -v comm)
mkdir -p "$T/cbin"
printf '#!/bin/sh\n[ "$1" = -12 ] && exit 95\nexec %s "$@"\n' "$REALCOMM" >"$T/cbin/comm"
chmod +x "$T/cbin/comm"
(cd "$T/work" && printf 'refs/heads/x %s refs/heads/fix/innocent %s\n' "$PRIV" "$Z" |
  PATH="$T/cbin:$PATH" bash "$H" origin "$T/pub.git" >/dev/null 2>&1) &&
  { fail=$((fail + 1)); echo "FAIL  exact private commit allowed when comm fails"; } ||
  { pass=$((pass + 1)); echo "ok    exact private (empty) commit: comm failure fails closed"; }
# awk failing in the deletion-only check must not mean "deletions only".
mkdir -p "$T/a2bin"
printf '#!/bin/sh\nexit 96\n' >"$T/a2bin/awk" && chmod +x "$T/a2bin/awk"
(cd "$T/work" && printf 'refs/heads/x %s refs/heads/fix/innocent %s\n' "$PRIV" "$Z" |
  PATH="$T/a2bin:$PATH" bash "$H" origin "$T/pub.git" >/dev/null 2>&1) &&
  { fail=$((fail + 1)); echo "FAIL  awk failure treated as a deletion-only push"; } ||
  { pass=$((pass + 1)); echo "ok    awk failure in the deletion check fails closed"; }
check 1 "'git remote' fails (input collection): fail closed" "$T/pub6.git" refs/heads/feature/side "$FB6" refs/heads/feature/side "$E6" "$P6" PATH="$T/gbin:$PATH"

# Content public long ago (2020) under another commit id stays allowed, even
# if a newer private commit has the same content (tree and patch-id cases).
git init -q --bare "$T/pub3.git" && git init -q --bare "$T/priv3.git"
git init -q "$T/old" && cd "$T/old" || exit 1
E3="COCALC_PUBLIC_URL=$T/pub3.git"
P3="COCALC_PRIVATE_URL=$T/priv3.git"
echo base >f && git add f && git commit -q -m base && B3=$(git rev-parse HEAD)
git push -q "$T/pub3.git" HEAD:refs/heads/main && git push -q "$T/priv3.git" HEAD:refs/heads/main
echo fix >>f && GIT_AUTHOR_DATE=2020-01-01T00:00:00Z GIT_COMMITTER_DATE=2020-01-01T00:00:00Z git commit -q -am "old public fix"
git push -q "$T/pub3.git" HEAD:refs/heads/disclosed-2020
git reset -q --hard "$B3"
echo fix >>f && git commit -q -am "same change, private, 2026" && git push -q "$T/priv3.git" HEAD:refs/heads/security/x
git reset -q --hard "$B3"
echo fix >>f && git commit -q -am "innocent third copy" && I3=$(git rev-parse HEAD)
check 0 "content public since 2020 under another commit id" "$T/pub3.git" refs/heads/main "$I3" refs/heads/main "$E3" "$P3"
git reset -q --hard "$B3"
echo other >g && git add g && git commit -q -m "public moves on" && git push -q "$T/pub3.git" HEAD:refs/heads/main
echo fix >>f && git commit -q -am "same patch on a newer base" && I4=$(git rev-parse HEAD)
check 0 "patch public since 2020 under another commit id (different tree)" "$T/pub3.git" refs/heads/main "$I4" refs/heads/main "$E3" "$P3"

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
git config --unset core.hooksPath
printf '[core]\n\thooksPath = conditional-hooks\n' >"$T/cond.gitconfig"
git config 'includeIf.onbranch:security/**.path' "$T/cond.gitconfig"
inst 1 "refuses when a branch-conditional include sets core.hooksPath"
git config --unset 'includeIf.onbranch:security/**.path'
git commit -q --allow-empty -m wt && git worktree add -q "$T/inst-wt" -b other >/dev/null 2>&1
git config extensions.worktreeConfig true && git -C "$T/inst-wt" config --worktree core.hooksPath wt-hooks
inst 1 "refuses when another worktree's config sets core.hooksPath"
git -C "$T/inst-wt" config --worktree --unset core.hooksPath
inst 0 "installs again once nothing sets core.hooksPath"
git config 'includeIf.onbranch:security/**.path' "$T/not-there-yet.gitconfig"
inst 1 "refuses an include target that does not exist (yet)"
git config --unset 'includeIf.onbranch:security/**.path'
mkdir -p "$T/wtbin"
printf '#!/bin/sh\n[ "$1" = worktree ] && [ "$2" = list ] && exit 73\nexec %s "$@"\n' "$REALGIT" >"$T/wtbin/git"
chmod +x "$T/wtbin/git"
PATH="$T/wtbin:$PATH" bash "$here/install-hooks.sh" >/dev/null 2>&1 &&
  { fail=$((fail + 1)); echo "FAIL  installer ignored a failing 'git worktree list'"; } ||
  { pass=$((pass + 1)); echo "ok    installer refuses when 'git worktree list' fails"; }

echo "pass=$pass fail=$fail"
[ $fail = 0 ]
