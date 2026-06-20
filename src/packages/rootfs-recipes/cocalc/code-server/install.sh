set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

prefix="${PREFIX:-/opt/code-server}"
version="${VERSION:-latest}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL https://code-server.dev/install.sh -o "$tmp/install-code-server.sh"

args=(--method=standalone --prefix="$prefix")
if [ "$version" != "latest" ] && [ -n "$version" ]; then
  args+=(--version="$version")
fi

$SUDO sh "$tmp/install-code-server.sh" "${args[@]}"

$SUDO ln -sf "$prefix/bin/code-server" /usr/local/bin/code-server
$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix"

code-server --version
