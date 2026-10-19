#!/usr/bin/env bash
# Disclose private security fixes after they are live on prod.  See README.md.
#
#   disclose.sh <commit> <name> [--release <release-id>] [--yes]
#
# Pushes <commit> (normally the tip of the deployed release branch, so the
# public history has exactly the code that ran on prod) to the public branch
# disclose/<name> and opens a PR into public main.  Without --yes it only
# checks and shows what would be published.
set -euo pipefail

PUBLIC_URL=${COCALC_PUBLIC_URL:-git@github.com:sagemathinc/cocalc-ai.git}
PUBLIC_REPO=${COCALC_PUBLIC_REPO:-sagemathinc/cocalc-ai}
PRIVATE_REPO=${COCALC_PRIVATE_REPO:-sagemathinc/cocalc-ai-private}

die() {
  echo "disclose: $*" >&2
  exit 1
}

commit=${1:-}
name=${2:-}
shift 2 2>/dev/null || die "usage: disclose.sh <commit> <name> [--release <id>] [--yes]"
release=""
yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release)
      release=${2:?}
      shift 2
      ;;
    --yes)
      yes=1
      shift
      ;;
    *) die "unknown option $1" ;;
  esac
done
[[ $name =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid name '$name'"
sha=$(git rev-parse --verify "$commit^{commit}") || die "unknown commit $commit"

git fetch -q "$PUBLIC_URL" refs/heads/main
pub=$(git rev-parse FETCH_HEAD)
if git merge-base --is-ancestor "$sha" "$pub"; then
  echo "$(git rev-parse --short "$sha") is already in public main; nothing to disclose."
  exit 0
fi
git merge-tree --write-tree "$pub" "$sha" >/dev/null ||
  die "$(git rev-parse --short "$sha") does not merge cleanly onto public main; resolve first."

commits=$(git log --format='%h %s' "$pub..$sha")
prs=$(git log --format='%s' "$pub..$sha" | sed -nE 's/^Merge pull request #([0-9]+) from .*/\1/p' | sort -n | uniq | tr '\n' ' ')
echo "Would publish $(echo "$commits" | wc -l) commit(s) not in public main, as disclose/$name:"
echo "$commits" | sed 's/^/  /'
[ -n "$prs" ] && echo "Private PRs: $prs"
if [ $yes != 1 ]; then
  echo "Check that these are live on prod, then re-run with --yes."
  exit 2
fi

body=$(mktemp)
{
  echo "Discloses security fixes developed privately in \`$PRIVATE_REPO\`${release:+, live on prod since release \`$release\`}."
  echo "This branch is the deployed commit $(git rev-parse --short=10 "$sha"). \`#NN\` in its merge commits refers to $PRIVATE_REPO PRs."
  echo
  [ -n "$prs" ] && echo "Private PRs: $(for p in $prs; do printf '#%s ' "$p"; done)" && echo
  echo "Commits:"
  echo '```'
  echo "$commits"
  echo '```'
  echo
  echo "It merges cleanly onto main (git merge-tree). Merging it is the disclosure; no further deploy is needed."
} >"$body"

COCALC_DISCLOSE=1 git push -q "$PUBLIC_URL" "$sha:refs/heads/disclose/$name"
url=$(gh pr create -R "$PUBLIC_REPO" --base main --head "disclose/$name" \
  --title "security: disclose ${release:-$name} fixes${prs:+ (private $(for p in $prs; do printf '#%s ' "$p"; done | sed 's/ $//'))}" \
  --body-file "$body")
rm -f "$body"
gh pr comment "$url" --body "@codex review" >/dev/null || true
echo "$url"
