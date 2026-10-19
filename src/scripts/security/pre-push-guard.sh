#!/usr/bin/env bash
# Git pre-push hook: never push undisclosed private security work to the
# public repository by accident.  See README.md in this directory.
#
# A push to the public repo (github.com/sagemathinc/cocalc-ai) is refused if
#   - a pushed branch is named security/*, ghsa*, or release/*security*, or
#   - it would publish a commit that a private remote has and no public
#     remote has (private remotes: sagemathinc/cocalc-ai-<anything>).
# disclose.sh sets COCALC_DISCLOSE=1 to make the deliberate disclosure push.
#
# Install for every worktree of a clone with install-hooks.sh.

set -uo pipefail

remote_url=${2:-}
is_public_url() {
  [[ $1 =~ github\.com[:/]sagemathinc/cocalc-ai(\.git)?/?$ ]]
}
is_private_url() {
  [[ $1 =~ github\.com[:/]sagemathinc/cocalc-ai-[^/]+$ ]]
}

if ! is_public_url "$remote_url"; then
  exit 0
fi
if [ "${COCALC_DISCLOSE:-0}" = 1 ]; then
  echo "pre-push-guard: COCALC_DISCLOSE=1, allowing a deliberate disclosure push to $remote_url" >&2
  exit 0
fi

public_refs=()
private_refs=()
while read -r name; do
  url=$(git remote get-url "$name" 2>/dev/null || true)
  if is_public_url "$url"; then
    public_refs+=("--remotes=$name")
  elif is_private_url "$url"; then
    private_refs+=("--remotes=$name")
  fi
done < <(git remote)

zero=0000000000000000000000000000000000000000
private_only=""
if [ ${#private_refs[@]} -gt 0 ]; then
  # Commits some private remote has and no public remote has.
  private_only=$(git rev-list "${private_refs[@]}" --not "${public_refs[@]}" 2>/dev/null | sort)
fi

status=0
while read -r local_ref local_sha remote_ref _remote_sha; do
  [ "$local_sha" = "$zero" ] && continue # deleting a remote branch
  branch=${remote_ref#refs/heads/}
  if [[ $branch == security/* || $branch == ghsa* || ($branch == release/* && $branch == *security*) ]]; then
    echo "pre-push-guard: refusing to push '$branch' to the public repo (private branch name)." >&2
    status=1
    continue
  fi
  if [ -n "$private_only" ]; then
    leaked=$(comm -12 <(git rev-list "$local_sha" --not "${public_refs[@]}" 2>/dev/null | sort) <(echo "$private_only"))
    if [ -n "$leaked" ]; then
      echo "pre-push-guard: refusing to push $local_ref -> $remote_ref: it contains $(echo "$leaked" | wc -l) undisclosed private commit(s), e.g.:" >&2
      echo "$leaked" | head -5 | while read -r c; do echo "  $(git log -1 --format='%h %s' "$c")" >&2; done
      status=1
    fi
  fi
done

if [ $status != 0 ]; then
  echo "pre-push-guard: to disclose deliberately after the fix is on prod, use src/scripts/security/disclose.sh." >&2
fi
exit $status
