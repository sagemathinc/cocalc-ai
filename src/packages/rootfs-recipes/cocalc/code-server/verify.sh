set -euo pipefail

prefix="${PREFIX:-/opt/code-server}"
version="${VERSION:-latest}"
extensions="${EXTENSIONS:-}"
extensions_dir="${EXTENSIONS_DIR:-/opt/code-server/extensions}"
user_data_dir="${USER_DATA_DIR:-/opt/code-server/user-data}"

command -v code-server
code-server --version
test -x "$prefix/bin/code-server"
test -d "$extensions_dir"
test -d "$user_data_dir"

if [ "$version" != "latest" ] && [ -n "$version" ]; then
  code-server --version | head -n 1 | grep -q "^${version}$"
fi

if [ -n "$extensions" ]; then
  installed="$(code-server --extensions-dir "$extensions_dir" --list-extensions)"
  for extension in $extensions; do
    printf '%s\n' "$installed" | grep -Fx "$extension"
  done
fi
