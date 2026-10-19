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
#     another private remote, or of a local private-named branch, that is not
#     on any branch of the public repo.
# Branch lists are fetched fresh from GitHub on every such push.  If the
# private fetch fails for a clone that has (or has seen) private work, the push
# is refused (fail closed).
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

# Sources of private commits.
private_remote_refs=()
while read -r name; do
  [ -z "$name" ] && continue
  url=$(git remote get-url "$name" 2>/dev/null || true)
  if [ -n "$url" ] && is_private_url "$url"; then
    private_remote_refs+=("--remotes=$name")
  fi
done < <(git remote)
local_private_branches=()
while read -r ref; do
  is_private_branch "${ref#refs/heads/}" && local_private_branches+=("$ref")
done < <(git for-each-ref --format='%(refname)' refs/heads)

# A clone has private work if it has a private remote, a private-named local
# branch, or private branch lists cached by an earlier run of this guard.
has_private_work=0
if [ ${#private_remote_refs[@]} -gt 0 ] || [ ${#local_private_branches[@]} -gt 0 ] ||
  [ -n "$(git for-each-ref --count=1 "$GUARD_REFS/private/")" ]; then
  has_private_work=1
fi

if git fetch -q --no-tags --prune "$PRIVATE_URL" "+refs/heads/*:$GUARD_REFS/private/*" 2>/dev/null; then
  has_private_work=1
elif [ $has_private_work = 1 ]; then
  refuse "cannot fetch $PRIVATE_URL to check for private commits; refusing (fail closed)."
fi

if [ $has_private_work = 1 ] && [ $status = 0 ]; then
  if ! git fetch -q --no-tags --prune "$PUBLIC_URL" "+refs/heads/*:$GUARD_REFS/public/*" 2>/dev/null; then
    refuse "cannot fetch $PUBLIC_URL to check what is already public; refusing (fail closed)."
  else
    zero=0000000000000000000000000000000000000000
    if ! private=$(git rev-list --glob="$GUARD_REFS/private/*" "${private_remote_refs[@]}" \
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
