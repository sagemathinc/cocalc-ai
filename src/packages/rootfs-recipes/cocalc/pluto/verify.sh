set -euo pipefail

julia -e 'import Pluto'
test -d /opt/pluto/examples
