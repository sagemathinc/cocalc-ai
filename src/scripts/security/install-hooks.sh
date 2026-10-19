#!/usr/bin/env bash
# Install pre-push-guard.sh as the pre-push hook of this clone.  Without
# core.hooksPath the hook goes in the clone's common git directory, so it
# covers every worktree of the clone, whatever branch is checked out.  Safe to
# re-run.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if hooks_path=$(git config --get core.hooksPath); then
  echo "install-hooks: core.hooksPath is set to '$hooks_path', so Git would not run a hook installed in the git directory." >&2
  echo "install-hooks: copy $here/pre-push-guard.sh to that directory as pre-push yourself, or unset core.hooksPath." >&2
  exit 1
fi
hooks=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
mkdir -p "$hooks"
target=$hooks/pre-push
if [ -e "$target" ] && ! grep -q "pre-push-guard" "$target"; then
  echo "install-hooks: $target exists and is not pre-push-guard; not overwriting" >&2
  exit 1
fi
cp "$here/pre-push-guard.sh" "$target"
chmod +x "$target"
# Verify that this is the hook Git will run from here.
effective=$(git rev-parse --path-format=absolute --git-path hooks/pre-push)
if [ "$effective" != "$target" ]; then
  echo "install-hooks: installed $target, but Git would run $effective; the guard is NOT active" >&2
  exit 1
fi
echo "installed $target"
