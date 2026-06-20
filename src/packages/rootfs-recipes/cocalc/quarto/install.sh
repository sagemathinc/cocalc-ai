set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

version="${VERSION:-latest}"
arch="$(dpkg --print-architecture)"
case "$arch" in
  amd64|arm64) ;;
  *) echo "unsupported architecture for Quarto deb: $arch" >&2; exit 1 ;;
esac

$SUDO apt-get update
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl python3

asset_url="$(VERSION="$version" ARCH="$arch" python3 - <<'PY'
import json
import os
import sys
import urllib.request

version = os.environ["VERSION"]
arch = os.environ["ARCH"]
api = "https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest"
if version != "latest":
    api = f"https://api.github.com/repos/quarto-dev/quarto-cli/releases/tags/v{version.lstrip('v')}"
with urllib.request.urlopen(api, timeout=60) as f:
    release = json.load(f)
suffix = f"-linux-{arch}.deb"
for asset in release.get("assets", []):
    url = asset.get("browser_download_url", "")
    if url.endswith(suffix):
        print(url)
        break
else:
    raise SystemExit(f"no Quarto asset ending in {suffix}")
PY
)"

tmp="$(mktemp --suffix=.deb)"
curl -fsSL "$asset_url" -o "$tmp"
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y "$tmp"
rm -f "$tmp"
$SUDO rm -rf /var/lib/apt/lists/*
