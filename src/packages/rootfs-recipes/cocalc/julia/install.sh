set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

version="${VERSION:-1.12.6}"
prefix="${INSTALL_PREFIX:-/opt/julia}"
julia_depot="${JULIA_DEPOT:-/opt/julia-depot}"
ijulia_version="${IJULIA_VERSION:-1.34.4}"
kernel_name="${KERNEL_NAME:-julia}"
kernel_display_name="${KERNEL_DISPLAY_NAME:-Julia}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"
major_minor="$(printf '%s\n' "$version" | awk -F. '{print $1 "." $2}')"
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) julia_path_arch="x64"; julia_archive_arch="x86_64" ;;
  aarch64|arm64) julia_path_arch="aarch64"; julia_archive_arch="aarch64" ;;
  *) echo "unsupported architecture: $machine" >&2; exit 1 ;;
esac

archive="julia-${version}-linux-${julia_archive_arch}.tar.gz"
url="https://julialang-s3.julialang.org/bin/linux/${julia_path_arch}/${major_minor}/${archive}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$url" -o "$tmp/$archive"
$SUDO mkdir -p "$prefix"
$SUDO tar -xzf "$tmp/$archive" -C "$prefix" --strip-components=1
$SUDO ln -sf "$prefix/bin/julia" /usr/local/bin/julia
$SUDO chmod -R go+rX "$prefix"

$SUDO mkdir -p "$julia_depot"
$SUDO chown -R "$(id -u):$(id -g)" "$julia_depot"
IJULIA_VERSION="$ijulia_version" \
  JULIA_DEPOT_PATH="$julia_depot" \
  JULIA_PKG_PRECOMPILE_AUTO=0 \
  "$prefix/bin/julia" --startup-file=no <<'JL'
using Pkg
version = get(ENV, "IJULIA_VERSION", "")
spec = isempty(version) ? Pkg.PackageSpec(name = "IJulia") : Pkg.PackageSpec(name = "IJulia", version = version)
Pkg.add(spec)
Pkg.precompile()
JL

kernel_jl="$(
  JULIA_DEPOT_PATH="$julia_depot" \
    "$prefix/bin/julia" --startup-file=no -e 'using IJulia; print(joinpath(dirname(pathof(IJulia)), "kernel.jl"))'
)"
if [ ! -f "$kernel_jl" ]; then
  echo "IJulia kernel entry point not found: $kernel_jl" >&2
  exit 1
fi

kernel_dir="/usr/local/share/jupyter/kernels/$kernel_name"
$SUDO rm -rf "$kernel_dir"
$SUDO mkdir -p "$kernel_dir"
$SUDO tee "$kernel_dir/kernel.json" >/dev/null <<EOF
{
  "argv": [
    "/usr/local/bin/julia",
    "-i",
    "--color=yes",
    "--project=@.",
    "$kernel_jl",
    "{connection_file}"
  ],
  "display_name": "$kernel_display_name",
  "language": "julia",
  "env": {
    "JULIA_DEPOT_PATH": "$julia_depot"
  }
}
EOF

$SUDO chown -R "$owner_uid:$owner_gid" "$prefix" "$julia_depot"
$SUDO chmod -R u+rwX,go+rX "$prefix" "$julia_depot"
$SUDO chmod -R go+rX "$kernel_dir"
