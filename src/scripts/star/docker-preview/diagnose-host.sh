#!/usr/bin/env bash
# Report why a running CoCalc Star container's project host is unavailable.
# Usage: bash diagnose-host.sh [container-name]   (default: cocalc-star)
set -u
NAME="${1:-cocalc-star}"
docker exec "$NAME" bash -c '
set -a; source /etc/cocalc/star/hub.env; set +a
q() { sudo -E -u cocalc-star psql -X -At -c "$1" 2>&1; }
echo "=== project host"
q "select status, last_seen, now() from project_hosts"
echo "=== runtime synthetic probe"
q "select jsonb_pretty(coalesce(metadata->'"'"'runtime_synthetic_probe'"'"', '"'"'{}'"'"'::jsonb) - '"'"'error'"'"') from project_hosts"
q "select metadata#>>'"'"'{runtime_synthetic_probe,error}'"'"' from project_hosts" | cut -c1-3000
echo "=== public route probe"
q "select jsonb_pretty(coalesce(metadata->'"'"'public_route_probe'"'"', '"'"'{}'"'"'::jsonb)) from project_hosts" | cut -c1-1500
echo "=== io containment"
q "select metadata#>>'"'"'{metrics,current,io_containment}'"'"' from project_hosts" | cut -c1-800
echo "=== doctor"
/opt/cocalc-star/source/src/scripts/star/star.sh doctor 2>&1 | grep -v "^ok"
'
