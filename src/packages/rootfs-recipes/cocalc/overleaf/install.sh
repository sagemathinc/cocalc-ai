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

repo_url="${REPO_URL:-https://github.com/sagemathinc/overleaf}"
ref="${REF:-main}"
prefix="${PREFIX:-/opt/overleaf}"
frontend_port="${FRONTEND_PORT:-6020}"
web_port="${WEB_PORT:-6021}"
node_major="${NODE_MAJOR:-22}"
npm_version="${NPM_VERSION:-11.11.0}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg make sudo

if [ ! -x /usr/bin/node ] || ! /usr/bin/node -e "process.exit(Number(process.versions.node.split('.')[0]) >= Number('$node_major') ? 0 : 1)"; then
  curl -fsSL "https://deb.nodesource.com/setup_${node_major}.x" | $SUDO bash -
  run_noninteractive apt-get install -y --no-install-recommends nodejs
fi

npm_bin="/usr/bin/npm"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
$SUDO env PATH="/usr/local/bin:/usr/bin:/bin:$PATH" "$npm_bin" install -g "npm@$npm_version"

if [ -d "$prefix/.git" ]; then
  $SUDO git -C "$prefix" fetch --depth=1 origin "$ref"
  $SUDO git -C "$prefix" checkout FETCH_HEAD
else
  $SUDO rm -rf "$prefix"
  $SUDO git clone --depth=1 --branch "$ref" "$repo_url" "$prefix"
fi

$SUDO chown -R "$(id -u):$(id -g)" "$prefix"

(
  cd "$prefix"
  ./native/bootstrap-overleaf.sh \
    --port "$frontend_port" \
    --web-port "$web_port" \
    --public-url "http://127.0.0.1:$frontend_port"
)

python3 - "$prefix/native/start-overleaf.sh" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = '''  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" >/dev/null 2>&1; then
    echo "$name already running"
    return
  fi
'''
new = '''  if [[ -f "$pidfile" ]]; then
    existing_pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      existing_cwd="$(readlink "/proc/$existing_pid/cwd" 2>/dev/null || true)"
      expected_cwd="$(cd "$workdir" && pwd -P)"
      if [[ "$existing_cwd" == "$expected_cwd" ]]; then
        echo "$name already running"
        return
      fi
    fi
    rm -f "$pidfile"
  fi
'''
if old not in text:
    raise SystemExit("start-overleaf.sh start_service block changed")
path.write_text(text.replace(old, new))
PY

$SUDO rm -rf "$prefix/.git"

$SUDO tee /usr/local/bin/cocalc-overleaf >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
export FRONTEND_PORT="\${PORT:-$frontend_port}"
export WEB_PORT="\${OVERLEAF_WEB_PORT:-$web_port}"
export PUBLIC_URL="\${PUBLIC_URL:-http://127.0.0.1:\${FRONTEND_PORT}}"
cd "$prefix"
exec ./native/start-overleaf.sh
EOF
$SUDO chmod 755 /usr/local/bin/cocalc-overleaf

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix"
$SUDO chmod -R u+rwX,go+rX "$prefix"
$SUDO rm -rf /var/lib/apt/lists/*
