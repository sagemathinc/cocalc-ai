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

method="${METHOD:-source}"
version="${VERSION:-10.9}"
source_url="${SOURCE_URL:-https://github.com/sagemath/sage.git}"
prefix="${PREFIX:-/usr/local/sage}"
build_dir="${BUILD_DIR:-/tmp/cocalc-sagemath-build}"
jobs="${JOBS:-auto}"
clean_build_dir="${CLEAN_BUILD_DIR:-true}"
install_recommended_apt_packages="${INSTALL_RECOMMENDED_APT_PACKAGES:-true}"
install_sagetex="${INSTALL_SAGETEX:-true}"
micromamba_prefix="${MICROMAMBA_PREFIX:-/opt/micromamba}"
conda_packages="${CONDA_PACKAGES:-sage}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

log() {
  echo "[cocalc/sagemath] $*"
}

write_exec_wrapper() {
  local target="$1"
  local command="$2"
  $SUDO mkdir -p "$(dirname "$target")"
  # Replace the path itself instead of following an existing symlink into the
  # base image, e.g. /usr/local/bin/python -> /opt/cocalc-jupyter/bin/python.
  $SUDO rm -f "$target"
  $SUDO tee "$target" >/dev/null <<EOF
#!/usr/bin/env bash
exec $command "\$@"
EOF
  $SUDO chmod 755 "$target"
}

link_executable() {
  local source="$1"
  local target="$2"
  if [ -x "$source" ]; then
    $SUDO rm -f "$target"
    $SUDO ln -s "$source" "$target"
  fi
}

pin_python_venv_link() {
  local python_path="$1"
  local target
  local resolved
  if [ ! -L "$python_path" ]; then
    return
  fi
  target="$(readlink "$python_path")"
  case "$target" in
    /usr/local/bin/python | /usr/local/bin/python3 | /usr/local/bin/python3.*)
      resolved="$(readlink -f "$python_path")"
      if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then
        echo "Cannot resolve Sage Python link: $python_path -> $target" >&2
        exit 1
      fi
      log "Retargeting Sage Python venv link ${python_path} from ${target} to ${resolved}"
      $SUDO rm -f "$python_path"
      $SUDO ln -s "$resolved" "$python_path"
      ;;
  esac
}

apt_install_available() {
  local packages=()
  local package
  for package in "$@"; do
    if apt-cache show "$package" >/dev/null 2>&1; then
      packages+=("$package")
    else
      log "Skipping unavailable apt package: $package"
    fi
  done
  if [ "${#packages[@]}" -gt 0 ]; then
    run_noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
  fi
}

