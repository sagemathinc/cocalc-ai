set -euo pipefail

dpkg-query -W -f='${Status}' chromium | grep -q "install ok installed"
command -v chromium >/dev/null
chromium --headless=new --no-sandbox --disable-gpu --dump-dom about:blank >/dev/null
