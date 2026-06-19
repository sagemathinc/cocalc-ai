set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

if [ "${UPDATE:-true}" = "true" ]; then
  $SUDO apt-get update
fi

if [ "${UPGRADE:-false}" = "true" ]; then
  $SUDO apt-get upgrade -y
fi

args=(-y)
if [ "${NO_RECOMMENDS:-true}" = "true" ]; then
  args+=(--no-install-recommends)
fi

$SUDO apt-get install "${args[@]}" ${PACKAGES:?packages are required}

if [ "${CLEAN:-true}" = "true" ]; then
  $SUDO rm -rf /var/lib/apt/lists/*
fi
