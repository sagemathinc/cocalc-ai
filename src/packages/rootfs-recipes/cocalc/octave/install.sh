set -Eeuo pipefail

# Merge stderr into stdout: the build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1
trap 'echo ">> wrapper FAILED at line $LINENO: $BASH_COMMAND"' ERR

# Thin wrapper. The actual Octave build, the package installation, the Jupyter
# kernel registration and the test fixtures live in a separate repository, so
# they stay ordinary shell files and real fixtures rather than heredocs
# embedded in a recipe. This module only clones that repository at a pinned ref
# and hands over, passing the recipe inputs through as environment variables.

repo_url="${REPO_URL:?repo_url input is required}"
repo_ref="${REPO_REF:?repo_ref input is required}"
script="${SCRIPT:-install.sh}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

# git is needed before anything can be fetched, so it cannot come from the
# cloned repository's own dependency handling.
if ! command -v git >/dev/null; then
  echo ">> installing git"
  $SUDO apt-get update
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates
  $SUDO apt-get clean
  $SUDO rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
fi

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT

# Fetch by explicit ref rather than `clone --branch`, so a branch, a tag or a
# full commit sha all work. Depth 1 keeps this to a few hundred kB.
echo ">> fetching $repo_url at $repo_ref"
git -C "$checkout" init -q
git -C "$checkout" remote add origin "$repo_url"
git -C "$checkout" fetch -q --depth 1 origin "$repo_ref"
git -C "$checkout" checkout -q FETCH_HEAD
echo ">> using $(git -C "$checkout" rev-parse --short HEAD) from $repo_ref"

exec bash "$checkout/$script"
