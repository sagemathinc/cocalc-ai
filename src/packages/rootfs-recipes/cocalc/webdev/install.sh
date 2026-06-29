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
python_packages="${PYTHON_PACKAGES:-bash_kernel ipykernel ipywidgets jupyter-console jupyterlab notebook pip pre-commit pytest requests ruff setuptools uv wheel}"
pnpm_version="${PNPM_VERSION:-latest}"
yarn_version="${YARN_VERSION:-latest}"
npm_global_packages="${NPM_GLOBAL_PACKAGES:-typescript tsx npm-check-updates serve http-server tslab}"
deno_prefix="${DENO_PREFIX:-/opt/deno}"
deno_version="${DENO_VERSION:-latest}"
bun_prefix="${BUN_PREFIX:-/opt/bun}"
bun_version="${BUN_VERSION:-latest}"
code_server_prefix="${CODE_SERVER_PREFIX:-/opt/code-server}"
code_server_version="${CODE_SERVER_VERSION:-latest}"
code_server_extensions="${CODE_SERVER_EXTENSIONS:-}"
code_server_extensions_dir="${CODE_SERVER_EXTENSIONS_DIR:-/opt/code-server/extensions}"
code_server_user_data_dir="${CODE_SERVER_USER_DATA_DIR:-/opt/code-server/user-data}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

install_chromium_real_deb_repo() {
  local key_id="5301FA4FD93244FBC6F6149982BB6851C64F6880"
  local gnupg_home

  gnupg_home="$(mktemp -d)"
  chmod 700 "$gnupg_home"
  gpg --homedir "$gnupg_home" --batch --keyserver hkps://keyserver.ubuntu.com --recv-keys "$key_id"
  gpg --homedir "$gnupg_home" --export "$key_id" | $SUDO tee /usr/share/keyrings/xtradeb-apps.gpg >/dev/null
  rm -rf "$gnupg_home"

  . /etc/os-release
  $SUDO tee /etc/apt/sources.list.d/xtradeb-apps.sources >/dev/null <<EOF
Types: deb
URIs: https://ppa.launchpadcontent.net/xtradeb/apps/ubuntu/
Suites: ${VERSION_CODENAME}
Components: main
Signed-By: /usr/share/keyrings/xtradeb-apps.gpg
EOF

  $SUDO tee /etc/apt/preferences.d/chromium-real-deb >/dev/null <<'EOF'
Package: chromium-browser
Pin: version 2:1snap*
Pin-Priority: -1

Package: chromium chromium-common chromium-driver chromium-headless-shell chromium-l10n chromium-sandbox chromium-shell
Pin: release o=LP-PPA-xtradeb-apps
Pin-Priority: 700
EOF
}

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends ca-certificates gnupg
install_chromium_real_deb_repo
$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  bash \
  bat \
  build-essential \
  ca-certificates \
  chromium \
  chromium-driver \
  chromium-sandbox \
  cloc \
  cmake \
  curl \
  bind9-dnsutils \
  direnv \
  fd-find \
  g++ \
  gh \
  git \
  graphviz \
  htop \
  imagemagick \
  iputils-ping \
  jq \
  less \
  lsof \
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
  netcat-openbsd \
  openssh-client \
  parallel \
  pkg-config \
  postgresql \
  postgresql-client \
  procps \
  python3 \
  python3-dev \
  python3-pip \
  python3-venv \
  redis-server \
  ripgrep \
  rsync \
  shellcheck \
  sqlite3 \
  strace \
  sudo \
  tar \
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
if command -v fdfind >/dev/null 2>&1; then
  $SUDO ln -sf "$(command -v fdfind)" /usr/local/bin/fd
fi
if command -v batcat >/dev/null 2>&1; then
  $SUDO ln -sf "$(command -v batcat)" /usr/local/bin/bat
fi
$SUDO tee /usr/local/bin/chromium-browser >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec /usr/bin/chromium "$@"
EOF
$SUDO chmod 0755 /usr/local/bin/chromium-browser

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

code_server_tmp=""
runtime_tmp="$(mktemp -d)"
trap 'rm -rf "$runtime_tmp" "$code_server_tmp"' EXIT

