set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-content-actions}"
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

$SUDO mkdir -p "$prefix/examples/subdir"
$SUDO tee "$prefix/examples/hello.txt" >/dev/null <<'EOF'
Hello from a RootFS content action.
EOF
$SUDO tee "$prefix/examples/subdir/notes.md" >/dev/null <<'EOF'
# RootFS content actions

This directory is safe to browse or copy into HOME.
EOF
$SUDO chmod -R go+rX "$prefix"
