set -euo pipefail

export JULIA_DEPOT_PATH="${DEPOT:-/opt/julia-depot}${JULIA_DEPOT_PATH:+:$JULIA_DEPOT_PATH}"
julia -e 'import Pluto'
test -d /opt/pluto/examples
