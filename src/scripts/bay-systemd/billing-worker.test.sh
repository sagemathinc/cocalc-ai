#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
cp "$ROOT/bin/bay-billing-worker" "$tmp/worker"
cp "$ROOT/bin/billing-env.sh" "$tmp/billing-env.sh"
cat >"$tmp/lib.sh" <<'EOF'
require_var() { test -n "${!1:-}"; }
ensure_dirs() { mkdir -p "$COCALC_BAY_STATE_DIR"; }
EOF
cat >"$tmp/systemctl" <<'EOF'
#!/usr/bin/env bash
test "$*" = 'show --property=Environment --value cocalc-bay-hub@1.service' || exit 1
printf '%s\n' 'COCALC_BILLING_AUTHORITY_ENABLED=1'
EOF
cat >"$tmp/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$COCALC_BILLING_SINGLETON_LOCKED" = 1
test "$COCALC_BILLING_AUTHORITY_ENABLED" = 1
test "$2" = --billing-worker
test -z "${COCALC_BAY_WORKER_ID:-}"
touch "$COCALC_BAY_STATE_DIR/started"
exec sleep 30
EOF
chmod +x "$tmp/node"
chmod +x "$tmp/systemctl"
export PATH="$tmp:$PATH"
export COCALC_BAY_STATE_DIR="$tmp/state"
export COCALC_BAY_NODE_BIN="$tmp/node" COCALC_BAY_HUB_MAIN=unused
export COCALC_BAY_ROUTER_HOST=127.0.0.1 COCALC_BAY_ROUTER_PORT=9000
export COCALC_BILLING_AUTHORITY_ENABLED=1 COCALC_CLUSTER_ROLE=attached
bash "$tmp/worker"
test ! -e "$tmp/state/started"
unset COCALC_BILLING_AUTHORITY_ENABLED
export COCALC_CLUSTER_ROLE=seed COCALC_BAY_WORKER_ID=1
bash "$tmp/worker" &
pid=$!
for _ in $(seq 1 100); do
  [[ -e "$tmp/state/started" ]] && break
  sleep 0.02
done
test -e "$tmp/state/started"
status=0
bash "$tmp/worker" || status=$?
test "$status" = 75
kill "$pid"
wait "$pid" 2>/dev/null || true
pid=""
# A stopped worker releases the descriptor lock without deleting its inode.
flock -n "$tmp/state/billing-executor.lock" true
echo 'billing singleton launcher: passed'
