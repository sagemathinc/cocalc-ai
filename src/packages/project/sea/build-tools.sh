#!/usr/bin/env bash
set -Eeuo pipefail

# Build a tools tarball containing the project host helper binaries
# (dropbear, rg, rustic, etc.) from the local build output.
#
# Usage:
#   ./build-tools.sh [output-directory]
#
# The script downloads prebuilt tool binaries (via sandbox/install) and emits
# packages/project/build/tools-<os>-<arch>.tar.xz by default. It can build
# both linux/amd64 and linux/arm64 from a single host by overriding target
# arch via env vars.

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT_DIR="${1:-$ROOT/packages/project/build}"
WORK_DIR="$OUT_DIR/tools"
OS="linux"
ARCHES=("amd64" "arm64")
CLI_PKG_DIR="$ROOT/packages/cli"
CLI_BUNDLE_JS="$CLI_PKG_DIR/build/bundle/index.js"
CLI_BUNDLE_LICENSES="$CLI_PKG_DIR/build/bundle/licenses.txt"

echo "Building CoCalc tools bundle..."
echo "  root: $ROOT"
echo "  out : $OUT_DIR"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "- Building cocalc-cli JS bundle"
pnpm --dir "$CLI_PKG_DIR" build:bundle
if [ ! -f "$CLI_BUNDLE_JS" ]; then
  echo "Missing cocalc-cli bundle entrypoint: $CLI_BUNDLE_JS" >&2
  exit 1
fi

install_cocalc_cli_runtime() {
  local work_dir="$1"
  mkdir -p "$work_dir/bin" "$work_dir/share/licenses/cocalc-cli"

  cp "$CLI_BUNDLE_JS" "$work_dir/bin/cocalc-cli.js"
  chmod +x "$work_dir/bin/cocalc-cli.js"

  cat >"$work_dir/bin/cocalc" <<'EOF'
#!/usr/bin/env sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/cocalc-cli.js" "$@"
EOF
  chmod +x "$work_dir/bin/cocalc"
  ln -sf cocalc "$work_dir/bin/cocalc-cli"

  if [ -f "$CLI_BUNDLE_LICENSES" ]; then
    cp "$CLI_BUNDLE_LICENSES" \
      "$work_dir/share/licenses/cocalc-cli/licenses.txt"
  fi
}

for ARCH in "${ARCHES[@]}"; do
  echo "- Building tools for ${OS}/${ARCH}"
  rm -rf "$WORK_DIR/bin" "$WORK_DIR/share"
  mkdir -p "$WORK_DIR/bin" "$WORK_DIR/share"
  COCALC_BIN_PATH="$WORK_DIR/bin" \
  COCALC_TOOL_PLATFORM="$OS" \
  COCALC_TOOL_ARCH="$ARCH" \
    node -e 'require("@cocalc/backend/sandbox/install").install()'
  install_cocalc_cli_runtime "$WORK_DIR"
  TARGET="$OUT_DIR/tools-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET"
  tar -C "$WORK_DIR" -Jcf "$TARGET" bin share
  echo "  - Tools bundle created at $TARGET"
done
