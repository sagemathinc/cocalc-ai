#!/usr/bin/env bash

# Start CoCalc Plus through its Bun launcher, in a temporary home, and check
# that it serves the app, that its Conat connection works, and that a
# reflect-sync session (created through the hub API, as the frontend does)
# syncs a file; then the same start in the background with --daemon,
# --daemon-status and --daemon-stop.  Linux (setsid); needs rsync.
#
# Usage:
#   plus/bun/smoke.sh [build-directory] [target]
#
#   build-directory  output of plus/bun/build.sh (default: packages/plus/build/bun)
#   target           launcher to run (default: linux-x64)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PACKAGES="$(cd "$HERE/../.." && pwd)"
BUILD="$(cd "${1:-$(dirname "$HERE")/build/bun}" && pwd)"
TARGET="${2:-linux-x64}"
# the built-in local account of CoCalc Lite/Plus
ACCOUNT_ID=00000000-1000-4000-8000-000000000001

WORK="$(mktemp -d)"
PID=
# Stop everything this started: each server runs in its own process group
# (setsid for the foreground one; the daemon is detached), which also holds
# the processes it starts (the ACP worker, reflect's scheduler).
cleanup() {
  local pids=("${PID:-}")
  [ -f "$WORK/pid" ] && pids+=("$(cat "$WORK/pid")")
  for pid in "${pids[@]}"; do
    [ -n "$pid" ] || continue
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in "${pids[@]}"; do
    [ -n "$pid" ] || continue
    kill -KILL -- "-$pid" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
# (bash runs the EXIT trap after a signal only when the signal is trapped)
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The layout of a release: the launcher, with app/ next to it.
cp "$BUILD/launchers/$TARGET/cocalc-plus" "$WORK/cocalc-plus"
cp -R "$BUILD/app" "$WORK/app"
mkdir -p "$WORK/home" "$WORK/data" "$WORK/alpha" "$WORK/beta"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

# (env execs the launcher, so a background run's $! is the server itself)
CMD=(env -i PATH="$PATH" HOME="$WORK/home" COCALC_DATA_DIR="$WORK/data"
  PORT="$PORT" HOST=127.0.0.1 COCALC_OPEN_BROWSER=0 COCALC_AUTO_UPDATE=0
  "$WORK/cocalc-plus")
cd "$WORK/home"

http_code() {
  curl -s -o /dev/null --connect-timeout 2 --max-time 5 -w '%{http_code}' \
    "http://127.0.0.1:$PORT$1" || true
}

serving() {
  [ "$(http_code /static/app.html)" = 200 ]
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
setsid "${CMD[@]}" > "$WORK/log.txt" 2>&1 &
PID=$!
wait_for_app || fail "the app was not served"
# lite registers its routes only after its own Conat client connects
[ "$(http_code /)" = 302 ] || fail "no redirect at /: lite's routes are missing"
if grep -q "websocket error" "$WORK/log.txt"; then fail "Conat websocket errors"; fi

echo "- Reflect"
timeout 120 node "$HERE/smoke-reflect.cjs" "$PACKAGES/conat/dist" \
  "http://127.0.0.1:$PORT" "$ACCOUNT_ID" "$WORK/alpha" "$WORK/beta" ||
  fail "reflect-sync"

kill -TERM "$PID"
wait "$PID" 2>/dev/null || true
wait_until_stopped || fail "it kept running after SIGTERM"
PID=

echo "- Daemon"
"${CMD[@]}" --daemon --pidfile "$WORK/pid" --log "$WORK/log.txt" > /dev/null
wait_for_app || fail "the daemon did not serve the app"
"${CMD[@]}" --daemon-status --pidfile "$WORK/pid" | grep -q running ||
  fail "--daemon-status"
"${CMD[@]}" --daemon-stop --pidfile "$WORK/pid" > /dev/null
wait_until_stopped || fail "--daemon-stop left it running"

echo "- OK"
