set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

method="${METHOD:-auto}"
prefix="${PREFIX:-/opt/sagemath}"
micromamba_prefix="${MICROMAMBA_PREFIX:-/opt/micromamba}"
conda_packages="${CONDA_PACKAGES:-sage}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
if [ "$method" = "apt" ] || { [ "$method" = "auto" ] && apt-cache policy sagemath | grep -q 'Candidate: [^(]'; }; then
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES:?packages are required}
  $SUDO rm -rf /var/lib/apt/lists/*
  exit 0
fi

if [ "$method" != "auto" ] && [ "$method" != "micromamba" ]; then
  echo "unknown SageMath install method: $method" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  x86_64) mamba_arch="linux-64" ;;
  aarch64|arm64) mamba_arch="linux-aarch64" ;;
  *) echo "unsupported architecture for micromamba: $arch" >&2; exit 1 ;;
esac

$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  bzip2 ca-certificates curl tar

$SUDO mkdir -p "$micromamba_prefix/bin" "$prefix"
tmp="$(mktemp -d)"
curl -fsSL "https://micro.mamba.pm/api/micromamba/${mamba_arch}/latest" | tar -xvj -C "$tmp" bin/micromamba
$SUDO install -m 755 "$tmp/bin/micromamba" "$micromamba_prefix/bin/micromamba"
rm -rf "$tmp"

$SUDO chown -R "$(id -u):$(id -g)" "$prefix" "$micromamba_prefix"
"$micromamba_prefix/bin/micromamba" create -y -p "$prefix" -c conda-forge $conda_packages

$SUDO tee /usr/local/bin/sage >/dev/null <<EOF
#!/usr/bin/env bash
exec "$micromamba_prefix/bin/micromamba" run -p "$prefix" sage "\$@"
EOF
$SUDO chmod 755 /usr/local/bin/sage

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix" "$micromamba_prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix" "$micromamba_prefix"
$SUDO rm -rf /var/lib/apt/lists/*
