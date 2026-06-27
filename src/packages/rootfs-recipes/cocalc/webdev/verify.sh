set -euo pipefail

command -v node
command -v npm
command -v pnpm
command -v yarn
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

node --version
npm --version
pnpm --version
yarn --version
gh --version
python3 --version
uv --version

python3 - <<'PY'
import ipykernel
import ipywidgets
import jupyterlab
import pytest
import requests
PY

jupyter kernelspec list | grep -q 'python3'
test -r /opt/cocalc-webdev/README.md
