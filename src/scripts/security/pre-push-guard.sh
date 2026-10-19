#!/usr/bin/env bash
# Git pre-push hook: never publish undisclosed private security work by
# accident.  See README.md in this directory.
#
# Pushes to a known private repository are always allowed: on GitHub,
# sagemathinc/cocalc-ai-private, sagemathinc/cocalc-ai-content-security and
# security-advisory forks sagemathinc/cocalc-ai-ghsa-xxxx-xxxx-xxxx (in any URL
# form), plus any URL listed with `git config --add cocalc.privateUrl <url>`.
# Every other destination (the public repo, forks, other hosts, local paths)
# is refused if
#   - the pushed source or destination branch is a private branch name
#     (security/*, ghsa*, release/*security*), or
#   - it would push a private commit: one on a branch of the private repo, of
#     another private remote or cocalc.privateUrl repo, or of a local
#     private-named branch, that is not on any branch of the public repo.
# All of those branch lists are fetched fresh on every such push.  If a fetch
# fails for a clone that has (or has seen) private work, the push is refused
# (fail closed), except that a secondary private repo GitHub reports as not
# found (deleted) is checked using its cached refs.
# disclose.sh sets COCALC_DISCLOSE=1 to make the deliberate disclosure push.
#
# Install for every worktree of a clone with install-hooks.sh.

set -uo pipefail

PUBLIC_URL=${COCALC_PUBLIC_URL:-git@github.com:sagemathinc/cocalc-ai.git}
PRIVATE_URL=${COCALC_PRIVATE_URL:-git@github.com:sagemathinc/cocalc-ai-private.git}
GUARD_REFS=refs/cocalc-guard

# host/path in lower case, without scheme, user, port, ".git" or slashes at
# the ends.  Handles scp-like (host:path), ssh://host:port/path, https and
# local paths.
normalize_url() {
  local u=${1,,}
  u=${u#*://}
  [[ $u == *@* ]] && u=${u#*@}
  [[ $u != /* ]] && u=${u/:/\/}
  [[ $u =~ ^([^/]+)/[0-9]+/(.*)$ ]] && u="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
  u=${u%/}
  u=${u%.git}
  echo "${u%/}"
}

is_private_url() {
  local u extra
  u=$(normalize_url "$1")
  if [[ $u =~ ^(ssh\.)?github\.com/sagemathinc/cocalc-ai-(private|content-security|ghsa-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$ ]]; then
    return 0
  fi
  while read -r extra; do
    [ -n "$extra" ] && [ "$u" = "$(normalize_url "$extra")" ] && return 0
  done < <(git config --get-all cocalc.privateUrl 2>/dev/null)
  return 1
}

is_private_branch() { # <branch name without refs/heads/>
  [[ $1 == security/* || $1 == ghsa* || ($1 == release/* && $1 == *security*) ]]
}

refuse() {
  echo "pre-push-guard: $*" >&2
  status=1
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

# Branch names first: no network needed.
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ -z "$local_ref" ] && continue
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
  # Dedupe by exact normalized URL; name the ref namespace by its hash, so
  # different URLs never share a namespace.
  local normalized key
  normalized=$(normalize_url "$1")
  key=$(printf '%s' "$normalized" | git hash-object --stdin)
  [[ $seen == *" $key "* ]] && return
  seen+="$key "
  sources+=("$key|$1")
}
add_source "$PRIVATE_URL"
private_key=${sources[0]%%|*}
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

# A clone has private work if it has a private remote, a private-named local
# branch, or private branch lists cached by an earlier run of this guard.
has_private_work=0
if [ ${#private_remote_refs[@]} -gt 0 ] || [ ${#local_private_branches[@]} -gt 0 ] ||
  [ -n "$(git for-each-ref --count=1 "$GUARD_REFS/src/")" ]; then
  has_private_work=1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for source in "${sources[@]}"; do
  key=${source%%|*}
  url=${source#*|}
  (
    git fetch -q --no-tags --prune --no-write-fetch-head "$url" "+refs/heads/*:$GUARD_REFS/src/$key/*" 2>"$tmp/$key.err"
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
  elif [ "$key" != "$private_key" ] && grep -qi "not found" "$tmp/$key.err"; then
    # A deleted repo (e.g. a removed advisory fork) cannot gain commits; its
    # cached guard refs and tracking refs still count as private.
    echo "pre-push-guard: note: $url no longer exists; using its cached refs." >&2
  else
    failed+=("$url")
  fi
done
if [ ${#failed[@]} -gt 0 ] && [ $has_private_work = 1 ]; then
  refuse "cannot fetch ${failed[*]} to check for private commits; refusing (fail closed)."
fi

if [ $has_private_work = 1 ] && [ $status = 0 ]; then
  if ! git fetch -q --no-tags --prune --no-write-fetch-head "$PUBLIC_URL" "+refs/heads/*:$GUARD_REFS/public/*" 2>/dev/null; then
    refuse "cannot fetch $PUBLIC_URL to check what is already public; refusing (fail closed)."
  else
    zero=0000000000000000000000000000000000000000
    if ! private=$(git rev-list --glob="$GUARD_REFS/src/*" "${private_remote_refs[@]}" \
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
        fi
      done <<<"$updates"
    fi
  fi
fi

if [ $status != 0 ]; then
  echo "pre-push-guard: to disclose deliberately after the fix is on prod, use src/scripts/security/disclose.sh." >&2
fi
exit $status
