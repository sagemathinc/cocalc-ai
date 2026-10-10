set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ -z "${VERSION_CODENAME:-}" ]; then
  echo "The Chromium recipe currently supports Ubuntu images only." >&2
  exit 1
fi

# Same source as cocalc/x11-applications: Ubuntu's own chromium package is a
# snap stub, which does not run in project containers.
key=5301FA4FD93244FBC6F6149982BB6851C64F6880
$SUDO apt-get update
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates dirmngr gnupg

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -m 700 "$tmp/gnupg"
gpg --batch --homedir "$tmp/gnupg" \
  --keyserver hkps://keyserver.ubuntu.com --recv-keys "$key"
gpg --batch --homedir "$tmp/gnupg" --export "$key" |
  $SUDO tee /usr/share/keyrings/xtradeb-apps.gpg >/dev/null
$SUDO chmod 0644 /usr/share/keyrings/xtradeb-apps.gpg

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

$SUDO apt-get update
$SUDO apt-get purge -y chromium-browser || true
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium

$SUDO apt-get clean
$SUDO rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
