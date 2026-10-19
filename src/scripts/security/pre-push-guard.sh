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
#   - or a commit with the same tree or patch-id as such a private commit
#     (rewritten private work: cherry-pick, amend, rebase, squash).
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

# Patch-ids of the given commits (stdin, one per line) as "<oid> <patch-id>",
# "-" for commits without a patch (merges, empty).  Cached by commit id in the
# common git dir, since a commit's patch-id never changes.
patch_ids() {
  local cache want missing
  cache=$(git rev-parse --path-format=absolute --git-common-dir)/cocalc-guard-patch-ids
  touch "$cache"
  want=$(sort -u)
  [ -n "$want" ] || return 0
  missing=$(comm -23 <(echo "$want") <(awk '{ print $1 }' "$cache" | sort -u))
  if [ -n "$missing" ]; then
    git log --no-walk -p --no-merges --format='commit %H' --stdin <<<"$missing" | git patch-id --stable |
      awk '{ print $2, $1 }' >"$tmp/new-patch-ids"
    {
      cat "$tmp/new-patch-ids"
      comm -23 <(echo "$missing") <(awk '{ print $1 }' "$tmp/new-patch-ids" | sort -u) | awk '{ print $1, "-" }'
    } >>"$cache"
  fi
  awk 'NR == FNR { w[$1] = 1; next } ($1 in w) { print }' <(echo "$want") "$cache" | sort -u -k1,1
}

# Trees and patch-ids of the private commits ($private), computed once per run,
# minus those of public commits since the oldest private commit (content that
# was already disclosed under other commit ids, e.g. by a squash or rebase).
# Private commits that change nothing relative to their first parent (merges,
# empty commits) contribute no tree.
load_private_signatures() {
  [ -e "$tmp/private-trees" ] && return
  local oldest
  git log --no-walk --format='%H %T %P %ct' --stdin <<<"$private" >"$tmp/private-commits"
  awk '{ print $3 }' "$tmp/private-commits" | grep -E '^[0-9a-f]{40}$' | sort -u |
    git log --no-walk --format='%H %T' --stdin >"$tmp/parent-trees" 2>/dev/null
  awk 'NR == FNR { pt[$1] = $2; next } !($3 in pt) || pt[$3] != $2 { print $2 }' \
    "$tmp/parent-trees" "$tmp/private-commits" | sort -u >"$tmp/private-trees-all"
  oldest=$(awk '{ print $NF }' "$tmp/private-commits" | sort -n | head -1)
  git rev-list --glob="$GUARD_REFS/public/*" --since=$((oldest - 86400)) >"$tmp/public-window"
  git log --no-walk --format='%T' --stdin <"$tmp/public-window" | sort -u >"$tmp/public-trees"
  comm -23 "$tmp/private-trees-all" "$tmp/public-trees" >"$tmp/private-trees"
  patch_ids <"$tmp/public-window" | awk '$2 != "-" { print $2 }' | sort -u >"$tmp/public-patch-ids"
  patch_ids <<<"$private" | awk '$2 != "-" { print $2 }' | sort -u |
    comm -23 - "$tmp/public-patch-ids" >"$tmp/private-patch-ids"
}

remote_url=${2:-}
if is_private_url "$remote_url"; then
  exit 0
fi
if [ "${COCALC_DISCLOSE:-0}" = 1 ]; then
  echo "pre-push-guard: COCALC_DISCLOSE=1, allowing a deliberate disclosure push to $remote_url" >&2
  exit 0
fi

status=0
updates=$(cat)

zero=0000000000000000000000000000000000000000

# Deletions publish nothing; a push that only deletes branches (e.g. removing
# an accidentally pushed private branch) is allowed without any analysis.
if ! awk -v z="$zero" 'NF && $2 != z { found = 1 } END { exit !found }' <<<"$updates"; then
  exit 0
fi

