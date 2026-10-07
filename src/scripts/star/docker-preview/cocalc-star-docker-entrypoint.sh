#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${COCALC_STAR_DOCKER_LOG_FILE:-/var/log/cocalc-star-docker-init.log}"

install -d -m 0755 "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 0644 "$LOG_FILE"

# Rootless Podman keeps a long-lived user and mount namespace. Bind mounts made
# later (e.g. RootFS normalization under /run) are only visible inside it when
# the root mount propagates; Docker starts the container with a private root.
mount --make-rshared / 2>/dev/null || true

# AppArmor policy is loaded from inside the container (see
# cocalc-star-docker-init), which needs securityfs.
if [ -d /sys/kernel/security ] && ! mountpoint -q /sys/kernel/security; then
  mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true
fi

export COCALC_STAR_DOCKER_TEE_STDOUT="${COCALC_STAR_DOCKER_TEE_STDOUT:-0}"
tail -n +1 -F "$LOG_FILE" &

exec /sbin/init "$@"
