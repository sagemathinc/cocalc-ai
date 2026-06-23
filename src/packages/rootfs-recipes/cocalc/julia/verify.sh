set -euo pipefail

command -v julia
julia --version
test -f /usr/local/share/jupyter/kernels/julia/kernel.json
JULIA_DEPOT_PATH="${JULIA_DEPOT:-/opt/julia-depot}" julia --startup-file=no -e 'using IJulia; println("IJulia OK")'
