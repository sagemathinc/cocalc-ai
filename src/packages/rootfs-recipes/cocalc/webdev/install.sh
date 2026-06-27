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

run_sudo_env() {
  if [ -n "$SUDO" ]; then
    $SUDO env "$@"
  else
    env "$@"
  fi
}

python_prefix="${PYTHON_PREFIX:-/opt/cocalc-webdev-python}"
python_packages="${PYTHON_PACKAGES:-ipykernel ipywidgets jupyter-console jupyterlab notebook pip pre-commit pytest requests ruff setuptools uv wheel}"
pnpm_version="${PNPM_VERSION:-11.5.2}"
yarn_version="${YARN_VERSION:-1.22.22}"
npm_global_packages="${NPM_GLOBAL_PACKAGES:-typescript tsx npm-check-updates serve http-server}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  bash \
  bottom \
  build-essential \
  ca-certificates \
  chromium \
  chromium-driver \
  cloc \
  cmake \
  curl \
  g++ \
  gh \
  git \
  htop \
  iputils-ping \
  jq \
  less \
  libcairo2-dev \
  libffi-dev \
  libgif-dev \
  libjpeg-dev \
  liblzma-dev \
  libpango1.0-dev \
  libpq-dev \
  librsvg2-dev \
  libsqlite3-dev \
  libssl-dev \
  make \
  openssh-client \
  pkg-config \
  postgresql \
  postgresql-client \
  procps \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv \
  ripgrep \
  rsync \
  shellcheck \
  sqlite3 \
  sudo \
  telnet \
  tmux \
  tree \
  unzip \
  vim \
  wget \
  xdg-utils \
  zlib1g-dev

if [ -x /opt/cocalc/bin/node ]; then
  $SUDO ln -sf /opt/cocalc/bin/node /usr/local/bin/node
fi
if [ -x /opt/cocalc/bin/npm ]; then
  $SUDO ln -sf /opt/cocalc/bin/npm /usr/local/bin/npm
fi
if [ -x /opt/cocalc/bin/corepack ]; then
  $SUDO ln -sf /opt/cocalc/bin/corepack /usr/local/bin/corepack
fi

npm_bin="$(command -v npm || true)"
if [ -z "$npm_bin" ] && [ -x /opt/cocalc/bin/npm ]; then
  npm_bin="/opt/cocalc/bin/npm"
fi
if [ -z "$npm_bin" ]; then
  echo "npm was not found; CoCalc's Node/npm runtime must be available before installing webdev tools" >&2
  exit 1
fi

run_sudo_env npm_config_prefix=/usr/local "$npm_bin" install -g \
  "pnpm@$pnpm_version" \
  "yarn@$yarn_version" \
  $npm_global_packages

$SUDO mkdir -p "$python_prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$python_prefix"
python3 -m venv --clear "$python_prefix"
"$python_prefix/bin/pip" install --no-cache-dir --upgrade $python_packages
$SUDO "$python_prefix/bin/python" -m ipykernel install --prefix=/usr/local --name python3 --display-name "Python 3"

for exe in python python3; do
  $SUDO tee "/usr/local/bin/$exe" >/dev/null <<EOF
#!/usr/bin/env bash
exec "$python_prefix/bin/python" "\$@"
EOF
  $SUDO chmod 755 "/usr/local/bin/$exe"
done

for exe in pip pip3 uv jupyter jupyter-lab jupyter-notebook jupyter-console pre-commit pytest ruff; do
  if [ -x "$python_prefix/bin/$exe" ]; then
    $SUDO ln -sf "$python_prefix/bin/$exe" "/usr/local/bin/$exe"
  fi
done

$SUDO mkdir -p /opt/cocalc-webdev
$SUDO tee /opt/cocalc-webdev/README.md >/dev/null <<'EOF'
# CoCalc Web Development Image

This image is intended for CoCalc development and standard TypeScript/web
projects. It uses the CoCalc-provided Node/npm runtime and adds system-wide
pnpm, yarn, GitHub CLI, native build tools, PostgreSQL, Chromium, and a compact
Python/Jupyter environment.

## CoCalc development quick start

```sh
git clone https://github.com/sagemathinc/cocalc-ai.git
cd cocalc-ai/src
pnpm install
pnpm build
```

For local development in this repository, `pnpm build:dev` is often the most
useful full development build command.
EOF

$SUDO tee /etc/profile.d/cocalc-webdev.sh >/dev/null <<'EOF'
export PATH="/opt/cocalc/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export PIP_REQUIRE_VIRTUALENV=false
EOF

$SUDO chown -R "$owner_uid:$owner_gid" "$python_prefix" /opt/cocalc-webdev
$SUDO chmod -R u+rwX,go+rX "$python_prefix" /opt/cocalc-webdev

run_sudo_env npm_config_prefix=/usr/local "$npm_bin" cache clean --force || true
$SUDO rm -rf \
  /root/.cache \
  /tmp/* \
  /var/cache/apt/archives/*.deb \
  /var/lib/apt/lists/*
