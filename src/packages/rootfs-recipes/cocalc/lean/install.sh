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

toolchain="${TOOLCHAIN:-leanprover/lean4:stable}"
prefix="${PREFIX:-/opt/elan}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends ca-certificates curl git zstd

$SUDO mkdir -p "$prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$prefix"
curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | \
  ELAN_HOME="$prefix" sh -s -- -y --default-toolchain "$toolchain" --no-modify-path

for exe in elan lean lake leanc; do
  if [ -x "$prefix/bin/$exe" ]; then
    $SUDO tee "/usr/local/bin/$exe" >/dev/null <<EOF
#!/usr/bin/env bash
export ELAN_HOME="$prefix"
exec "$prefix/bin/$exe" "\$@"
EOF
    $SUDO chmod 755 "/usr/local/bin/$exe"
  fi
done

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix"
$SUDO rm -rf /var/lib/apt/lists/*