install_apt_sage() {
  $SUDO apt-get update
  run_noninteractive apt-get install -y --no-install-recommends ${PACKAGES:?packages are required}
  $SUDO rm -rf /var/lib/apt/lists/*
}

install_micromamba_sage() {
  local arch
  local mamba_arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64) mamba_arch="linux-64" ;;
    aarch64 | arm64) mamba_arch="linux-aarch64" ;;
    *)
      echo "unsupported architecture for micromamba: $arch" >&2
      exit 1
      ;;
  esac

  $SUDO apt-get update
  apt_install_available bzip2 ca-certificates curl tar

  $SUDO mkdir -p "$micromamba_prefix/bin" "$prefix"
  tmp="$(mktemp -d)"
  curl -fsSL "https://micro.mamba.pm/api/micromamba/${mamba_arch}/latest" | tar -xvj -C "$tmp" bin/micromamba
  $SUDO install -m 755 "$tmp/bin/micromamba" "$micromamba_prefix/bin/micromamba"
  rm -rf "$tmp"

  $SUDO chown -R "$(id -u):$(id -g)" "$prefix" "$micromamba_prefix"
  "$micromamba_prefix/bin/micromamba" create -y -p "$prefix" -c conda-forge $conda_packages

  write_exec_wrapper /usr/local/bin/sage "\"$micromamba_prefix/bin/micromamba\" run -p \"$prefix\" sage"

  $SUDO chown -R "$owner_uid:$owner_gid" "$prefix" "$micromamba_prefix"
  $SUDO chmod -R u+rwX,go+rX "$prefix" "$micromamba_prefix"
  $SUDO rm -rf /var/lib/apt/lists/*
}

install_source_sage() {
  local make_jobs
  local sage_bin
  local sage_python
  local sage_python_bin

  log "Installing build dependencies"
  $SUDO apt-get update
  if [ "$install_recommended_apt_packages" = "true" ]; then
    apt_install_available \
      autoconf \
      automake \
      bash \
      bison \
      build-essential \
      ca-certificates \
      cmake \
      curl \
      dpkg-dev \
      file \
      flex \
      g++ \
      gfortran \
      git \
      graphviz \
      libbz2-dev \
      libboost-all-dev \
      libreadline-dev \
      libssl-dev \
      libtool \
      m4 \
      make \
      patch \
      perl \
      pkg-config \
      python3 \
      python3-pip \
      python3-setuptools \
      python3-venv \
      python3-wheel \
      rsync \
      sudo \
      tachyon \
      tar \
      xz-utils \
      zlib1g-dev
  fi

  if [ "$jobs" = "auto" ]; then
    make_jobs="$(nproc 2>/dev/null || echo 2)"
  else
    make_jobs="$jobs"
  fi

  log "Fetching SageMath ${version} from ${source_url}"
  $SUDO rm -rf "$build_dir"
  mkdir -p "$build_dir"
  git clone --depth 1 --branch "$version" "$source_url" "$build_dir/sage"

  log "Moving source tree into ${prefix}"
  $SUDO rm -rf "$prefix"
  $SUDO mkdir -p "$(dirname "$prefix")"
  $SUDO mv "$build_dir/sage" "$prefix"
  $SUDO chown -R "$(id -u):$(id -g)" "$prefix"

  export SAGE_FAT_BINARY="yes"
  export SAGE_INSTALL_GCC="no"
  export MAKE="make -j${make_jobs}"

  log "Configuring SageMath source build"
  cd "$prefix"
  make configure
  ./configure --enable-build-as-root

  log "Building SageMath with ${make_jobs} jobs"
  make

  sage_bin="$prefix/sage"
  sage_python="$("$sage_bin" -python -c 'import sys; print(sys.executable)')"
  if [ ! -x "$sage_python" ]; then
    echo "Sage Python is not executable: $sage_python" >&2
    exit 1
  fi
  pin_python_venv_link "$sage_python"
  sage_python_bin="$(dirname "$sage_python")"

  log "Installing Jupyter packages into Sage Python"
  "$sage_python" -m pip install --no-cache-dir --upgrade pip setuptools wheel
  "$sage_python" -m pip install --no-cache-dir \
    ipykernel \
    jupyter-console \
    jupyterlab \
    notebook

  log "Installing SageMath entry points"
  write_exec_wrapper /usr/local/bin/sage "\"$sage_bin\""
  write_exec_wrapper /usr/local/bin/sagemath "\"$sage_bin\""
  write_exec_wrapper /usr/local/bin/python "\"$sage_python\""
  write_exec_wrapper /usr/local/bin/python3 "\"$sage_python\""
  write_exec_wrapper /usr/local/bin/pip "\"$sage_python\" -m pip"
  write_exec_wrapper /usr/local/bin/pip3 "\"$sage_python\" -m pip"

  for executable in jupyter jupyter-lab jupyter-notebook jupyter-console ipython; do
    link_executable "$sage_python_bin/$executable" "/usr/local/bin/$executable"
  done

  log "Installing Python Jupyter kernel"
  $SUDO "$sage_python" -m ipykernel install --prefix=/usr/local --name python3 --display-name "Python 3 (Sage)"

  log "Installing Sage Jupyter kernel"
  if ! $SUDO "$sage_python" - <<'PY'
from sage.repl.ipython_kernel.install import SageKernelSpec

SageKernelSpec.update(prefix="/usr/local")
PY
  then
    log "Sage kernel installer API failed; trying to copy an existing kernelspec"
    for kernel in "$prefix"/local/var/lib/sage/*/share/jupyter/kernels/sagemath; do
      if [ -d "$kernel" ]; then
        $SUDO rm -rf /usr/local/share/jupyter/kernels/sagemath
        $SUDO mkdir -p /usr/local/share/jupyter/kernels
        $SUDO cp -a "$kernel" /usr/local/share/jupyter/kernels/
        break
      fi
    done
  fi
  if [ ! -f /usr/local/share/jupyter/kernels/sagemath/kernel.json ]; then
    for kernel in "$prefix"/local/var/lib/sage/*/share/jupyter/kernels/sagemath "$HOME"/.local/share/jupyter/kernels/sagemath /root/.local/share/jupyter/kernels/sagemath; do
      if [ -d "$kernel" ]; then
        $SUDO rm -rf /usr/local/share/jupyter/kernels/sagemath
        $SUDO mkdir -p /usr/local/share/jupyter/kernels
        $SUDO cp -a "$kernel" /usr/local/share/jupyter/kernels/
        break
      fi
    done
  fi

  if [ "$install_sagetex" = "true" ]; then
    log "Installing sagetex package"
    "$sage_bin" -p sagetex || log "sagetex install failed; continuing"
  fi

  log "Cleaning SageMath build artifacts"
  rm -rf \
    "$prefix/.git" \
    "$prefix/src/doc/output/doctrees" \
    "$prefix/upstream"
  find "$prefix" -type d -name __pycache__ -prune -exec rm -rf {} + || true
  find "$prefix/local/lib" "$prefix/local/bin" -type f ! -name '*.a' -exec strip '{}' ';' 2>&1 \
    | grep -v "File format not recognized" \
    | grep -v "File truncated" || true
  find "$prefix/local/lib" -type f -name '*.a' -exec ranlib '{}' ';' 2>/dev/null || true

  if [ "$clean_build_dir" = "true" ]; then
    rm -rf "$build_dir"
  fi
  rm -rf "$HOME/.cache/pip" /tmp/pip-* /tmp/tmp.* || true
  $SUDO rm -rf /root/.cache 2>/dev/null || true
  $SUDO rm -rf /var/lib/apt/lists/*
  $SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
  $SUDO chmod -R u+rwX,go+rX "$prefix"
}

case "$method" in
  apt)
    install_apt_sage
    ;;
  auto)
    $SUDO apt-get update
    if apt-cache policy sagemath | grep -q 'Candidate: [^(]'; then
      install_apt_sage
    else
      install_source_sage
    fi
    ;;
  micromamba)
    install_micromamba_sage
    ;;
  source)
    install_source_sage
    ;;
  *)
    echo "unknown SageMath install method: $method" >&2
    exit 1
    ;;
esac