# Branch names first: no network needed.  Deletions publish nothing, and
# deleting an accidentally pushed private branch must work.
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ -z "$local_ref" ] && continue
  [ "$local_sha" = "$zero" ] && continue
  for ref in "$local_ref" "$remote_ref"; do
    if [[ $ref == refs/heads/* ]] && is_private_branch "${ref#refs/heads/}"; then
      refuse "refusing to push $local_ref -> $remote_ref to $remote_url: '${ref#refs/heads/}' is a private branch name."
    fi
  done
done <<<"$updates"

# Sources of private commits: the private repo, every private remote and every
# cocalc.privateUrl, fetched fresh (in parallel) into $GUARD_REFS/src/<key>/*,
# plus the private remotes' tracking refs and local private-named branches.
sources=()
seen=" "
add_source() { # <url>
  # Dedupe by exact URL; the ref namespace is the hash of that URL, so
  # different URLs never share a namespace.
  local key
  key=$(url_key "$1")
  [[ $seen == *" $key "* ]] && return
  seen+="$key "
  sources+=("$key|$1")
}
add_source "$PRIVATE_URL"
private_remote_refs=()
while read -r name; do
  [ -z "$name" ] && continue
  url=$(git remote get-url "$name" 2>/dev/null || true)
  if [ -n "$url" ] && is_private_url "$url"; then
    private_remote_refs+=("--remotes=$name")
    add_source "$url"
  fi
done < <(git remote)
while read -r extra; do
  [ -n "$extra" ] && add_source "$extra"
done < <(git config --get-all cocalc.privateUrl 2>/dev/null)
local_private_branches=()
while read -r ref; do
  is_private_branch "${ref#refs/heads/}" && local_private_branches+=("$ref")
done < <(git for-each-ref --format='%(refname)' refs/heads)
# Private-named tracking branches of ANY remote (refs/remotes/<remote>/security/*
# etc.) are private too, even if the remote has no URL or an unrecognized one.
while read -r ref; do
  rest=${ref#refs/remotes/}
  is_private_branch "${rest#*/}" && local_private_branches+=("$ref")
done < <(git for-each-ref --format='%(refname)' refs/remotes)

# A clone has private work if it has a private remote, a cocalc.privateUrl,
# a private-named local or tracking branch, retired private refs, or private
# branch lists cached by an earlier run of this guard.
has_private_work=0
if [ ${#private_remote_refs[@]} -gt 0 ] || [ ${#local_private_branches[@]} -gt 0 ] ||
  [ -n "$(git config --get-all cocalc.privateUrl 2>/dev/null)" ] ||
  [ -n "$(git for-each-ref --count=1 "$GUARD_REFS/src/" "$GUARD_REFS/retired/" "$GUARD_REFS/seen/")" ]; then
  has_private_work=1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
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
  if [ "$(cat "$tmp/$key.rc" 2>/dev/null)" = 0 ]; then
    has_private_work=1
  else
    failed+=("$url")
  fi
done
# Private refs are never pruned, and every private tip ever seen is archived by
# object id, so deleting or force-pushing a private branch early cannot erase
# the evidence.  (Commits that later become public are subtracted below.)
if ! git for-each-ref --format="update $GUARD_REFS/seen/%(objectname) %(objectname)" \
  "$GUARD_REFS/src/" "$GUARD_REFS/retired/" | sort -u | git update-ref --stdin; then
  refuse "could not archive private tips under $GUARD_REFS/seen; refusing (fail closed)."
fi
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
        # Commits this push would add that are not already public ...
        if ! pushed=$(git rev-list "$local_sha" --not --glob="$GUARD_REFS/public/*" | sort); then
          refuse "could not analyze $local_ref; refusing (fail closed)."
          continue
        fi
        [ -z "$pushed" ] && continue
        # ... and that some private branch has.
        leaked=$(comm -12 <(echo "$pushed") <(echo "$private"))
        if [ -n "$leaked" ]; then
          refuse "refusing to push $local_ref -> $remote_ref to $remote_url: it contains $(echo "$leaked" | wc -l) undisclosed private commit(s), e.g.:"
          echo "$leaked" | head -5 | while read -r c; do echo "  $(git log -1 --format='%h %s' "$c")" >&2; done
          continue
        fi
        # Rewritten private work (cherry-pick, amend, rebase, squash) has new
        # commit ids: also refuse commits with the same tree or the same
        # patch-id (git patch-id --stable) as a private commit.
        [ -n "$private" ] || continue
        load_private_signatures
        rewritten=$(
          git log --no-walk --format='%T %H' --stdin <<<"$pushed" | awk 'NR == FNR { t[$1] = 1; next } ($1 in t) { print $2 }' "$tmp/private-trees" -
          git log --no-walk -p --no-merges --format='commit %H' --stdin <<<"$pushed" | git patch-id --stable |
            awk 'NR == FNR { p[$1] = 1; next } ($1 in p) { print $2 }' "$tmp/private-patch-ids" -
        )
        if [ -n "$rewritten" ]; then
          rewritten=$(echo "$rewritten" | sort -u)
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
