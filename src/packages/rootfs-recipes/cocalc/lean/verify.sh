set -euo pipefail

command -v elan
command -v lean
command -v lake
lean --version
lake --version
tmp="$(mktemp --suffix=.lean)"
cat >"$tmp" <<'LEAN'
def main : IO Unit := IO.println "lean ok"
LEAN
lean --run "$tmp"
rm -f "$tmp"
