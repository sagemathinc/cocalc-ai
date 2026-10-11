#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
sleep 60 &
DIAG_PID=$!
cleanup() {
  kill "$DIAG_PID" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

FAKE_BIN="${TMP}/bin"
mkdir -p "$FAKE_BIN"

cat > "${FAKE_BIN}/install" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${*: -1}"
mkdir -p "$target"
chmod 0700 "$target"
EOF

cat > "${FAKE_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"--property=MainPID"* && "$*" == *"--value"* ]]; then
  printf '%s\n' "$DIAG_PID"
  exit
fi
if [[ "$*" == *"--property=ControlGroup"* && "$*" == *"--value"* ]]; then
  printf '\n'
  exit
fi
cat <<OUT
ActiveState=active
SubState=running
MainPID=${DIAG_PID}
MemoryCurrent=123456
TasksCurrent=1
OUT
EOF

# The journal comes through the root helper (with sudo as the bay user).
cat > "${FAKE_BIN}/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == "-n" ]] && shift
exec "$@"
EOF
cat > "${FAKE_BIN}/cocalc-bay-hub-ctl" <<'EOF'
#!/usr/bin/env bash
[[ "$*" == "journal 1" ]] || exit 2
printf 'diagnostic journal marker\n'
EOF

cat > "${FAKE_BIN}/ss" <<'EOF'
#!/usr/bin/env bash
printf 'ESTAB 0 0 127.0.0.1:9300 127.0.0.1:12345 users:(("node",pid=%s,fd=7))\n' "$DIAG_PID"
EOF
chmod 0755 "${FAKE_BIN}/"*

export PATH="${FAKE_BIN}:${PATH}"
export DIAG_PID
export COCALC_BAY_ENV_FILE="${TMP}/missing-bay.env"
export COCALC_BAY_WORKERS_ENV_FILE="${TMP}/missing-workers.env"
export COCALC_BAY_OVERLAY_ENV_FILE="${TMP}/missing-overlay.env"
export COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP}/missing-topology.env"
export COCALC_BAY_SECRETS_ENV_FILE="${TMP}/missing-secrets.env"
export COCALC_BAY_HUB_DIAGNOSTIC_DIR="${TMP}/incidents"
export COCALC_BAY_HUB_CTL="${FAKE_BIN}/cocalc-bay-hub-ctl"
export COCALC_BAY_HUB_DIAGNOSTIC_RETENTION_DAYS=14
export COCALC_BAY_HUB_DIAGNOSTIC_MAX_FILES=1

health='{"workers":[{"id":1,"healthy":false,"last_error":"conat timeout"}]}'
first="$(printf '%s\n' "$health" | bash "${SCRIPT_DIR}/bay-hub-diagnose" 1)"
test -f "$first"
test "$(stat -c %a "$first")" = "600"
grep -Fq 'conat timeout' "$first"
grep -Fq "pid=${DIAG_PID}" "$first"
grep -Fq 'diagnostic journal marker' "$first"

sleep 0.01
second="$(printf '%s\n' "$health" | bash "${SCRIPT_DIR}/bay-hub-diagnose" 1)"
test -f "$second"
test "$(find "$COCALC_BAY_HUB_DIAGNOSTIC_DIR" -type f -name '*-worker-*-pid-*.txt' | wc -l)" = "1"

echo "bay hub diagnostic tests passed"
