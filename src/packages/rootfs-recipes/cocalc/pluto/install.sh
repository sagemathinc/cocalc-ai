set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

depot="${DEPOT:-/opt/julia-depot}"
$SUDO mkdir -p "$depot" /opt/pluto/examples
$SUDO chown -R "$(id -u):$(id -g)" "$depot" /opt/pluto

export JULIA_DEPOT_PATH="$depot"
julia -e 'using Pkg; Pkg.add("Pluto"); Pkg.precompile()'

cat > /opt/pluto/examples/hello-pluto.jl <<'EOF'
### A Pluto.jl notebook ###
# v0.20.0

using Markdown
using InteractiveUtils

# ╔═╡ 00000000-0000-0000-0000-000000000001
md"# Hello from CoCalc RootFS + Pluto"

# ╔═╡ 00000000-0000-0000-0000-000000000002
2 + 2
EOF

$SUDO chmod -R go+rX "$depot" /opt/pluto
