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
cannot_verify() {
  echo "install-hooks: cannot verify core.hooksPath ($1); refusing." >&2
  exit 1
}
tmpdir=$(mktemp -d) || cannot_verify "no temporary directory"
hook_tmp=""
trap 'rm -rf "$tmpdir"; [ -z "$hook_tmp" ] || rm -f "$hook_tmp"' EXIT
# core.hooksPath value from a git config command, if set: rc 0 = set (value on
# stdout), 1 = not set; any other status cannot be verified.
check_hooks_path() { # <description> <git config args...>
  local what=$1 hp rc=0
  shift
  hp=$(git "$@" --get core.hooksPath) || rc=$?
  case $rc in
    0) hooks_path_refuse "'$hp' $what" ;;
    1) ;;
    *) cannot_verify "reading $what failed" ;;
  esac
}
# core.hooksPath anywhere it could apply: the effective config of every
# worktree (covers per-worktree config and conditions true there) ...
git worktree list --porcelain >"$tmpdir/worktrees" || cannot_verify "git worktree list failed"
while read -r line; do
  case $line in worktree\ *) wt=${line#worktree } ;; *) continue ;; esac
  check_hooks_path "in worktree $wt" -C "$wt" config
done <"$tmpdir/worktrees"
# ... and every include/includeIf target, whatever its condition (e.g.
# includeIf.onbranch:security/**), since a later checkout could activate it.
# A target that is missing or unreadable now could be created later: refuse.
rc=0
git config -z --show-origin --get-regexp '^include(if\..*)?\.path$' >"$tmpdir/includes" || rc=$?
[ $rc = 0 ] || [ $rc = 1 ] || cannot_verify "listing include paths failed"
# NUL-separated entries: "<origin>\0<key>\n<value>\0" (paths may contain spaces).
while IFS= read -r -d '' origin && IFS= read -r -d '' entry; do
  key=${entry%%$'\n'*}
  value=${entry#*$'\n'}
  file=${value/#\~/$HOME}
  case $file in /*) ;; *) file="$(dirname "${origin#file:}")/$file" ;; esac
  [ -f "$file" ] && [ -r "$file" ] || cannot_verify "$key -> $file is missing or unreadable"
  check_hooks_path "via $key -> $file" config --file "$file"
  rc=0
  git config --file "$file" --get-regexp '^include(if\..*)?\.path$' >/dev/null || rc=$?
  case $rc in
    0) cannot_verify "$file (via $key) has nested includes" ;;
    1) ;;
    *) cannot_verify "reading $file (via $key) failed" ;;
  esac
done <"$tmpdir/includes"
hooks=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
mkdir -p "$hooks"
target=$hooks/pre-push
if [ -e "$target" ] && [ "$(sed -n 2p "$target")" != "$MARKER" ]; then
  echo "install-hooks: $target exists and was not installed by this script; not overwriting." >&2
  echo "install-hooks: call $here/pre-push-guard.sh from it (passing \$1 \$2 and stdin), or remove it and re-run." >&2
  exit 1
fi
hook_tmp=$(mktemp "$hooks/.pre-push.XXXXXX")
{
  sed -n 1p "$here/pre-push-guard.sh"
  echo "$MARKER"
  sed 1d "$here/pre-push-guard.sh"
} >"$hook_tmp"
chmod +x "$hook_tmp"
mv "$hook_tmp" "$target"
hook_tmp=""
# Verify that this is the hook Git will run from here.
effective=$(git rev-parse --path-format=absolute --git-path hooks/pre-push)
if [ "$effective" != "$target" ]; then
  echo "install-hooks: installed $target, but Git would run $effective; the guard is NOT active" >&2
  exit 1
fi
echo "installed $target"
