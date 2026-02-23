#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

STATE_DIR_DEFAULT="$SRC_DIR/.local/lite-daemon"
CONFIG_FILE_DEFAULT="$SRC_DIR/.local/lite-daemon.env"

STATE_DIR="${COCALC_LITE_DAEMON_STATE_DIR:-$STATE_DIR_DEFAULT}"
CONFIG_FILE="${COCALC_LITE_DAEMON_CONFIG:-$CONFIG_FILE_DEFAULT}"

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

LITE_CONNECTION_INFO="${LITE_CONNECTION_INFO:-$STATE_DIR/connection-info.json}"

if [ ! -f "$LITE_CONNECTION_INFO" ]; then
  cat >&2 <<EOF
missing lite connection info: $LITE_CONNECTION_INFO
start daemon first:
  pnpm --dir src lite:daemon:start
or set COCALC_LITE_DAEMON_CONFIG to a config that points at the running daemon instance.
EOF
  exit 1
fi

export COCALC_WRITE_CONNECTION_INFO="$LITE_CONNECTION_INFO"

# Allow `pnpm ... -- --grep ...` without forwarding an extra bare `--`
# down to Playwright.
if [ "${1:-}" = "--" ]; then
  shift
fi

cd "$SRC_DIR"
exec pnpm --dir packages/lite exec playwright test -c playwright.jupyter.config.ts "$@"
