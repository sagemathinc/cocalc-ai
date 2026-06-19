set -euo pipefail

for pkg in ${PACKAGES:?packages are required}; do
  dpkg-query -W -f='${Status}' "$pkg" | grep -q "install ok installed"
done
