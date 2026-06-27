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

prefix="${PREFIX:-/opt/cocalc-jupyter}"
python="${PYTHON:-/usr/bin/python3}"
kernel_name="${KERNEL_NAME:-python3}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

packages="${PACKAGES:-ipykernel ipywidgets jupyterlab matplotlib notebook numpy pandas scipy scikit-learn sympy uv jupyter-console}"

if command -v apt-get >/dev/null 2>&1; then
  $SUDO apt-get update
  run_noninteractive apt-get install -y --no-install-recommends python3-venv
fi

$SUDO mkdir -p "$prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$prefix"
$python -m venv --clear "$prefix"
"$prefix/bin/pip" install --no-cache-dir --upgrade pip setuptools wheel
"$prefix/bin/pip" install --no-cache-dir $packages

if [ "${INSTALL_BASH_KERNEL:-true}" = "true" ]; then
  "$prefix/bin/pip" install --no-cache-dir bash_kernel
fi

$SUDO "$prefix/bin/python" -m ipykernel install --prefix=/usr/local --name "$kernel_name"

if [ "${INSTALL_BASH_KERNEL:-true}" = "true" ]; then
  $SUDO "$prefix/bin/python" -m bash_kernel.install --prefix=/usr/local
fi

for exe in python python3; do
  if [ -x "$prefix/bin/python" ]; then
    $SUDO rm -f "/usr/local/bin/$exe"
    $SUDO tee "/usr/local/bin/$exe" >/dev/null <<EOF
#!/usr/bin/env bash
exec "$prefix/bin/python" "\$@"
EOF
    $SUDO chmod 755 "/usr/local/bin/$exe"
  fi
done

for exe in pip pip3 uv jupyter jupyter-lab jupyter-notebook; do
  if [ -x "$prefix/bin/$exe" ]; then
    $SUDO rm -f "/usr/local/bin/$exe"
    $SUDO ln -sf "$prefix/bin/$exe" "/usr/local/bin/$exe"
  fi
done

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix"
