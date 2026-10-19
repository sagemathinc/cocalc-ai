#!/usr/bin/env bash
# Start private security work in sagemathinc/cocalc-ai-private.  See README.md.
#
#   private-fix.sh sync-main            fast-forward private main to public main
#   private-fix.sh start <topic>        new branch security/<topic> from public main,
#                                       pushed to the private repo
#   private-fix.sh integration <name>   new integration branch security/<name> from
#                                       public main, for the private PRs of one release
#
# Pushes to the private repo use its explicit URL, because local clones keep
# the "private" remote's push URL disabled on purpose.
set -euo pipefail

PUBLIC_URL=${COCALC_PUBLIC_URL:-git@github.com:sagemathinc/cocalc-ai.git}
PRIVATE_URL=${COCALC_PRIVATE_URL:-git@github.com:sagemathinc/cocalc-ai-private.git}

die() {
  echo "private-fix: $*" >&2
  exit 1
}

fetch_sha() { # <url> <branch>
  git fetch -q "$1" "refs/heads/$2" && git rev-parse FETCH_HEAD
}

sync_main() {
  local pub priv
  pub=$(fetch_sha "$PUBLIC_URL" main)
  priv=$(fetch_sha "$PRIVATE_URL" main)
  if [ "$pub" = "$priv" ]; then
    echo "private main is already public main ($(git rev-parse --short "$pub"))"
  elif git merge-base --is-ancestor "$priv" "$pub"; then
    git push -q "$PRIVATE_URL" "$pub:refs/heads/main"
    echo "private main fast-forwarded $(git rev-parse --short "$priv") -> $(git rev-parse --short "$pub")"
  else
    die "private main $(git rev-parse --short "$priv") has commits that public main lacks; private main must only mirror public main. Investigate before continuing."
  fi
  PUBLIC_MAIN=$pub
}

new_branch() { # <branch>
  local branch=$1
  [[ $branch =~ ^security/[A-Za-z0-9._/-]+$ ]] || die "invalid branch name '$branch'"
  if git ls-remote --exit-code --heads "$PRIVATE_URL" "$branch" >/dev/null; then
    die "$branch already exists in the private repo"
  fi
  sync_main
  git switch -c "$branch" "$PUBLIC_MAIN"
  git push -q "$PRIVATE_URL" "$branch:refs/heads/$branch"
  echo "created $branch from public main $(git rev-parse --short "$PUBLIC_MAIN") in the private repo"
}

case "${1:-}" in
  sync-main)
    sync_main
    ;;
  start)
    [ -n "${2:-}" ] || die "usage: private-fix.sh start <topic>"
    new_branch "security/$2"
    echo "Next: commit the fix, push it with: git push $PRIVATE_URL security/$2"
    echo "then open a PR in sagemathinc/cocalc-ai-private against the release's integration branch."
    ;;
  integration)
    [ -n "${2:-}" ] || die "usage: private-fix.sh integration <name>"
    new_branch "security/$2"
    echo "Point this release's private PRs at security/$2; merge it into the release branch to build."
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
