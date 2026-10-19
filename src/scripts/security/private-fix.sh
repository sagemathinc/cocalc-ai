#!/usr/bin/env bash
# Start private security work in sagemathinc/cocalc-ai-private.  See README.md.
#
#   private-fix.sh sync-main            fast-forward private main to public main
#   private-fix.sh start <topic>        new branch security/<topic> from public main,
#                                       pushed to the private repo
#   private-fix.sh integration <name>   new integration branch security/<name> from
#                                       public main, for the private PRs of one release
#   private-fix.sh retire-remote <name> remove the remote of a deleted private repo
#                                       (e.g. a published advisory fork), keeping its
#                                       commits as private for pre-push-guard.sh
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

# Same normalization as pre-push-guard.sh, so namespaces match.
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

retire_remote() { # <remote name>
  local name=$1 url key ref n=0
  url=$(git remote get-url "$name") || die "no remote '$name'"
  key=$(printf '%s' "$(normalize_url "$url")" | git hash-object --stdin)
  while read -r ref; do
    git update-ref "refs/cocalc-guard/retired/$key/${ref#refs/remotes/$name/}" "$ref"
    n=$((n + 1))
  done < <(git for-each-ref --format='%(refname)' "refs/remotes/$name/")
  while read -r ref; do
    git update-ref "refs/cocalc-guard/retired/$key/${ref#refs/cocalc-guard/src/$key/}" "$ref"
    n=$((n + 1))
  done < <(git for-each-ref --format='%(refname)' "refs/cocalc-guard/src/$key/")
  git remote remove "$name"
  echo "retired remote $name ($url): kept $n ref(s) under refs/cocalc-guard/retired/$key/ as private"
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
  retire-remote)
    [ -n "${2:-}" ] || die "usage: private-fix.sh retire-remote <name>"
    retire_remote "$2"
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
