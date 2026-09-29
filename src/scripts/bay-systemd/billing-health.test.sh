#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$ROOT/bin/bay-billing-health" "$tmp/health"
cat >"$tmp/lib.sh" <<'EOF'
require_var() { test -n "${!1:-}"; }
bay_log() { printf '%s\n' "$*" >&2; }
EOF
cat >"$tmp/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$*" = 'is-active --quiet cocalc-bay-billing.service'
echo unit >> "$TEST_LOG"
test "$TEST_UNIT_ACTIVE" = 1
EOF
cat >"$tmp/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test "$2" = --billing-health-check
echo probe >> "$TEST_LOG"
case "$TEST_PROBE" in
  ready) echo '{"ready":true}' ;;
  recovery)
    if [[ -f "$TEST_LOG.recovered" ]]; then echo '{"ready":true}';
    else touch "$TEST_LOG.recovered"; echo '{"ready":false}'; exit 1; fi ;;
  hang) exec sleep 30 ;;
  *) echo '{"ready":false}'; exit 1 ;;
esac
EOF
chmod +x "$tmp/node" "$tmp/systemctl"
export PATH="$tmp:$PATH" TEST_LOG="$tmp/calls"
export COCALC_BAY_NODE_BIN="$tmp/node" COCALC_BAY_HUB_MAIN=unused
export COCALC_CLUSTER_ROLE=seed COCALC_BILLING_AUTHORITY_ENABLED=1
export TEST_UNIT_ACTIVE=1 TEST_PROBE=ready
bash "$tmp/health" >/dev/null
test "$(wc -l < "$TEST_LOG")" = 3

export TEST_UNIT_ACTIVE=0
if bash "$tmp/health" >/dev/null; then echo 'inactive service passed' >&2; exit 1; fi
export TEST_UNIT_ACTIVE=1 TEST_PROBE=not-ready
if bash "$tmp/health" >/dev/null; then echo 'unready service passed' >&2; exit 1; fi

export TEST_PROBE=recovery COCALC_BAY_BILLING_START_TIMEOUT_S=5
bash "$tmp/health" --wait >/dev/null
export TEST_PROBE=hang COCALC_BAY_BILLING_START_TIMEOUT_S=1
if bash "$tmp/health" --wait >/dev/null; then echo 'hung probe passed' >&2; exit 1; fi

before="$(wc -l < "$TEST_LOG")"
export COCALC_CLUSTER_ROLE=attached
bash "$tmp/health"
export COCALC_CLUSTER_ROLE=standalone COCALC_BILLING_AUTHORITY_ENABLED=0
bash "$tmp/health"
test "$(wc -l < "$TEST_LOG")" = "$before"

# Both hub-only and full release branches must gate immediately after restart.
awk '
  /systemctl restart cocalc-bay-billing.service/ {
    if (getline <= 0 || $0 != "/opt/cocalc/bay/current/bin/bay-billing-health --wait") exit 1
    found++
  }
  END { if (found != 2) exit 1 }
' "$ROOT/upgrade-bay-release.sh"
echo 'billing readiness gate: passed'
