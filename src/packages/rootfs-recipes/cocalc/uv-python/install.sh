set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

prefix="${PREFIX:-/opt/cocalc-uv-python}"
python="${PYTHON:-/usr/bin/python3}"
kernel_name="${KERNEL_NAME:-python3}"
packages="${PACKAGES:-ipykernel ipywidgets jupyterlab notebook numpy pandas matplotlib scipy sympy uv jupyter-console}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl python3 python3-venv python3-pip

$SUDO mkdir -p "$prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$prefix"
"$python" -m venv --clear "$prefix"
"$prefix/bin/pip" install --no-cache-dir --upgrade pip setuptools wheel
"$prefix/bin/pip" install --no-cache-dir $packages
$SUDO "$prefix/bin/python" -m ipykernel install --prefix=/usr/local --name "$kernel_name"

for exe in python python3; do
  $SUDO tee "/usr/local/bin/$exe" >/dev/null <<EOF
#!/usr/bin/env bash
exec "$prefix/bin/python" "\$@"
EOF
  $SUDO chmod 755 "/usr/local/bin/$exe"
done

for exe in pip pip3 uv jupyter jupyter-lab jupyter-notebook; do
  if [ -x "$prefix/bin/$exe" ]; then
    $SUDO ln -sf "$prefix/bin/$exe" "/usr/local/bin/$exe"
  fi
done

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix"
$SUDO rm -rf /var/lib/apt/lists/*
