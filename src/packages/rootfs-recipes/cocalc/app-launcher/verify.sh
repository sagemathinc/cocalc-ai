set -euo pipefail

command -v python3
test -x "${PREFIX:-/opt/cocalc-app-launcher}/hello-server.py"
timeout 10s sh -c 'python3 "${PREFIX:-/opt/cocalc-app-launcher}/hello-server.py" >/tmp/rootfs-hello.log 2>&1 & pid=$!; sleep 1; curl -fsS http://127.0.0.1:6007/ | grep -q "RootFS app launcher"; kill "$pid" || true'
