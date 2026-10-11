#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAKE_BIN="${TMP}/bin"
mkdir -p "$FAKE_BIN"
export COCALC_BAY_CURRENT_LINK="${TMP}/current"
mkdir -p "${COCALC_BAY_CURRENT_LINK}/bin"

cat > "${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${*: -1}"
if [[ "$url" == *":9102/healthz"* ]]; then
  [[ "${FAKE_ROUTER_HEALTHY:-1}" == "1" ]]
  exit
fi
printf '%s\n' "$WATCHDOG_HEALTH_JSON"
EOF

cat > "${FAKE_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$WATCHDOG_SYSTEMCTL_LOG"
case "$1" in
  is-enabled|is-active)
    exit 0
    ;;
  is-failed)
    exit 1
    ;;
  show)
    if [[ "$*" == *"ActiveState"* ]]; then
      printf 'active\n'
    else
      printf 'running\n'
    fi
    ;;
esac
EOF

# The watchdog runs as the bay user and restarts a worker through the root
# helper with sudo; both are stand-ins here.
cat > "${FAKE_BIN}/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "-n" ]] && shift
exec "$@"
EOF
cat > "${FAKE_BIN}/cocalc-bay-hub-ctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'hub-ctl %s\n' "$*" >> "$WATCHDOG_SYSTEMCTL_LOG"
EOF
export COCALC_BAY_HUB_CTL="${FAKE_BIN}/cocalc-bay-hub-ctl"

cat > "${FAKE_BIN}/timeout" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
EOF
chmod 0755 "${FAKE_BIN}/"*

for helper in bay-frontdoor-drain bay-frontdoor-undrain bay-worker-health; do
  cat > "${COCALC_BAY_CURRENT_LINK}/bin/${helper}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\n' "$(basename "$0")" "$*" >> "$WATCHDOG_HELPER_LOG"
EOF
  chmod 0755 "${COCALC_BAY_CURRENT_LINK}/bin/${helper}"
done
cat > "${COCALC_BAY_CURRENT_LINK}/bin/bay-hub-diagnose" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '%s %s\n' "$(basename "$0")" "$*" >> "$WATCHDOG_HELPER_LOG"
printf '/tmp/test-hub-incident.txt\n'
EOF
chmod 0755 "${COCALC_BAY_CURRENT_LINK}/bin/bay-hub-diagnose"

export PATH="${FAKE_BIN}:${PATH}"
export COCALC_BAY_ENV_FILE="${TMP}/missing-bay.env"
export COCALC_BAY_WORKERS_ENV_FILE="${TMP}/missing-workers.env"
export COCALC_BAY_OVERLAY_ENV_FILE="${TMP}/missing-overlay.env"
export COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP}/missing-topology.env"
export COCALC_BAY_SECRETS_ENV_FILE="${TMP}/missing-secrets.env"
export COCALC_BAY_RUN_DIR="${TMP}/run"
export COCALC_BAY_HUB_WATCHDOG_FAILURE_THRESHOLD=2
export COCALC_BAY_HUB_WATCHDOG_RESTART_COOLDOWN_S=300
export WATCHDOG_SYSTEMCTL_LOG="${TMP}/systemctl.log"
export WATCHDOG_HELPER_LOG="${TMP}/helper.log"
export WATCHDOG_HEALTH_JSON='{
  "workers": [
    {"id": 1, "healthy": false, "drained": false},
    {"id": 2, "healthy": false, "drained": false},
    {"id": 3, "healthy": true, "drained": false},
    {"id": 4, "healthy": false, "drained": true}
  ]
}'

bash "${SCRIPT_DIR}/bay-hub-watchdog"
if grep -q '^hub-ctl restart ' "$WATCHDOG_SYSTEMCTL_LOG"; then
  echo "watchdog restarted a worker before reaching its threshold" >&2
  exit 1
fi

bash "${SCRIPT_DIR}/bay-hub-watchdog"
grep -qx 'hub-ctl restart 1' "$WATCHDOG_SYSTEMCTL_LOG"
# Never systemctl directly: the bay user cannot, and root goes through hub-ctl.
if grep -q '^restart \|^reset-failed ' "$WATCHDOG_SYSTEMCTL_LOG"; then
  echo "watchdog called systemctl restart directly" >&2
  exit 1
fi
grep -qx 'bay-hub-diagnose 1' "$WATCHDOG_HELPER_LOG"
grep -qx 'bay-frontdoor-drain 1' "$WATCHDOG_HELPER_LOG"
grep -qx 'bay-worker-health 1' "$WATCHDOG_HELPER_LOG"
grep -qx 'bay-frontdoor-undrain 1' "$WATCHDOG_HELPER_LOG"
if grep -qx 'hub-ctl restart 2' "$WATCHDOG_SYSTEMCTL_LOG"; then
  echo "watchdog restarted more than one worker in one pass" >&2
  exit 1
fi

: > "$WATCHDOG_SYSTEMCTL_LOG"
rm -rf "$COCALC_BAY_RUN_DIR"
export COCALC_BAY_HUB_WATCHDOG_FAILURE_THRESHOLD=1
export FAKE_ROUTER_HEALTHY=0
bash "${SCRIPT_DIR}/bay-hub-watchdog"
if grep -q '^hub-ctl restart ' "$WATCHDOG_SYSTEMCTL_LOG"; then
  echo "watchdog restarted a worker while the router was unhealthy" >&2
  exit 1
fi

echo "bay hub watchdog tests passed"
