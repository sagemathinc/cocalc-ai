#!/usr/bin/env bash
set -Eeuo pipefail

# Build a tools tarball containing the project host helper binaries
# (dropbear, rg, rustic, codex, Claude Code, headless Chromium, etc.) from the local build output.
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
BACKEND_PKG_DIR="$ROOT/packages/backend"
CLI_BUNDLE_JS="$CLI_PKG_DIR/build/bundle/index.js"
CLI_BUNDLE_LICENSES="$CLI_PKG_DIR/build/bundle/licenses.txt"
X11_LAUNCHER="$(dirname "$0")/cocalc-x11"
CLAUDE_INSTALLER="$(cd "$(dirname "$0")" && pwd)/install-claude-code.sh"
CLAUDE_SOURCE="$ROOT/packages/project/managed-harnesses"
CHROMIUM_INSTALLER="$(cd "$(dirname "$0")" && pwd)/install-chromium.sh"

source "$(dirname "$0")/tools-cache.sh"
CACHE_ROOT="$(cocalc_tools_cache_root)"
CACHE_DIRS_USED=()

echo "Building CoCalc tools bundle..."
echo "  root: $ROOT"
echo "  out : $OUT_DIR"
echo "  cache: $CACHE_ROOT"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "- Building cocalc-cli JS bundle"
pnpm --dir "$CLI_PKG_DIR" build:bundle
if [ ! -f "$CLI_BUNDLE_JS" ]; then
  echo "Missing cocalc-cli bundle entrypoint: $CLI_BUNDLE_JS" >&2
  exit 1
fi

REFLECT_BUILD="$OUT_DIR/reflect-runtime"
bash "$(dirname "$0")/build-reflect.sh" "$REFLECT_BUILD"

echo "- Building tool installer"
pnpm --dir "$BACKEND_PKG_DIR" exec tsc --build

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

  install -m 0755 "$X11_LAUNCHER" "$work_dir/bin/cocalc-x11"
  install -m 0755 "$REFLECT_BUILD/reflect" "$work_dir/bin/reflect"
  install -m 0644 "$REFLECT_BUILD/reflect.mjs" "$work_dir/bin/reflect.mjs"
  mkdir -p "$work_dir/share/licenses/reflect"
  install -m 0644 "$REFLECT_BUILD/LICENSE.txt" "$work_dir/share/licenses/reflect/LICENSE.txt"
}

# Claude Code is cached separately from the downloaded binaries: its inputs
# are the pinned lockfile, CoCalc's adapter patch and the installer.
claude_code_cache_key() {
  local arch="$1"
  local hash
  hash="$(
    cat "$CLAUDE_SOURCE/package.json" "$CLAUDE_SOURCE/package-lock.json" \
      "$CLAUDE_SOURCE/patch-claude-agent-acp.cjs" "$CLAUDE_INSTALLER" |
      sha256sum | awk '{print $1}'
  )"
  printf 'tools-claude-code-%s-%s-%s\n' "$OS" "$arch" "$hash"
}

install_claude_code() {
  local arch="$1"
  local work_dir="$2"
  local cache_dir="$CACHE_ROOT/$(claude_code_cache_key "$arch")"
  local stage="$work_dir.claude-code"
  rm -rf "$stage"
  mkdir -p "$stage/bin" "$stage/share"
  if cocalc_tools_restore_cache "$cache_dir" "$stage"; then
    echo "  - Restored Claude Code from cache: $cache_dir"
  else
    bash "$CLAUDE_INSTALLER" "$arch" "$stage/bin"
    cocalc_tools_save_cache "$cache_dir" "$stage"
  fi
  rm -rf "$work_dir/bin/claude-code"
  mv "$stage/bin/claude-code" "$work_dir/bin/claude-code"
  ln -sfn claude-code/bin/claude "$work_dir/bin/claude"
  rm -rf "$stage"
}

