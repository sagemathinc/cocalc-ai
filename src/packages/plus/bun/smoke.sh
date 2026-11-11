#!/usr/bin/env bash

# Start CoCalc Plus through its Bun launcher, in a temporary home, and check
# that it serves the app and its Conat connection works; then the same in the
# background with --daemon, --daemon-status and --daemon-stop.
#
# Usage:
#   plus/bun/smoke.sh [build-directory] [target]
#
#   build-directory  output of plus/bun/build.sh (default: packages/plus/build/bun)
#   target           launcher to run (default: linux-x64)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$(cd "${1:-$(dirname "$HERE")/build/bun}" && pwd)"
TARGET="${2:-linux-x64}"

WORK="$(mktemp -d)"
cleanup() {
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The layout of a release: the launcher, with app/ next to it.
cp "$BUILD/launchers/$TARGET/cocalc-plus" "$WORK/cocalc-plus"
cp -R "$BUILD/app" "$WORK/app"
mkdir -p "$WORK/home" "$WORK/data"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

# (env execs the launcher, so a background run's $! is the server itself)
CMD=(env -i PATH="$PATH" HOME="$WORK/home" COCALC_DATA_DIR="$WORK/data"
  PORT="$PORT" HOST=127.0.0.1 COCALC_OPEN_BROWSER=0 COCALC_AUTO_UPDATE=0
  "$WORK/cocalc-plus")
cd "$WORK/home"

serving() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/static/app.html" || true)" = 200 ]
}

wait_for_app() {
  for _ in $(seq 1 60); do
    serving && return 0
    sleep 1
  done
  return 1
}

wait_until_stopped() {
  for _ in $(seq 1 30); do
    serving || return 0
    sleep 1
  done
  return 1
}

fail() {
  echo "smoke: $1" >&2
  [ -f "$WORK/log.txt" ] && tail -40 "$WORK/log.txt" >&2
  exit 1
}

echo "- Foreground"
"${CMD[@]}" > "$WORK/log.txt" 2>&1 &
PID=$!
wait_for_app || fail "the app was not served"
# lite registers its routes only after its own Conat client connects
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" = 302 ] ||
  fail "no redirect at /: lite's routes are missing"
if grep -q "websocket error" "$WORK/log.txt"; then fail "Conat websocket errors"; fi
kill "$PID"
wait "$PID" 2>/dev/null || true
PID=
wait_until_stopped || fail "it kept running after SIGTERM"

echo "- Daemon"
"${CMD[@]}" --daemon --pidfile "$WORK/pid" --log "$WORK/log.txt" > /dev/null
wait_for_app || fail "the daemon did not serve the app"
"${CMD[@]}" --daemon-status --pidfile "$WORK/pid" | grep -q running || fail "--daemon-status"
"${CMD[@]}" --daemon-stop --pidfile "$WORK/pid" > /dev/null
wait_until_stopped || fail "--daemon-stop left it running"

echo "- OK"
