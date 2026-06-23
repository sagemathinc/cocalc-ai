set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-app-launcher}"
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

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends ca-certificates curl python3
$SUDO mkdir -p "$prefix"
$SUDO tee "$prefix/hello-server.py" >/dev/null <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os

host = os.environ.get("HOST", "127.0.0.1")
port = int(os.environ.get("PORT", "6007"))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"Hello from a RootFS app launcher.\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

ThreadingHTTPServer((host, port), Handler).serve_forever()
PY
$SUDO chmod 755 "$prefix/hello-server.py"
$SUDO rm -rf /var/lib/apt/lists/*
