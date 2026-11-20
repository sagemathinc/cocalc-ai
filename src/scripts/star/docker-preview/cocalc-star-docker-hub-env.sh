#!/usr/bin/env bash
set -euo pipefail

# Passes selected `docker run -e` variables to the Star hub.
#
# PID 1 in the container is systemd, so the hub service does not inherit the
# container's environment: it only reads /etc/cocalc/star/hub.env and its own
# unit. This writes a systemd drop-in for the hub with the variables below.
#
# Only the variables in ALLOWED are forwarded, each with a fixed set of valid
# values. The container's environment can hold credentials, so nothing else is
# passed on, and values are never logged. The drop-in is rewritten on every
# container start, so removing a variable from `docker run -e` removes it from
# the hub too.

DROPIN_DIR="${COCALC_STAR_DOCKER_HUB_DROPIN_DIR:-/etc/systemd/system/cocalc-star-hub.service.d}"
DROPIN="${DROPIN_DIR}/docker-env.conf"

ALLOWED=(
  # Frontend static asset monitoring (off by default on Star).
  COCALC_FRONTEND_ASSET_MONITORING
)

log() {
  printf '[star-docker-hub-env] %s\n' "$*"
}

# Prints the value to forward, or fails for a value that is not allowed.
normalized_value() {
  local name="$1" value="$2"
  case "$name" in
    COCALC_FRONTEND_ASSET_MONITORING)
      value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
      case "$value" in
        true | false) printf '%s' "$value" ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

main() {
  local -a lines=()
  local name value
  for name in "${ALLOWED[@]}"; do
    [ -n "${!name+x}" ] || continue
    if value="$(normalized_value "$name" "${!name}")"; then
      lines+=("Environment=${name}=${value}")
      log "forwarding ${name} to the hub"
    else
      log "warning: ignoring ${name}: not a supported value"
    fi
  done

  if [ "${#lines[@]}" -eq 0 ]; then
    rm -f "$DROPIN"
    return 0
  fi
  install -d -m 0755 "$DROPIN_DIR"
  local tmp
  tmp="$(mktemp "${DROPIN}.XXXXXX")"
  {
    printf '# Written by cocalc-star-docker-hub-env on every container start.\n'
    printf '[Service]\n'
    printf '%s\n' "${lines[@]}"
  } >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$DROPIN"
}

main "$@"
