#!/usr/bin/env bash
set -Eeuo pipefail

# Build a minimal tools tarball for CoCalc Plus (rg/fd/dust/ouch).
#
# Usage:
#   ./build-tools-minimal.sh [output-directory]
#
# Builds linux/amd64, linux/arm64, and darwin/arm64 from any host by
# overriding target platform/arch via env vars.

ROOT="$(realpath "$(dirname "$0")/../../..")"
OUT_DIR="${1:-$ROOT/packages/project/build}"
WORK_DIR="$OUT_DIR/tools-minimal"
CLI_PKG_DIR="$ROOT/packages/cli"
CLI_BUNDLE_JS="$CLI_PKG_DIR/build/bundle/index.js"
CLI_BUNDLE_LICENSES="$CLI_PKG_DIR/build/bundle/licenses.txt"

TARGETS=(
  "linux:amd64"
  "linux:arm64"
  "darwin:arm64"
)

TOOLS=(rg fd ouch)

echo "Building CoCalc minimal tools bundle..."
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

for TARGET in "${TARGETS[@]}"; do
  OS="${TARGET%%:*}"
  ARCH="${TARGET##*:}"
  echo "- Building tools-minimal for ${OS}/${ARCH}"
  rm -rf "$WORK_DIR/bin" "$WORK_DIR/share"
  mkdir -p "$WORK_DIR/bin" "$WORK_DIR/share"
  COCALC_BIN_PATH="$WORK_DIR/bin" \
  COCALC_TOOL_PLATFORM="$OS" \
  COCALC_TOOL_ARCH="$ARCH" \
    node -e 'const { install } = require("@cocalc/backend/sandbox/install");(async () => {for (const app of ["rg","fd","ouch"]) {await install(app);}})().catch((err)=>{console.error(err);process.exit(1);});'
  install_cocalc_cli_runtime "$WORK_DIR"
  TARGET_FILE="$OUT_DIR/tools-minimal-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET_FILE"
  tar -C "$WORK_DIR" -Jcf "$TARGET_FILE" bin share
  echo "  - Tools-minimal bundle created at $TARGET_FILE"
done