$SUDO mkdir -p "$deno_prefix" "$bun_prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$deno_prefix" "$bun_prefix"

curl -fsSL https://deno.land/install.sh -o "$runtime_tmp/install-deno.sh"
deno_args=()
if [ "$deno_version" != "latest" ] && [ -n "$deno_version" ]; then
  deno_args+=("$deno_version")
fi
DENO_INSTALL="$deno_prefix" sh "$runtime_tmp/install-deno.sh" "${deno_args[@]}"
$SUDO ln -sf "$deno_prefix/bin/deno" /usr/local/bin/deno

curl -fsSL https://bun.sh/install -o "$runtime_tmp/install-bun.sh"
bun_args=()
if [ "$bun_version" != "latest" ] && [ -n "$bun_version" ]; then
  bun_args+=(bun-v"$bun_version")
fi
BUN_INSTALL="$bun_prefix" bash "$runtime_tmp/install-bun.sh" "${bun_args[@]}"
$SUDO ln -sf "$bun_prefix/bin/bun" /usr/local/bin/bun

code_server_tmp="$(mktemp -d)"
curl -fsSL https://code-server.dev/install.sh -o "$code_server_tmp/install-code-server.sh"

code_server_args=(--method=standalone --prefix="$code_server_prefix")
if [ "$code_server_version" != "latest" ] && [ -n "$code_server_version" ]; then
  code_server_args+=(--version="$code_server_version")
fi

if [ -n "$SUDO" ]; then
  $SUDO env -u VERSION sh "$code_server_tmp/install-code-server.sh" "${code_server_args[@]}"
else
  env -u VERSION sh "$code_server_tmp/install-code-server.sh" "${code_server_args[@]}"
fi

$SUDO ln -sf "$code_server_prefix/bin/code-server" /usr/local/bin/code-server
$SUDO mkdir -p "$code_server_extensions_dir" "$code_server_user_data_dir"
$SUDO chown -R "$(id -u):$(id -g)" "$code_server_extensions_dir" "$code_server_user_data_dir"

if [ -n "$code_server_extensions" ]; then
  for extension in $code_server_extensions; do
    code-server \
      --extensions-dir "$code_server_extensions_dir" \
      --user-data-dir "$code_server_user_data_dir" \
      --install-extension "$extension"
  done
fi

$SUDO mkdir -p "$python_prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$python_prefix"
python3 -m venv --clear "$python_prefix"
"$python_prefix/bin/pip" install --no-cache-dir --upgrade $python_packages
$SUDO "$python_prefix/bin/python" -m ipykernel install --prefix=/usr/local --name python3 --display-name "Python 3"
$SUDO "$python_prefix/bin/python" -m bash_kernel.install --prefix=/usr/local

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

if command -v tslab >/dev/null 2>&1; then
  $SUDO tslab install --prefix=/usr/local --binary=/usr/local/bin/tslab
fi

$SUDO mkdir -p /opt/cocalc-webdev
$SUDO tee /opt/cocalc-webdev/README.md >/dev/null <<'EOF'
# CoCalc Web Development Image

This image is intended for CoCalc development and standard TypeScript/web
projects. It uses the CoCalc-provided Node/npm runtime and adds system-wide
pnpm, yarn, Deno, Bun, GitHub CLI, native build tools, Chromium, PostgreSQL,
Redis, code-server, and compact Python and Node.js Jupyter kernels.

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

$SUDO chown -R "$owner_uid:$owner_gid" \
  "$python_prefix" \
  "$deno_prefix" \
  "$bun_prefix" \
  "$code_server_prefix" \
  "$code_server_extensions_dir" \
  "$code_server_user_data_dir" \
  /opt/cocalc-webdev
$SUDO chmod -R u+rwX,go+rX \
  "$python_prefix" \
  "$deno_prefix" \
  "$bun_prefix" \
  "$code_server_prefix" \
  "$code_server_extensions_dir" \
  "$code_server_user_data_dir" \
  /opt/cocalc-webdev

run_sudo_env npm_config_prefix=/usr/local "$npm_bin" cache clean --force || true
$SUDO rm -rf \
  /root/.cache \
  /tmp/* \
  /var/cache/apt/archives/*.deb \
  /var/lib/apt/lists/*
