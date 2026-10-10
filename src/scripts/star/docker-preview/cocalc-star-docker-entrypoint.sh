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

# CoCalc's managed container runtime (Podman, crun, ...) is kept in the volume
# with the Podman state it manages, so a new container, e.g. after an upgrade,
# checks and uses that state with the runtime that wrote it. This is a bind
# mount, not a symlink, because the managed Podman's AppArmor profile attaches
# to its /opt/cocalc/container-runtime path.
runtime_dir=/opt/cocalc/container-runtime
persisted_runtime_dir="${COCALC_STAR_DOCKER_STATE_DIR:-/var/lib/cocalc/star-docker}/container-runtime"
if ! mountpoint -q "$runtime_dir"; then
  install -d -m 0755 -o root -g root "$persisted_runtime_dir" "$runtime_dir"
  # A runtime installed into the container while the mount was unavailable
  # must not be hidden by an empty volume directory. Copy it next to the
  # target first, so an interrupted copy leaves the target empty and is
  # retried on the next boot.
  if [ -z "$(ls -A "$persisted_runtime_dir")" ] && [ -n "$(ls -A "$runtime_dir")" ]; then
    seed="${persisted_runtime_dir}.seed"
    rm -rf "$seed"
    if cp -a "$runtime_dir" "$seed" && rmdir "$persisted_runtime_dir" &&
      mv "$seed" "$persisted_runtime_dir"; then
      :
    else
      rm -rf "$seed"
      install -d -m 0755 -o root -g root "$persisted_runtime_dir"
      echo "warning: could not copy the container runtime into the volume" >&2
    fi
  fi
  if ! mount --bind "$persisted_runtime_dir" "$runtime_dir"; then
    echo "warning: could not keep the container runtime in the volume; it is reinstalled with each new container" >&2
  fi
fi

export COCALC_STAR_DOCKER_TEE_STDOUT="${COCALC_STAR_DOCKER_TEE_STDOUT:-0}"
# Only forward new lines: Docker already kept the output of earlier boots.
tail -n 0 -F "$LOG_FILE" &

exec /sbin/init "$@"
