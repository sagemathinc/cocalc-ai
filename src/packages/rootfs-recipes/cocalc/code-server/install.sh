set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

run_noninteractive() {
  if [ -n "$SUDO" ]; then
    $SUDO env DEBIAN_FRONTEND=noninteractive "$@"
  else
    DEBIAN_FRONTEND=noninteractive "$@"
  fi
}

prefix="${PREFIX:-/opt/code-server}"
version="${VERSION:-latest}"
extensions="${EXTENSIONS:-}"
extensions_dir="${EXTENSIONS_DIR:-/opt/code-server/extensions}"
user_data_dir="${USER_DATA_DIR:-/opt/code-server/user-data}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl tar

curl -fsSL https://code-server.dev/install.sh -o "$tmp/install-code-server.sh"

args=(--method=standalone --prefix="$prefix")
if [ "$version" != "latest" ] && [ -n "$version" ]; then
  args+=(--version="$version")
fi

if [ -n "$SUDO" ]; then
  $SUDO env -u VERSION sh "$tmp/install-code-server.sh" "${args[@]}"
else
  env -u VERSION sh "$tmp/install-code-server.sh" "${args[@]}"
fi

$SUDO ln -sf "$prefix/bin/code-server" /usr/local/bin/code-server
$SUDO mkdir -p "$extensions_dir" "$user_data_dir"
$SUDO chown -R "$(id -u):$(id -g)" "$extensions_dir" "$user_data_dir"

if [ -n "$extensions" ]; then
  for extension in $extensions; do
    code-server \
      --extensions-dir "$extensions_dir" \
      --user-data-dir "$user_data_dir" \
      --install-extension "$extension"
  done
fi

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chown -R "$owner_uid:$owner_gid" "$extensions_dir" "$user_data_dir"
$SUDO chmod -R u+rwX,go+rX "$prefix"
$SUDO chmod -R u+rwX,go+rX "$extensions_dir" "$user_data_dir"
$SUDO rm -rf /var/lib/apt/lists/*

code-server --version
