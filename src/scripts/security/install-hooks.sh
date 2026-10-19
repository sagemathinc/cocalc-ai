#!/usr/bin/env bash
# Install pre-push-guard.sh as the pre-push hook of this clone.  The hook goes
# in the clone's common git directory, so it covers every worktree of the
# clone, whatever branch is checked out.  Safe to re-run.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
hooks=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
mkdir -p "$hooks"
target=$hooks/pre-push
if [ -e "$target" ] && ! grep -q "pre-push-guard" "$target"; then
  echo "install-hooks: $target exists and is not pre-push-guard; not overwriting" >&2
  exit 1
fi
cp "$here/pre-push-guard.sh" "$target"
chmod +x "$target"
echo "installed $target"
