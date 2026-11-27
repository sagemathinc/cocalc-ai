#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-cloudflared-logs must run as root" >&2
  exit 1
fi
service="cocalc-cloudflared.service"
lines="${1:-200}"
if ! echo "$lines" | grep -Eq '^[0-9]+$'; then
  lines="200"
fi
if [ "$lines" -lt 1 ]; then
  lines=1
elif [ "$lines" -gt 5000 ]; then
  lines=5000
fi
mode="${2:-snapshot}"
case "$mode" in
  snapshot)
    exec /bin/journalctl -u "$service" -o short-iso-precise --no-pager -n "$lines"
    ;;
  follow)
    exec /bin/journalctl -u "$service" -o short-iso-precise -f -n "$lines"
    ;;
  *)
    echo "usage: ${0} [lines] {snapshot|follow}" >&2
    exit 2
    ;;
esac
