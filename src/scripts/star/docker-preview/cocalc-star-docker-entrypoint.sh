#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="${COCALC_STAR_DOCKER_LOG_FILE:-/var/log/cocalc-star-docker-init.log}"

install -d -m 0755 "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 0644 "$LOG_FILE"

export COCALC_STAR_DOCKER_TEE_STDOUT="${COCALC_STAR_DOCKER_TEE_STDOUT:-0}"
tail -n +1 -F "$LOG_FILE" &

exec /sbin/init "$@"
