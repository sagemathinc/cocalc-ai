set -euo pipefail

prefix="${PREFIX:-/opt/code-server}"
version="${VERSION:-latest}"

command -v code-server
code-server --version
test -x "$prefix/bin/code-server"

if [ "$version" != "latest" ] && [ -n "$version" ]; then
  code-server --version | head -n 1 | grep -q "^${version}$"
fi
