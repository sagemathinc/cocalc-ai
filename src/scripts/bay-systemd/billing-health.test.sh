#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$ROOT/bin/bay-billing-health" "$tmp/health"
cp "$ROOT/bin/billing-env.sh" "$tmp/billing-env.sh"
cp "$ROOT/bin/billing-probe.js" "$tmp/billing-probe.js"
export TEST_REAL_NODE="$(command -v node)"
cat >"$tmp/lib.sh" <<'EOF'
require_var() { test -n "${!1:-}"; }
bay_log() { printf '%s\n' "$*" >&2; }
EOF
cat >"$tmp/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == show ]]; then
  test "${TEST_CONFIG_FAIL:-0}" = 0 || exit 1
  printf 'UNRELATED=redacted "COCALC_BILLING_AUTHORITY_ENABLED=%s"\n' "${TEST_LEGACY_ENABLE:-1}"
  exit 0
fi
test "$*" = 'is-active --quiet cocalc-bay-billing.service'
echo unit >> "$TEST_LOG"
test "$TEST_UNIT_ACTIVE" = 1
EOF
cat >"$tmp/node" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == */billing-probe.js ]]; then exec "$TEST_REAL_NODE" "$@"; fi
test "$2" = --billing-health-check
echo probe >> "$TEST_LOG"
case "$TEST_PROBE" in
  ready) printf '{"ready":true,"generation":%s}\n' "${TEST_GENERATION:-7}" ;;
  recovery)
    if [[ -f "$TEST_LOG.recovered" ]]; then echo '{"ready":true,"generation":8}';
    else touch "$TEST_LOG.recovered"; echo '{"ready":true,"generation":7}'; fi ;;
  hang) exec sleep 30 ;;
  slow-once)
    if [[ -f "$TEST_LOG.slow" ]]; then echo '{"ready":true,"generation":7}';
    else touch "$TEST_LOG.slow"; exec sleep 30; fi ;;
  error) echo 'database failed' >&2; exit 1 ;;
  *) echo '{"ready":false,"generation":7}'; exit 1 ;;
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
bash "$tmp/health" --wait --after-generation 7 >/dev/null
export TEST_PROBE=hang COCALC_BAY_BILLING_START_TIMEOUT_S=1
if bash "$tmp/health" --wait >/dev/null; then echo 'hung probe passed' >&2; exit 1; fi

# An active replacement cannot pass using its predecessor's fresh ready row.
export TEST_PROBE=ready TEST_GENERATION=7
test "$(bash "$tmp/health" --generation)" = 7
if bash "$tmp/health" --after-generation 7 >/dev/null; then echo 'old generation passed' >&2; exit 1; fi
export TEST_GENERATION=6
if bash "$tmp/health" --after-generation 7 >/dev/null; then echo 'older generation passed' >&2; exit 1; fi
export TEST_GENERATION=8
bash "$tmp/health" --after-generation 7 >/dev/null
export TEST_PROBE=not-ready
test "$(bash "$tmp/health" --generation)" = 7
export TEST_PROBE=error
if bash "$tmp/health" --generation >/dev/null; then echo 'failed snapshot passed' >&2; exit 1; fi

# A slow cold start right after a worker roll is retried, not fatal; a probe
# that never answers still aborts once the budget is spent.
export TEST_PROBE=slow-once COCALC_BAY_BILLING_PROBE_TIMEOUT_S=1 COCALC_BAY_BILLING_GENERATION_TIMEOUT_S=10
test "$(bash "$tmp/health" --generation 2>/dev/null)" = 7
export TEST_PROBE=hang COCALC_BAY_BILLING_GENERATION_TIMEOUT_S=2
status=0
bash "$tmp/health" --generation >/dev/null 2>&1 || status=$?
if (( status != 124 && status != 137 )); then echo "hung snapshot returned $status" >&2; exit 1; fi
export COCALC_BAY_BILLING_PROBE_TIMEOUT_S=0
if bash "$tmp/health" --generation >/dev/null 2>&1; then echo 'invalid probe timeout passed' >&2; exit 1; fi
unset COCALC_BAY_BILLING_PROBE_TIMEOUT_S COCALC_BAY_BILLING_GENERATION_TIMEOUT_S

before="$(wc -l < "$TEST_LOG")"
export COCALC_CLUSTER_ROLE=attached
bash "$tmp/health"
export COCALC_CLUSTER_ROLE=standalone COCALC_BILLING_AUTHORITY_ENABLED=0
bash "$tmp/health"
test "$(wc -l < "$TEST_LOG")" = "$before"

# Legacy systemd-only enablement must not silently skip the readiness gate.
unset COCALC_BILLING_AUTHORITY_ENABLED
export TEST_PROBE=ready
bash "$tmp/health" >/dev/null
export TEST_UNIT_ACTIVE=0
if bash "$tmp/health" >/dev/null; then echo 'legacy inactive service passed' >&2; exit 1; fi
export TEST_CONFIG_FAIL=1
if bash "$tmp/health" >/dev/null; then echo 'unknown configuration passed' >&2; exit 1; fi
export TEST_CONFIG_FAIL=0 TEST_PROBE=ready TEST_UNIT_ACTIVE=1
for value in TRUE Yes ' true ' ' yes '; do
  export COCALC_BILLING_AUTHORITY_ENABLED="$value"
  before="$(wc -l < "$TEST_LOG")"
  bash "$tmp/health" >/dev/null
  test "$(wc -l < "$TEST_LOG")" -eq "$((before + 3))"
  unset COCALC_BILLING_AUTHORITY_ENABLED
  export TEST_LEGACY_ENABLE="$value"
  bash "$tmp/health" >/dev/null
  test "$(wc -l < "$TEST_LOG")" -eq "$((before + 6))"
done

# Both hub-only and full release branches must gate immediately after restart.
awk '
  /systemctl restart cocalc-bay-billing.service/ {
    if (previous != "billing_generation=\"$(bay_run bay-billing-health --generation)\"") exit 1
    if (getline <= 0 || $0 != "bay_run bay-billing-health --wait --after-generation \"$billing_generation\"") exit 1
    found++
  }
  { previous = $0 }
  END { if (found != 2) exit 1 }
' "$ROOT/upgrade-bay-release.sh"
echo 'billing readiness gate: passed'
