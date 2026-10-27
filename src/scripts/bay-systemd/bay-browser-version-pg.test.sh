#!/usr/bin/env bash
# write_browser_version_setting against a real, throwaway postgres: it raises
# a missing, invalid or lower value and never lowers a higher one. Run by
# bay-bootstrap-release.test.sh when postgres server binaries are available.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B="$1"
T=$(mktemp -d)
trap '$B/pg_ctl -D $T/data -m fast -w stop >/dev/null 2>&1 || true; rm -rf $T' EXIT
BAY_USER=bvtest
BAY_ROOT=$T
mkdir -p $T/run/postgres
$B/initdb -D $T/data -U $BAY_USER >/dev/null 2>&1
$B/pg_ctl -D $T/data -o "-k $T/run/postgres -h '' -p 5432 -c listen_addresses=''" -l $T/log -w start >/dev/null
psql -h $T/run/postgres -p 5432 -U $BAY_USER -d postgres -XAtq -c "CREATE DATABASE $BAY_USER"
PSQL=(psql -h $T/run/postgres -p 5432 -U $BAY_USER -d $BAY_USER -XAtq)
"${PSQL[@]}" -c "CREATE TABLE server_settings (name text primary key, value text, readonly boolean)"
PSQL_BIN=psql
runuser() { shift 3; "$@"; }
eval "$(sed -n '/^write_browser_version_setting() {/,/^}/p' ${SCRIPT_DIR}/bay-bootstrap-release.sh)"
set_value() { "${PSQL[@]}" -c "INSERT INTO server_settings VALUES ('version_min_browser', \$\$$1\$\$) ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value"; }
get_value() { "${PSQL[@]}" -c "SELECT value FROM server_settings WHERE name='version_min_browser'"; }
try() {
  local label="$1" want_status="$2" want_value="$3" st=0
  write_browser_version_setting version_min_browser 1790408000 || st=$?
  if [[ "$st" != "$want_status" || "$(get_value)" != "$want_value" ]]; then
    echo "write_browser_version_setting ${label}: status ${st}, value '$(get_value)'" >&2
    exit 1
  fi
}
try missing 0 1790408000
set_value 1700000000; try stale 0 1790408000
set_value '-'; try literal-dash 0 1790408000
set_value '  oct 22 '; try whitespace-invalid 0 1790408000
set_value ' 1700000000 '; try padded-stale 0 1790408000
set_value 1792999999; try concurrent-higher 2 1792999999
set_value 18446744075502679816; try huge-future 2 18446744075502679816
set_value 1790408000; try equal 2 1790408000
# A row the environment sets (COCALC_SETTING_*) is never touched.
set_value 1700000000
"${PSQL[@]}" -c "UPDATE server_settings SET readonly = true WHERE name = 'version_min_browser'"
try readonly-stale 3 1700000000
[[ "$("${PSQL[@]}" -c "SELECT count(*) FROM server_settings WHERE name='_last_update'")" == 1 ]]
echo "browser version postgres tests passed"
