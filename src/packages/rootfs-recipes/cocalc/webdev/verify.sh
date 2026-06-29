set -euo pipefail

command -v node
command -v npm
command -v pnpm
command -v yarn
command -v deno
command -v bun
command -v git
command -v gh
command -v rg
command -v fd
command -v bat
command -v jq
command -v gcc
command -v g++
command -v make
command -v cmake
command -v pkg-config
command -v psql
command -v redis-server
command -v sqlite3
command -v chromium
command -v chromium-browser
command -v dig
command -v lsof
command -v nc
command -v strace
command -v direnv
command -v parallel
command -v dot
command -v convert
command -v python3
command -v pip
command -v uv
command -v pre-commit
command -v pytest
command -v ruff
command -v jupyter
command -v jupyter-lab
command -v code-server
command -v tslab

if ! command -v chromedriver >/dev/null 2>&1 && ! command -v chromium-driver >/dev/null 2>&1; then
  echo "chromedriver was not found" >&2
  exit 1
fi

node --version
npm --version
pnpm --version
yarn --version
deno --version
bun --version
chromium --version
gh --version
python3 --version
uv --version
code-server --version

python3 - <<'PY'
import bash_kernel
import ipykernel
import ipywidgets
import jupyterlab
import pytest
import requests
PY

jupyter kernelspec list | grep -q 'python3'
jupyter kernelspec list | grep -qi 'bash'
jupyter kernelspec list | grep -qi 'jslab'
jupyter kernelspec list | grep -qi 'tslab'
test -r /opt/cocalc-webdev/README.md
test -x /opt/code-server/bin/code-server
test -d /opt/code-server/extensions
test -d /opt/code-server/user-data
