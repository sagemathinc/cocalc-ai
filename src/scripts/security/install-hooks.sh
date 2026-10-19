#!/usr/bin/env bash
# Install pre-push-guard.sh as the pre-push hook of this clone.  Without
# core.hooksPath the hook goes in the clone's common git directory, so it
# covers every worktree of the clone, whatever branch is checked out.  Safe to
# re-run: it replaces only a hook that this script installed (marked by
# MARKER on line 2), never another hook, even one that calls the guard.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MARKER="# installed by src/scripts/security/install-hooks.sh; re-run it to update; do not edit"
hooks_path_refuse() {
  echo "install-hooks: core.hooksPath is set ($1), so Git would not run a hook installed in the git directory there." >&2
  echo "install-hooks: add $here/pre-push-guard.sh to that hooks directory yourself, or unset core.hooksPath." >&2
  exit 1
}
# core.hooksPath anywhere it could apply: the effective config of every
# worktree (covers per-worktree config and conditions true there) ...
while read -r line; do
  case $line in worktree\ *) wt=${line#worktree } ;; *) continue ;; esac
  if hp=$(git -C "$wt" config --get core.hooksPath); then hooks_path_refuse "'$hp' in worktree $wt"; fi
done < <(git worktree list --porcelain)
# ... and any include/includeIf target that sets it, whatever its condition
# (e.g. includeIf.onbranch:security/**), since a later checkout could activate it.
while read -r origin key value; do
  file=${value/#\~/$HOME}
  case $file in /*) ;; *) file="$(dirname "${origin#file:}")/$file" ;; esac
  [ -e "$file" ] || continue
  if hp=$(git config --file "$file" --get core.hooksPath); then hooks_path_refuse "'$hp' via $key -> $file"; fi
  if git config --file "$file" --get-regexp '^include(if\..*)?\.path$' >/dev/null; then
    echo "install-hooks: $file (via $key) has nested includes; cannot verify core.hooksPath. Refusing." >&2
    exit 1
  fi
done < <(git config --show-origin --get-regexp '^include(if\..*)?\.path$')
hooks=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
mkdir -p "$hooks"
target=$hooks/pre-push
if [ -e "$target" ] && [ "$(sed -n 2p "$target")" != "$MARKER" ]; then
  echo "install-hooks: $target exists and was not installed by this script; not overwriting." >&2
  echo "install-hooks: call $here/pre-push-guard.sh from it (passing \$1 \$2 and stdin), or remove it and re-run." >&2
  exit 1
fi
tmp=$(mktemp "$hooks/.pre-push.XXXXXX")
{
  sed -n 1p "$here/pre-push-guard.sh"
  echo "$MARKER"
  sed 1d "$here/pre-push-guard.sh"
} >"$tmp"
chmod +x "$tmp"
mv "$tmp" "$target"
# Verify that this is the hook Git will run from here.
effective=$(git rev-parse --path-format=absolute --git-path hooks/pre-push)
if [ "$effective" != "$target" ]; then
  echo "install-hooks: installed $target, but Git would run $effective; the guard is NOT active" >&2
  exit 1
fi
echo "installed $target"
