set -euo pipefail

prefix="${PREFIX:-/opt/overleaf}"

command -v cocalc-overleaf
command -v node
command -v npm
test -x "$prefix/native/start-overleaf.sh"
test -f "$prefix/native/overleaf.env"
test -d "$prefix/services/web/public"
node -e "require('$prefix/package.json')"
