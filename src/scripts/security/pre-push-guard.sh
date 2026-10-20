#!/usr/bin/env bash
# Git pre-push hook: never publish undisclosed private security work by
# accident.  See README.md in this directory.
#
# Pushes to a known private repository are always allowed: the official
# private repos on GitHub in the supported transport forms (see
# is_private_url), plus any URL that exactly equals a
# `git config --add cocalc.privateUrl <url>` value.
# Every other destination (the public repo, forks, other hosts, local paths)
# is refused if
#   - the pushed source or destination branch is a private branch name
#     (security/*, ghsa*, release/*security*), or
#   - it would push a private commit: one on a branch of the private repo, of
#     another private remote or cocalc.privateUrl repo, or a local or tracking
#     branch with a private name, that is not on any branch of the public repo,
#   - or a commit with the same tree or patch-id as such a private commit, or
#     whose patch-id (or the pushed branch's combined patch since it forked
#     from public main) equals a private branch's combined patch: rewritten
#     private work (cherry-pick, amend, rebase, squash), unless that content
#     is already public as an individual public commit under another id.
# Pushes that only delete branches are always allowed.
# All of those branch lists are fetched fresh on every such push; commits of
# retired private remotes (private-fix.sh retire-remote) count as private too.
# If any fetch fails for a clone that has (or has seen) private work, the push
# is refused (fail closed).
# disclose.sh sets COCALC_DISCLOSE=1 to make the deliberate disclosure push.
#
# Install for every worktree of a clone with install-hooks.sh.

set -uo pipefail

PUBLIC_URL=${COCALC_PUBLIC_URL:-git@github.com:sagemathinc/cocalc-ai.git}
PRIVATE_URL=${COCALC_PRIVATE_URL:-git@github.com:sagemathinc/cocalc-ai-private.git}
GUARD_REFS=refs/cocalc-guard

