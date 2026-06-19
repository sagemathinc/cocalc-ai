set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

version="${VERSION:-1.11.5}"
prefix="${INSTALL_PREFIX:-/opt/julia}"
major_minor="$(printf '%s\n' "$version" | awk -F. '{print $1 "." $2}')"
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) julia_arch="x86_64" ;;
  aarch64|arm64) julia_arch="aarch64" ;;
  *) echo "unsupported architecture: $machine" >&2; exit 1 ;;
esac

archive="julia-${version}-linux-${julia_arch}.tar.gz"
url="https://julialang-s3.julialang.org/bin/linux/${julia_arch}/${major_minor}/${archive}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$url" -o "$tmp/$archive"
$SUDO mkdir -p "$prefix"
$SUDO tar -xzf "$tmp/$archive" -C "$prefix" --strip-components=1
$SUDO ln -sf "$prefix/bin/julia" /usr/local/bin/julia
$SUDO chmod -R go+rX "$prefix"