# Headless Chromium for the shared browser, cached by its pinned installer
# and the library pins it reads.
chromium_cache_key() {
  local arch="$1"
  printf 'tools-chromium-%s-%s-%s-%s\n' "$OS" "$arch" \
    "$(cocalc_tools_hash_file "$CHROMIUM_INSTALLER")" \
    "$(cocalc_tools_hash_file "$(dirname "$CHROMIUM_INSTALLER")/chromium-libs.lock")"
}

install_chromium() {
  local arch="$1"
  local work_dir="$2"
  local cache_dir="$CACHE_ROOT/$(chromium_cache_key "$arch")"
  local stage="$work_dir.chromium"
  rm -rf "$stage"
  mkdir -p "$stage/bin" "$stage/share"
  if cocalc_tools_restore_cache "$cache_dir" "$stage"; then
    echo "  - Restored Chromium from cache: $cache_dir"
  else
    bash "$CHROMIUM_INSTALLER" "$arch" "$stage/bin"
    cocalc_tools_save_cache "$cache_dir" "$stage"
  fi
  rm -rf "$work_dir/bin/cocalc-chromium"
  mv "$stage/bin/cocalc-chromium" "$work_dir/bin/cocalc-chromium"
  rm -rf "$stage"
}

# Each architecture is built in its own work directory, so both are built in
# parallel; compression uses all cores (xz -T0).
build_arch() {
  local ARCH="$1"
  local ARCH_WORK_DIR="$WORK_DIR/$ARCH"
  echo "- Building tools for ${OS}/${ARCH}"
  rm -rf "$ARCH_WORK_DIR"
  mkdir -p "$ARCH_WORK_DIR/bin" "$ARCH_WORK_DIR/share"
  local CACHE_KEY CACHE_DIR
  CACHE_KEY="$(cocalc_tools_cache_key "$ROOT" "tools" "$OS" "$ARCH" "all")"
  CACHE_DIR="$CACHE_ROOT/$CACHE_KEY"
  if cocalc_tools_restore_cache "$CACHE_DIR" "$ARCH_WORK_DIR"; then
    echo "  - Restored downloaded tools from cache: $CACHE_DIR"
  else
    (
      cd "$BACKEND_PKG_DIR"
      COCALC_BIN_PATH="$ARCH_WORK_DIR/bin" \
      COCALC_TOOL_PLATFORM="$OS" \
      COCALC_TOOL_ARCH="$ARCH" \
        node -e 'require("./dist/sandbox/install").install()'
    )
    cocalc_tools_save_cache "$CACHE_DIR" "$ARCH_WORK_DIR"
    echo "  - Saved downloaded tools cache: $CACHE_DIR"
  fi
  install_claude_code "$ARCH" "$ARCH_WORK_DIR"
  install_chromium "$ARCH" "$ARCH_WORK_DIR"
  install_cocalc_cli_runtime "$ARCH_WORK_DIR"
  local TARGET="$OUT_DIR/tools-${OS}-${ARCH}.tar.xz"
  rm -f "$TARGET"
  tar -C "$ARCH_WORK_DIR" -cf - bin share | xz -T0 >"$TARGET.tmp"
  mv "$TARGET.tmp" "$TARGET"
  echo "  - Tools bundle created at $TARGET"
}

PIDS=()
for ARCH in "${ARCHES[@]}"; do
  CACHE_DIRS_USED+=("$CACHE_ROOT/$(cocalc_tools_cache_key "$ROOT" "tools" "$OS" "$ARCH" "all")")
  CACHE_DIRS_USED+=("$CACHE_ROOT/$(claude_code_cache_key "$ARCH")")
  CACHE_DIRS_USED+=("$CACHE_ROOT/$(chromium_cache_key "$ARCH")")
  build_arch "$ARCH" &
  PIDS+=("$!")
done
FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || FAILED=1
done
if [ "$FAILED" = "1" ]; then
  echo "Building tools failed" >&2
  exit 1
fi

cocalc_tools_prune_cache "$CACHE_ROOT" "${CACHE_DIRS_USED[@]}"
