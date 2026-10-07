#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Run bay-health from a scratch bin dir so its sibling helpers can be faked.
BIN="${TMP}/bin"
FAKE_BIN="${TMP}/fake"
mkdir -p "$BIN" "$FAKE_BIN"
cp "${SCRIPT_DIR}/bay-health" "${SCRIPT_DIR}/lib.sh" "$BIN/"
for helper in bay-postgres-check bay-frontdoor-health bay-worker-health; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "${BIN}/${helper}"
done
chmod 0755 "$BIN"/*

cat > "${FAKE_BIN}/curl" <<'EOF2'
#!/usr/bin/env bash
url="${*: -1}"
if [[ "$url" == *"/_cocalc/frontdoor/healthz"* ]]; then
  printf '%s\n' "$FRONTDOOR_HEALTH_JSON"
fi
exit 0
EOF2
chmod 0755 "${FAKE_BIN}/curl"

export PATH="${FAKE_BIN}:${PATH}"
export COCALC_BAY_ENV_FILE="${TMP}/missing-bay.env"
export COCALC_BAY_WORKERS_ENV_FILE="${TMP}/missing-workers.env"
export COCALC_BAY_OVERLAY_ENV_FILE="${TMP}/missing-overlay.env"
export COCALC_BAY_TOPOLOGY_ENV_FILE="${TMP}/missing-topology.env"
export COCALC_BAY_SECRETS_ENV_FILE="${TMP}/missing-secrets.env"
export COCALC_BAY_ROOT="${TMP}/bay"
export COCALC_BAY_WORKER_COUNT=4
export COCALC_BAY_MIN_HEALTHY_WORKERS=1
export COCALC_BAY_HEALTH_TIMEOUT_S=1

export FRONTDOOR_HEALTH_JSON='{"workers":[
  {"id":1,"healthy":false,"ready":true,"app_probe":{"isolated":true}},
  {"id":2,"healthy":true,"ready":true,"app_probe":{"isolated":false}},
  {"id":3,"healthy":true,"ready":true,"app_probe":{"isolated":false}},
  {"id":4,"healthy":true,"ready":true,"app_probe":null}
]}'
out="$(bash "${BIN}/bay-health")"
python3 - "$out" <<'PY'
import json, sys
health = json.loads(sys.argv[1])
assert health["ok"] is True, health
assert health["healthy_workers"] == 3, health
assert health["isolated_workers"] == [1], health
PY

export FRONTDOOR_HEALTH_JSON='{"workers":[{"id":1,"healthy":true}]}'
out="$(bash "${BIN}/bay-health")"
python3 - "$out" <<'PY'
import json, sys
health = json.loads(sys.argv[1])
assert health["healthy_workers"] == 4, health
assert health["isolated_workers"] == [], health
PY

export FRONTDOOR_HEALTH_JSON='not json'
out="$(bash "${BIN}/bay-health")"
python3 - "$out" <<'PY'
import json, sys
health = json.loads(sys.argv[1])
assert health["healthy_workers"] == 4, health
PY

echo "bay health tests passed"
