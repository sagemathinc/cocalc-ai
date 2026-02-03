#!/usr/bin/env bash
set -Eeuo pipefail

# CoCalc Plus installer (SEA + minimal tools).
# Usage:
#   curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash

BASE_URL="${COCALC_PLUS_BASE_URL:-https://software.cocalc.ai/software}"
CHANNEL="${COCALC_PLUS_CHANNEL:-latest}"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

if [[ "$OS" != "linux" && "$OS" != "darwin" ]]; then
  echo "Unsupported OS: $OS" >&2
  exit 1
fi

if [[ "$OS" == "darwin" && "$ARCH" != "arm64" ]]; then
  echo "Only macOS arm64 is supported right now." >&2
  exit 1
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
INSTALL_ROOT="${COCALC_PLUS_HOME:-$DATA_HOME/cocalc-plus}"
BIN_DIR="$INSTALL_ROOT/bin"
TOOLS_DIR="$INSTALL_ROOT/tools"

PLUS_MANIFEST_URL="${BASE_URL}/cocalc-plus/${CHANNEL}-${OS}-${ARCH}.json"
TOOLS_MANIFEST_URL="${BASE_URL}/tools-minimal/${CHANNEL}-${OS}-${ARCH}.json"

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need_cmd curl

sha256_check() {
  local file="$1"
  local expected="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    echo "${expected}  ${file}" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null 2>&1; then
    echo "${expected}  ${file}" | shasum -a 256 -c - >/dev/null
  else
    echo "Missing sha256sum/shasum for checksum verification." >&2
    exit 1
  fi
}

get_json_field() {
  local file="$1"
  local field="$2"
  tr -d '\n' < "$file" | sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
}

download() {
  local url="$1"
  local out="$2"
  curl -fsSL "$url" -o "$out"
}

mkdir -p "$BIN_DIR" "$TOOLS_DIR" "$BIN_HOME"

echo "Downloading CoCalc Plus manifest..."
download "$PLUS_MANIFEST_URL" "$tmpdir/plus.json"
PLUS_URL="$(get_json_field "$tmpdir/plus.json" "url")"
PLUS_SHA="$(get_json_field "$tmpdir/plus.json" "sha256")"

if [[ -z "$PLUS_URL" || -z "$PLUS_SHA" ]]; then
  echo "Invalid plus manifest at $PLUS_MANIFEST_URL" >&2
  exit 1
fi

PLUS_BIN="$BIN_DIR/cocalc-plus-${PLUS_SHA}"
if [[ ! -x "$PLUS_BIN" ]]; then
  echo "Downloading CoCalc Plus binary..."
  download "$PLUS_URL" "$tmpdir/plus.bin"
  sha256_check "$tmpdir/plus.bin" "$PLUS_SHA"
  chmod +x "$tmpdir/plus.bin"
  mv "$tmpdir/plus.bin" "$PLUS_BIN"
fi
ln -sfn "$PLUS_BIN" "$BIN_DIR/cocalc-plus"

echo "Downloading tools-minimal manifest..."
download "$TOOLS_MANIFEST_URL" "$tmpdir/tools.json"
TOOLS_URL="$(get_json_field "$tmpdir/tools.json" "url")"
TOOLS_SHA="$(get_json_field "$tmpdir/tools.json" "sha256")"

if [[ -z "$TOOLS_URL" || -z "$TOOLS_SHA" ]]; then
  echo "Invalid tools manifest at $TOOLS_MANIFEST_URL" >&2
  exit 1
fi

TOOLS_ROOT="$TOOLS_DIR/$TOOLS_SHA"
if [[ ! -d "$TOOLS_ROOT/bin" ]]; then
  echo "Downloading tools-minimal bundle..."
  download "$TOOLS_URL" "$tmpdir/tools.tar.xz"
  sha256_check "$tmpdir/tools.tar.xz" "$TOOLS_SHA"
  mkdir -p "$TOOLS_ROOT"
  tar -C "$TOOLS_ROOT" -Jxf "$tmpdir/tools.tar.xz"
fi
ln -sfn "$TOOLS_ROOT" "$TOOLS_DIR/current"

WRAPPER="$BIN_HOME/cocalc-plus"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export COCALC_BIN_PATH="$TOOLS_DIR/current/bin"
exec "$BIN_DIR/cocalc-plus" "\$@"
EOF
chmod +x "$WRAPPER"

PATH_LINE="export PATH=\"$BIN_HOME:\$PATH\""
FISH_LINE="set -gx PATH \"$BIN_HOME\" \$PATH"

if ! echo "$PATH" | tr ':' '\n' | grep -Fx "$BIN_HOME" >/dev/null; then
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [[ "$shell_name" == "fish" ]]; then
    if ! grep -Fqs "$FISH_LINE" "$rc" 2>/dev/null; then
      echo "$FISH_LINE" >> "$rc"
    fi
  else
    if ! grep -Fqs "$PATH_LINE" "$rc" 2>/dev/null; then
      echo "$PATH_LINE" >> "$rc"
    fi
  fi
  echo "Added $BIN_HOME to PATH in $rc. Restart your shell or run:"
  echo "  $PATH_LINE"
fi

echo "CoCalc Plus installed. Run: cocalc-plus"
