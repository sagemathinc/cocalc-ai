set -euo pipefail

test -f "${PREFIX:-/opt/cocalc-content-actions}/examples/hello.txt"
test -d "${PREFIX:-/opt/cocalc-content-actions}/examples/subdir"