# The official private repos, trusted only in the supported GitHub transport
# forms (GitHub owner/repo names are case-insensitive):
#   git@github.com:sagemathinc/<repo>[.git]
#   ssh://git@github.com[:22]/sagemathinc/<repo>[.git]
#   ssh://git@ssh.github.com:443/sagemathinc/<repo>[.git]
#   https://github.com/sagemathinc/<repo>[.git][/]
# where <repo> is cocalc-ai-private, cocalc-ai-content-security or an advisory
# fork cocalc-ai-ghsa-xxxx-xxxx-xxxx.  Any other URL is private only if it is
# exactly (string equality) one of the `git config cocalc.privateUrl` values.
is_private_url() {
  local u=${1,,} extra
  local repo='sagemathinc/cocalc-ai-(private|content-security|ghsa-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})(\.git)?'
  if [[ $u =~ ^git@github\.com:${repo}$ ]] ||
    [[ $u =~ ^ssh://git@github\.com(:22)?/${repo}$ ]] ||
    [[ $u =~ ^ssh://git@ssh\.github\.com:443/${repo}$ ]] ||
    [[ $u =~ ^https://github\.com/${repo}/?$ ]]; then
    return 0
  fi
  while IFS= read -r extra; do
    [ -n "$extra" ] && [ "$1" = "$extra" ] && return 0
  done < <(git config --get-all cocalc.privateUrl 2>/dev/null)
  return 1
}

# Ref namespace for a source: the hash of its exact URL.
url_key() {
  printf '%s' "$1" | git hash-object --stdin
}

is_private_branch() { # <branch name without refs/heads/>
  [[ $1 == security/* || $1 == ghsa* || ($1 == release/* && $1 == *security*) ]]
}

refuse() {
  echo "pre-push-guard: $*" >&2
  status=1
}

# Whether patch-id $2 appears in column 2 of file $1: 0 = yes, 1 = no,
# 2 = could not tell (error).
has_pid() { # <file> <pid>
  local rc
  awk -v p="$2" '$2 == p { found = 1 } END { exit found ? 10 : 11 }' "$1"
  rc=$?
  case $rc in 10) return 0 ;; 11) return 1 ;; *) return 2 ;; esac
}

# Public main must exist once the public fetch succeeded; anything else is an
# error.
require_public_main() {
  git rev-parse -q --verify "$GUARD_REFS/public/main^{commit}" >/dev/null
}

# All signature helpers below return nonzero on ANY failure (git, cache,
# filesystem); the caller then refuses the push.  Loops read from files rather
# than pipelines so that failures are not lost.

# The patch-id cache: "<oid> <patch-id>" and "<base>..<tip> <patch-id>" lines,
# "-" for no patch.  A commit's (or range's) patch-id never changes.
patch_cache() {
  local cache
  cache=$(git rev-parse --path-format=absolute --git-common-dir)/cocalc-guard-patch-ids || return 1
  if [ ! -e "$cache" ]; then : >"$cache" || return 1; fi
  [ -f "$cache" ] && [ -r "$cache" ] && [ -w "$cache" ] || return 1
  echo "$cache"
}

# Patch-ids of the commits in file $1 (one oid per line) into file $2 as
# "<oid> <patch-id>" ("-" for merges and empty commits).
patch_ids() { # <oids-file> <out-file>
  local cache
  cache=$(patch_cache) || return 1
  sort -u "$1" >"$tmp/pid-want" || return 1
  awk '{ print $1 }' "$cache" >"$tmp/pid-cached-raw" || return 1
  sort -u "$tmp/pid-cached-raw" >"$tmp/pid-cached" || return 1
  comm -23 "$tmp/pid-want" "$tmp/pid-cached" >"$tmp/pid-missing" || return 1
  if [ -s "$tmp/pid-missing" ]; then
    git log --no-walk -p --no-merges --format='commit %H' --stdin <"$tmp/pid-missing" >"$tmp/pid-diffs" || return 1
    git patch-id --stable <"$tmp/pid-diffs" >"$tmp/pid-raw" || return 1
    awk '{ print $2, $1 }' "$tmp/pid-raw" >"$tmp/pid-new" || return 1
    awk '{ print $1 }' "$tmp/pid-new" | sort -u >"$tmp/pid-new-oids" || return 1
    comm -23 "$tmp/pid-missing" "$tmp/pid-new-oids" | awk '{ print $1, "-" }' >"$tmp/pid-none" || return 1
    cat "$tmp/pid-new" "$tmp/pid-none" >>"$cache" || return 1
  fi
  awk 'NR == FNR { w[$1] = 1; next } ($1 in w) && !seen[$1]++' "$tmp/pid-want" "$cache" >"$2" || return 1
  # Every wanted commit must have a cached answer.
  [ "$(wc -l <"$2")" -eq "$(wc -l <"$tmp/pid-want")" ] || return 1
}

# "<oid> <sha256 of its message>" for each commit in file $1 into file $2.
message_hashes() { # <oids-file> <out-file>
  local oid msg hash
  : >"$2" || return 1
  while read -r oid; do
    [ -n "$oid" ] || continue
    msg=$(git log -1 --format=%B "$oid") || return 1
    hash=$(printf '%s' "$msg" | sha256sum) || return 1
    echo "$oid ${hash%% *}" >>"$2" || return 1
  done <"$1"
}

# Non-merge commits in file $1 ("<oid> <tree> <parents...>") whose tree is
# their parent's (empty commits), given "<oid> <tree>" of the parents in $2.
empty_commits() { # <commits-file> <parent-trees-file> <out-file>
  awk 'NR == FNR { pt[$1] = $2; next } NF == 3 && ($3 in pt) && pt[$3] == $2 { print $1 }' \
    "$2" "$1" >"$3"
}

# Patch-id of the combined change base..tip (what a squash of that range
# produces), "-" if empty; printed on stdout.
range_patch_id() { # <base> <tip>
  local cache key pid
  cache=$(patch_cache) || return 1
  key="$1..$2"
  pid=$(awk -v k="$key" '$1 == k { print $2; exit }' "$cache") || return 1
  if [ -z "$pid" ]; then
    { echo "commit $2" && git diff -p "$1" "$2"; } >"$tmp/range-diff" || return 1
    git patch-id --stable <"$tmp/range-diff" >"$tmp/range-pid" || return 1
    pid=$(awk '{ print $1; exit }' "$tmp/range-pid") || return 1
    pid=${pid:--}
    echo "$key $pid" >>"$cache" || return 1
  fi
  echo "$pid"
}

# merge-base of public main and $1, printed; empty if none.  Fails on errors
# (exit status 1 just means "no common ancestor").
fork_point() { # <commit>
  local out rc
  out=$(git merge-base "$GUARD_REFS/public/main" "$1")
  rc=$?
  [ $rc = 0 ] && { echo "$out"; return 0; }
  [ $rc = 1 ] && return 0
  return 1
}


# Trees and patch-ids of the private commits ($private), computed once per run:
# $tmp/private-trees (trees of private commits that change something relative
# to their first parent) and $tmp/private-patch-ids ("<oid> <patch-id>" and
# "<base>..<tip> <patch-id>" for each private branch's combined change since
# it forked from public main).  $tmp/sig-ok marks a complete load.
load_private_signatures() {
  [ -e "$tmp/sig-ok" ] && return 0
  local tip base pid key
  printf '%s\n' "$private" | awk 'NF' >"$tmp/private-oids" || return 1
  git log --no-walk --format='%H %T %P' --stdin <"$tmp/private-oids" >"$tmp/private-commits" || return 1
  awk '$3 ~ /^[0-9a-f]{40}$/ { print $3 }' "$tmp/private-commits" | sort -u >"$tmp/parents" || return 1
  : >"$tmp/parent-trees" || return 1
  if [ -s "$tmp/parents" ]; then
    git log --no-walk --format='%H %T' --stdin <"$tmp/parents" >"$tmp/parent-trees" || return 1
  fi
  awk 'NR == FNR { pt[$1] = $2; next } !($3 in pt) || pt[$3] != $2 { print $2 }' \
    "$tmp/parent-trees" "$tmp/private-commits" | sort -u >"$tmp/private-trees" || return 1
  # An empty private commit has no tree or patch to recognize, but its
  # message may describe the fix: keep its message as its signature.
  empty_commits "$tmp/private-commits" "$tmp/parent-trees" "$tmp/private-empty" || return 1
  message_hashes "$tmp/private-empty" "$tmp/private-empty-msgs" || return 1
  awk '{ print $2 }' "$tmp/private-empty-msgs" | sort -u >"$tmp/private-msgs" || return 1
  patch_ids "$tmp/private-oids" "$tmp/private-pids-all" || return 1
  awk '$2 != "-"' "$tmp/private-pids-all" >"$tmp/private-patch-ids" || return 1
  require_public_main || return 1
  # Combined change from the current public boundary to EVERY private commit
  # (not only branch tips), so squashing any part of a private series is
  # recognized.  One topological pass over the private commits, excluding
  # everything on ANY public branch: a commit's boundary is its first parent
  # if that parent is public, else the parent's boundary.  It is recomputed
  # each run, so disclosing a prefix (e.g. P1 of P1-P2-P3) moves the boundary.
  # Range patch-ids ("<base>..<tip> <pid>") are content-addressed and cached.
  local cache
  cache=$(patch_cache) || return 1
  {
    cat "$tmp/private-oids" && echo "--not" && echo "--glob=$GUARD_REFS/public/*"
  } >"$tmp/boundary-args" || return 1
  git rev-list --reverse --topo-order --parents --stdin <"$tmp/boundary-args" >"$tmp/private-topo" || return 1
  awk 'NF >= 2 { base[$1] = ($2 in base) ? base[$2] : $2; print base[$1] ".." $1 }' \
    "$tmp/private-topo" | sort -u >"$tmp/ranges" || return 1
  awk 'NR == FNR { w[$1] = 1; next } ($1 in w) && !seen[$1]++' "$tmp/ranges" "$cache" >"$tmp/range-known" || return 1
  awk '{ print $1 }' "$tmp/range-known" | sort -u >"$tmp/range-known-keys" || return 1
  comm -23 "$tmp/ranges" "$tmp/range-known-keys" >"$tmp/range-missing" || return 1
  : >"$tmp/range-new" || return 1
  while read -r key; do
    { echo "commit ${key#*..}" && git diff -p "${key%%..*}" "${key#*..}"; } >"$tmp/range-diff" || return 1
    git patch-id --stable <"$tmp/range-diff" >"$tmp/range-pid" || return 1
    pid=$(awk '{ print $1; exit }' "$tmp/range-pid") || return 1
    echo "$key ${pid:--}" >>"$tmp/range-new" || return 1
  done <"$tmp/range-missing"
  cat "$tmp/range-new" >>"$cache" || return 1
  cat "$tmp/range-known" "$tmp/range-new" | awk '$2 != "-"' >>"$tmp/private-patch-ids" || return 1
  : >"$tmp/sig-ok"
}

# Pushed commits ($1: newline-separated oids; $2: the pushed tip) whose tree or
# patch-id equals that of undisclosed private work, unless that tree or patch
# is already public as an individual public commit.  Prints the matching
# pushed oids; returns nonzero on any failure.
rewritten_private_work() {
  local pushed=$1 tip=$2 pid oid base verdict files=()
  printf '%s\n' "$pushed" | awk 'NF' >"$tmp/pushed-oids" || return 1
  : >"$tmp/hits" || return 1
  # Same tree as a private commit, and no public commit has that tree.
  git log --no-walk --format='%T %H' --stdin <"$tmp/pushed-oids" >"$tmp/pushed-trees" || return 1
  awk 'NR == FNR { t[$1] = 1; next } ($1 in t)' "$tmp/private-trees" "$tmp/pushed-trees" >"$tmp/tree-hits" || return 1
  if [ -s "$tmp/tree-hits" ]; then
    if [ ! -e "$tmp/public-trees" ]; then
      git log --glob="$GUARD_REFS/public/*" --format='%T' >"$tmp/public-trees-raw" || return 1
      sort -u "$tmp/public-trees-raw" >"$tmp/public-trees" || return 1
    fi
    awk 'NR == FNR { pub[$1] = 1; next } !($1 in pub) { print $2 }' "$tmp/public-trees" "$tmp/tree-hits" >>"$tmp/hits" || return 1
  fi
  # An empty pushed commit with the message of an empty private commit.
  if [ -s "$tmp/private-msgs" ]; then
    git log --no-walk --format='%H %T %P' --stdin <"$tmp/pushed-oids" >"$tmp/pushed-commits" || return 1
    awk 'NF == 3 { print $3 }' "$tmp/pushed-commits" | sort -u >"$tmp/pushed-parent-oids" || return 1
    : >"$tmp/pushed-parent-trees" || return 1
    if [ -s "$tmp/pushed-parent-oids" ]; then
      git log --no-walk --format='%H %T' --stdin <"$tmp/pushed-parent-oids" >"$tmp/pushed-parent-trees" || return 1
    fi
    empty_commits "$tmp/pushed-commits" "$tmp/pushed-parent-trees" "$tmp/pushed-empty" || return 1
    message_hashes "$tmp/pushed-empty" "$tmp/pushed-empty-msgs" || return 1
    awk 'NR == FNR { m[$1] = 1; next } ($2 in m) { print $1 }' \
      "$tmp/private-msgs" "$tmp/pushed-empty-msgs" >>"$tmp/hits" || return 1
  fi
  # Patch-ids of the pushed commits, and of the pushed branch's combined
  # change from each of its public boundary commits (parents of pushed commits
  # that are already public, whatever public branch they are on) and from its
  # fork point with public main.
  patch_ids "$tmp/pushed-oids" "$tmp/pushed-pids" || return 1
  git log --no-walk --format='%P' --stdin <"$tmp/pushed-oids" >"$tmp/pushed-parents" || return 1
  tr ' ' '\n' <"$tmp/pushed-parents" | awk 'NF' | sort -u >"$tmp/pushed-parents-sorted" || return 1
  sort -u "$tmp/pushed-oids" >"$tmp/pushed-sorted" || return 1
  comm -23 "$tmp/pushed-parents-sorted" "$tmp/pushed-sorted" >"$tmp/boundaries" || return 1
  require_public_main || return 1
  base=$(fork_point "$tip") || return 1
  if [ -n "$base" ]; then echo "$base" >>"$tmp/boundaries" || return 1; fi
  sort -u "$tmp/boundaries" >"$tmp/boundaries-sorted" || return 1
  while read -r base; do
    [ -n "$base" ] && [ "$base" != "$tip" ] || continue
    pid=$(range_patch_id "$base" "$tip") || return 1
    echo "$tip $pid" >>"$tmp/pushed-pids" || return 1
  done <"$tmp/boundaries-sorted"
  # Combined change from the public boundary to EVERY pushed commit (each
  # prefix), so private work re-split across commits and followed by unrelated
  # commits is still recognized (same topological rule as the private side).
  {
    cat "$tmp/pushed-oids" && echo "--not" && echo "--glob=$GUARD_REFS/public/*"
  } >"$tmp/pushed-boundary-args" || return 1
  git rev-list --reverse --topo-order --parents --stdin <"$tmp/pushed-boundary-args" >"$tmp/pushed-topo" || return 1
  awk 'NF >= 2 { base[$1] = ($2 in base) ? base[$2] : $2; print base[$1], $1 }' \
    "$tmp/pushed-topo" >"$tmp/pushed-ranges" || return 1
  while read -r base oid; do
    [ -n "$oid" ] || continue
    pid=$(range_patch_id "$base" "$oid") || return 1
    echo "$oid $pid" >>"$tmp/pushed-pids" || return 1
  done <"$tmp/pushed-ranges"
  # Same patch-id as private work, and no public commit touching the same
  # files has that patch-id.
  while read -r oid pid; do
    [ -n "$pid" ] && [ "$pid" != "-" ] || continue
    has_pid "$tmp/private-patch-ids" "$pid"
    case $? in 0) ;; 1) continue ;; *) return 1 ;; esac
    if [ ! -e "$tmp/pid-public-$pid" ]; then
      awk -v p="$pid" '$2 == p { print $1 }' "$tmp/private-patch-ids" >"$tmp/pid-specs" || return 1
      : >"$tmp/pid-files" || return 1
      while read -r c; do
        if [[ $c == *..* ]]; then
          git diff --name-only "$c" >>"$tmp/pid-files" || return 1
        else
          git diff-tree --no-commit-id --name-only -r --root "$c" >>"$tmp/pid-files" || return 1
        fi
      done <"$tmp/pid-specs"
      sort -u "$tmp/pid-files" >"$tmp/pid-files-sorted" || return 1
      mapfile -t files <"$tmp/pid-files-sorted"
      echo private >"$tmp/pid-public-$pid" || return 1
      if [ ${#files[@]} -gt 0 ]; then
        git log --glob="$GUARD_REFS/public/*" --format='%H' -- "${files[@]}" >"$tmp/pid-cands" || return 1
        patch_ids "$tmp/pid-cands" "$tmp/pid-cand-pids" || return 1
        has_pid "$tmp/pid-cand-pids" "$pid"
        case $? in
          0) echo public >"$tmp/pid-public-$pid" || return 1 ;;
          1) ;;
          *) return 1 ;;
        esac
      fi
    fi
    verdict=$(cat "$tmp/pid-public-$pid") || return 1
    case $verdict in
      private) echo "$oid" >>"$tmp/hits" || return 1 ;;
      public) ;;
      *) return 1 ;;
    esac
  done <"$tmp/pushed-pids"
  awk 'NF' "$tmp/hits" | sort -u
}

remote_url=${2:-}
if is_private_url "$remote_url"; then
  # Allowed, but record every commit pushed to a private repo first
  # (refs/cocalc-guard/seen/<oid>), so it stays known as private even if that
  # private branch is deleted or force-pushed before any public push is checked.
  zero=0000000000000000000000000000000000000000
  while read -r _local_ref local_sha _remote_ref _remote_sha; do
    [ -n "$local_sha" ] && [ "$local_sha" != "$zero" ] || continue
    if ! type=$(git cat-file -t "$local_sha"); then
      echo "pre-push-guard: could not inspect $local_sha; refusing (fail closed)." >&2
      exit 1
    fi
    case $type in commit | tag) ;; *) continue ;; esac # blobs/trees: nothing to record
    if ! commit=$(git rev-parse -q --verify "$local_sha^{commit}"); then
      [ "$type" = tag ] && continue # a tag of a blob or tree
      echo "pre-push-guard: could not resolve $local_sha; refusing (fail closed)." >&2
      exit 1
    fi
    if ! git update-ref "$GUARD_REFS/seen/$commit" "$commit"; then
      echo "pre-push-guard: could not record $commit as private; refusing (fail closed)." >&2
      exit 1
    fi
  done
  exit 0
fi
if [ "${COCALC_DISCLOSE:-0}" = 1 ]; then
  echo "pre-push-guard: COCALC_DISCLOSE=1, allowing a deliberate disclosure push to $remote_url" >&2
  exit 0
fi

status=0
if ! updates=$(cat); then
  echo "pre-push-guard: could not read the push updates; refusing (fail closed)." >&2
  exit 1
fi

zero=0000000000000000000000000000000000000000

# Deletions publish nothing; a push that only deletes branches (e.g. removing
# an accidentally pushed private branch) is allowed without any analysis.
awk -v z="$zero" 'NF && $2 != z { found = 1 } END { exit found ? 10 : 11 }' <<<"$updates"
case $? in
  10) ;;        # something is published: analyze
  11) exit 0 ;; # deletions only
  *)
    echo "pre-push-guard: could not parse the push updates; refusing (fail closed)." >&2
    exit 1
    ;;
esac

# Branch names first: no network needed.  Deletions publish nothing, and
# deleting an accidentally pushed private branch must work.
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ -z "$local_ref" ] && continue
  [ "$local_sha" = "$zero" ] && continue
  # Only commits can be checked.  Refuse anything else for every non-private
  # destination: blobs, trees, and annotated tag objects (a tag message is new
  # content that could describe an undisclosed vulnerability, even when the
  # tag points at a public commit).  Lightweight tags of commits are fine.
  if ! obj_type=$(git cat-file -t "$local_sha"); then
    refuse "could not inspect $local_sha ($local_ref); refusing (fail closed)."
  elif [ "$obj_type" = tag ]; then
    refuse "refusing to push $local_ref -> $remote_ref to $remote_url: annotated tag objects carry a message that cannot be checked; push a lightweight tag, or disclose deliberately with disclose.sh."
  elif [ "$obj_type" != commit ]; then
    refuse "refusing to push $local_ref -> $remote_ref to $remote_url: it is a $obj_type, not a commit, so it cannot be checked for private content."
  fi
  for ref in "$local_ref" "$remote_ref"; do
    if [[ $ref == refs/heads/* ]] && is_private_branch "${ref#refs/heads/}"; then
      refuse "refusing to push $local_ref -> $remote_ref to $remote_url: '${ref#refs/heads/}' is a private branch name."
    fi
  done
done <<<"$updates"

tmp=$(mktemp -d) || {
  echo "pre-push-guard: cannot create a temporary directory; refusing (fail closed)." >&2
  exit 1
}
trap 'rm -rf "$tmp"' EXIT
# Every input below is collected into a checked file first: a failing git
# command must refuse the push, never silently shrink the private lists.
fail_closed() {
  echo "pre-push-guard: $*; refusing (fail closed)." >&2
  exit 1
}
git remote >"$tmp/remotes" || fail_closed "could not list remotes"
git config --get-all cocalc.privateUrl >"$tmp/private-urls"
rc=$?
[ $rc = 0 ] || [ $rc = 1 ] || fail_closed "could not read cocalc.privateUrl"
git for-each-ref --format='%(refname)' refs/heads >"$tmp/local-heads" || fail_closed "could not list branches"
git for-each-ref --format='%(refname)' refs/remotes >"$tmp/remote-refs" || fail_closed "could not list remote-tracking branches"
git for-each-ref --count=1 "$GUARD_REFS/src/" "$GUARD_REFS/retired/" "$GUARD_REFS/seen/" >"$tmp/guard-cached" ||
  fail_closed "could not read the guard's cached refs"

# Sources of private commits: the private repo, every private remote and every
# cocalc.privateUrl, fetched fresh (in parallel) into $GUARD_REFS/src/<key>/*,
# plus the private remotes' tracking refs and local private-named branches.
sources=()
seen=" "
add_source() { # <url>
  # Dedupe by exact URL; the ref namespace is the hash of that URL, so
  # different URLs never share a namespace.
  local key
  key=$(url_key "$1") && [ -n "$key" ] || fail_closed "could not hash $1"
  [[ $seen == *" $key "* ]] && return
  seen+="$key "
  sources+=("$key|$1")
}
add_source "$PRIVATE_URL"
private_remote_refs=()
mapfile -t remote_names <"$tmp/remotes"
for name in "${remote_names[@]}"; do
  [ -z "$name" ] && continue
  # A remote may have several URLs (git fetch uses the first) or none (exit
  # status 1): it is private if ANY of its URLs is private (conservative).
  rc=0
  git config --get-all "remote.$name.url" >"$tmp/remote-urls" || rc=$?
  [ $rc = 0 ] || [ $rc = 1 ] || fail_closed "could not read the URLs of remote $name"
  remote_is_private=0
  while IFS= read -r url; do
    if [ -n "$url" ] && is_private_url "$url"; then
      remote_is_private=1
      add_source "$url"
    fi
  done <"$tmp/remote-urls"
  [ $remote_is_private = 1 ] && private_remote_refs+=("--remotes=$name")
done
while read -r extra; do
  [ -n "$extra" ] && add_source "$extra"
done <"$tmp/private-urls"
local_private_branches=()
while read -r ref; do
  is_private_branch "${ref#refs/heads/}" && local_private_branches+=("$ref")
done <"$tmp/local-heads"
# Private-named tracking branches of ANY remote (refs/remotes/<remote>/security/*
# etc.) are private too, even if the remote has no URL or an unrecognized one.
while read -r ref; do
  # Branch name = what follows the longest configured remote name (remote
  # names may contain "/").  For a ref whose remote is no longer configured,
  # test every suffix: conservative.
  rest=${ref#refs/remotes/}
  best=""
  for name in "${remote_names[@]}"; do
    if [[ $rest == "$name"/* ]] && [ ${#name} -gt ${#best} ]; then best=$name; fi
  done
  if [ -n "$best" ]; then
    is_private_branch "${rest#"$best"/}" && local_private_branches+=("$ref")
  else
    while [[ $rest == */* ]]; do
      rest=${rest#*/}
      if is_private_branch "$rest"; then
        local_private_branches+=("$ref")
        break
      fi
    done
  fi
done <"$tmp/remote-refs"

# A clone has private work if it has a private remote, a cocalc.privateUrl,
# a private-named local or tracking branch, retired private refs, or private
# branch lists cached by an earlier run of this guard.
has_private_work=0
if [ ${#private_remote_refs[@]} -gt 0 ] || [ ${#local_private_branches[@]} -gt 0 ] ||
  [ -s "$tmp/private-urls" ] || [ -s "$tmp/guard-cached" ]; then
  has_private_work=1
fi

for source in "${sources[@]}"; do
  key=${source%%|*}
  url=${source#*|}
  (
    git fetch -q --no-tags --no-write-fetch-head "$url" "+refs/heads/*:$GUARD_REFS/src/$key/*" 2>"$tmp/$key.err"
    echo $? >"$tmp/$key.rc"
  ) &
done
wait
failed=()
for source in "${sources[@]}"; do
  key=${source%%|*}
  url=${source#*|}
  fetch_rc=$(cat "$tmp/$key.rc") || fail_closed "could not read the fetch result for $url"
  case $fetch_rc in
    0) has_private_work=1 ;;
    [0-9]*) failed+=("$url") ;;
    *) fail_closed "unexpected fetch result for $url" ;;
  esac
done
# Private refs are never pruned, and every private tip ever seen is archived by
# object id, so deleting or force-pushing a private branch early cannot erase
# the evidence.  (Commits that later become public are subtracted below.)
# That includes the tips of private-named local and tracking branches and of
# private remotes' tracking branches, so deleting or renaming one after the
# guard has seen it does not erase the evidence either.
archive_patterns=("$GUARD_REFS/src/" "$GUARD_REFS/retired/" "${local_private_branches[@]}")
for r in "${private_remote_refs[@]}"; do archive_patterns+=("refs/remotes/${r#--remotes=}/"); done
if ! git for-each-ref --format="update $GUARD_REFS/seen/%(objectname) %(objectname)" \
  "${archive_patterns[@]}" | sort -u | git update-ref --stdin; then
  refuse "could not archive private tips under $GUARD_REFS/seen; refusing (fail closed)."
fi
# Recompute after all fetches and archiving: a fetch that failed may still
# have stored private refs (e.g. one ref lock failure), so a first run in a
# clone with no prior private state must not skip analysis.
git for-each-ref --count=1 "$GUARD_REFS/src/" "$GUARD_REFS/retired/" "$GUARD_REFS/seen/" >"$tmp/guard-now" ||
  fail_closed "could not read the guard's refs"
[ -s "$tmp/guard-now" ] && has_private_work=1
if [ ${#failed[@]} -gt 0 ] && [ $has_private_work = 1 ]; then
  refuse "cannot fetch ${failed[*]} to check for private commits; refusing (fail closed). If a private repo was deleted (e.g. a published advisory fork), retire its remote with: src/scripts/security/private-fix.sh retire-remote <name>"
fi

if [ $has_private_work = 1 ] && [ $status = 0 ]; then
  if ! git fetch -q --no-tags --prune --no-write-fetch-head "$PUBLIC_URL" "+refs/heads/*:$GUARD_REFS/public/*" 2>/dev/null; then
    refuse "cannot fetch $PUBLIC_URL to check what is already public; refusing (fail closed)."
  else
    if ! private=$(git rev-list --glob="$GUARD_REFS/src/*" --glob="$GUARD_REFS/retired/*" --glob="$GUARD_REFS/seen/*" "${private_remote_refs[@]}" \
      "${local_private_branches[@]}" --not --glob="$GUARD_REFS/public/*" | sort); then
      refuse "could not list private commits; refusing (fail closed)."
    else
      while read -r local_ref local_sha remote_ref _remote_sha; do
        [ -z "$local_ref" ] && continue
        [ "$local_sha" = "$zero" ] && continue # deleting a remote branch
        # Analyze the commit the pushed object peels to (annotated tags
        # included).  A blob or tree pushed directly, or a tag of one, cannot
        # be checked: refuse it.
        if ! local_sha=$(git rev-parse -q --verify "$local_sha^{commit}"); then
          refuse "refusing to push $local_ref -> $remote_ref to $remote_url: it is not a commit (or a tag of one), so it cannot be checked for private content."
          continue
        fi
        # Commits this push would add that are not already public ...
        if ! pushed=$(git rev-list "$local_sha" --not --glob="$GUARD_REFS/public/*" | sort); then
          refuse "could not analyze $local_ref; refusing (fail closed)."
          continue
        fi
        [ -z "$pushed" ] && continue
        # ... and that some private branch has.
        if ! printf '%s\n' "$pushed" >"$tmp/leak-pushed" || ! printf '%s\n' "$private" >"$tmp/leak-private" ||
          ! leaked=$(comm -12 "$tmp/leak-pushed" "$tmp/leak-private"); then
          refuse "could not compare $local_ref with the private commits; refusing (fail closed)."
          continue
        fi
        if [ -n "$leaked" ]; then
          refuse "refusing to push $local_ref -> $remote_ref to $remote_url: it contains $(echo "$leaked" | wc -l) undisclosed private commit(s), e.g.:"
          echo "$leaked" | head -5 | while read -r c; do echo "  $(git log -1 --format='%h %s' "$c")" >&2; done
          continue
        fi
        # Rewritten private work (cherry-pick, amend, rebase, squash) has new
        # commit ids: also refuse commits with the same tree or the same
        # patch-id (git patch-id --stable) as a private commit.
        [ -n "$private" ] || continue
        if ! load_private_signatures || ! rewritten=$(rewritten_private_work "$pushed" "$local_sha"); then
          refuse "could not compute content signatures for $local_ref (git, cache or disk error); refusing (fail closed)."
          continue
        fi
        if [ -n "$rewritten" ]; then
          refuse "refusing to push $local_ref -> $remote_ref to $remote_url: $(echo "$rewritten" | wc -l) commit(s) have the same content (tree or patch) as undisclosed private commits, e.g.:"
          echo "$rewritten" | head -5 | while read -r c; do echo "  $(git log -1 --format='%h %s' "$c")" >&2; done
        fi
      done <<<"$updates"
    fi
  fi
fi

if [ $status != 0 ]; then
  echo "pre-push-guard: to disclose deliberately after the fix is on prod, use src/scripts/security/disclose.sh." >&2
fi
exit $status
