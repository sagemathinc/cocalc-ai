#!/usr/bin/env bash
set -Eeuo pipefail

# CoCalc CLI installer.
# Usage:
#   curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash

BASE_URL="${COCALC_CLI_BASE_URL:-https://software.cocalc.ai/software}"
CHANNEL="${COCALC_CLI_CHANNEL:-latest}"

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
if [[ -n "${XDG_BIN_HOME:-}" ]]; then
  BIN_HOME="$XDG_BIN_HOME"
elif [[ "$(id -u)" -eq 0 && -d /usr/local/bin && -w /usr/local/bin ]]; then
  BIN_HOME="/usr/local/bin"
else
  BIN_HOME="$HOME/.local/bin"
fi
INSTALL_ROOT="${COCALC_CLI_HOME:-$DATA_HOME/cocalc}"
VERSIONS_DIR="$INSTALL_ROOT/versions"

MANIFEST_URL="${BASE_URL}/cocalc/${CHANNEL}-${OS}-${ARCH}.json"

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    local hint="${2:-}"
    echo "Missing required command: $1" >&2
    if [[ -n "$hint" ]]; then
      echo "$hint" >&2
    fi
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

mkdir -p "$VERSIONS_DIR" "$BIN_HOME"

echo "Downloading CoCalc CLI manifest..."
download "$MANIFEST_URL" "$tmpdir/cocalc.json"
ASSET_URL="$(get_json_field "$tmpdir/cocalc.json" "url")"
ASSET_SHA="$(get_json_field "$tmpdir/cocalc.json" "sha256")"
ARTIFACT_ID="$(get_json_field "$tmpdir/cocalc.json" "artifact_id")"
VERSION="$(get_json_field "$tmpdir/cocalc.json" "version")"
PUBLISHED_AT="$(get_json_field "$tmpdir/cocalc.json" "published_at")"
GIT_COMMIT="$(get_json_field "$tmpdir/cocalc.json" "commit")"
GIT_SHORT="$(get_json_field "$tmpdir/cocalc.json" "short")"
if [[ -z "$VERSION" && -n "$ARTIFACT_ID" ]]; then
  VERSION="$ARTIFACT_ID"
fi
if [[ -z "$VERSION" && -n "$ASSET_URL" ]]; then
  VERSION="$(echo "$ASSET_URL" | sed -n 's#.*/software/artifacts/cli/\([^/]*\)/.*#\1#p; s#.*/cocalc/\([^/]*\)/.*#\1#p')"
fi

if [[ -z "$ASSET_URL" || -z "$ASSET_SHA" ]]; then
  echo "Invalid cocalc manifest at $MANIFEST_URL" >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  VERSION="$ASSET_SHA"
fi

TARGET_DIR="$VERSIONS_DIR/$VERSION"
TARGET_BIN="$TARGET_DIR/cocalc"
if [[ ! -x "$TARGET_BIN" ]]; then
  echo "Downloading CoCalc CLI artifact..."
  download "$ASSET_URL" "$tmpdir/artifact"
  sha256_check "$tmpdir/artifact" "$ASSET_SHA"

  staging_dir="$tmpdir/version"
  mkdir -p "$staging_dir"

  case "$ASSET_URL" in
    *.tar.gz|*.tgz)
      need_cmd tar "Install the tar package and try again."
      need_cmd gzip "Install the gzip package and try again."
      tar -xzf "$tmpdir/artifact" -C "$staging_dir"
      ;;
    *.tar.xz)
      need_cmd tar "Install the tar package and try again."
      need_cmd xz "Debian/Ubuntu: apt-get install xz-utils; Fedora/RHEL: dnf install xz"
      tar -xJf "$tmpdir/artifact" -C "$staging_dir"
      ;;
    *.xz)
      need_cmd xz "Debian/Ubuntu: apt-get install xz-utils; Fedora/RHEL: dnf install xz"
      xz -dc "$tmpdir/artifact" > "$staging_dir/cocalc"
      ;;
    *.gz)
      need_cmd gzip "Install the gzip package and try again."
      gzip -dc "$tmpdir/artifact" > "$staging_dir/cocalc"
      ;;
    *)
      mv "$tmpdir/artifact" "$staging_dir/cocalc"
      ;;
  esac

  if [[ ! -f "$staging_dir/cocalc" ]]; then
    echo "Downloaded CLI artifact does not contain a cocalc executable." >&2
    exit 1
  fi
  chmod +x "$staging_dir/cocalc"
  rm -rf "$TARGET_DIR"
  mv "$staging_dir" "$TARGET_DIR"
fi

runtime_env=()
if [[ -d "$TARGET_DIR/lib" ]]; then
  runtime_path="$TARGET_DIR/lib"
  if [[ -n "${LD_LIBRARY_PATH:-}" ]]; then
    runtime_path="$runtime_path:$LD_LIBRARY_PATH"
  fi
  runtime_env=(env "LD_LIBRARY_PATH=$runtime_path")
fi
# bash 3.2 (macOS /bin/bash) treats an empty array as unbound under set -u.
if ! smoke_output="$(${runtime_env[@]+"${runtime_env[@]}"} "$TARGET_BIN" --version 2>&1)"; then
  echo "CoCalc CLI was downloaded but could not start:" >&2
  echo "$smoke_output" >&2
  if [[ "$smoke_output" == *"libatomic.so.1"* ]]; then
    echo >&2
    echo "This legacy Linux artifact requires libatomic.so.1." >&2
    echo "Debian/Ubuntu: apt-get install libatomic1" >&2
    echo "Fedora/RHEL: dnf install libatomic" >&2
  fi
  exit 1
fi

ln -sfn "$TARGET_DIR" "$INSTALL_ROOT/current"
mkdir -p "$INSTALL_ROOT/bin"
ln -sfn "$INSTALL_ROOT/current/cocalc" "$INSTALL_ROOT/bin/cocalc"

WRAPPER="$BIN_HOME/cocalc"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
export COCALC_CLI_HOME="$INSTALL_ROOT"
${VERSION:+export COCALC_CLI_VERSION="$VERSION"}
${ARTIFACT_ID:+export COCALC_CLI_ARTIFACT_ID="$ARTIFACT_ID"}
${PUBLISHED_AT:+export COCALC_CLI_PUBLISHED_AT="$PUBLISHED_AT"}
${GIT_COMMIT:+export COCALC_CLI_GIT_COMMIT="$GIT_COMMIT"}
${GIT_SHORT:+export COCALC_CLI_GIT_SHORT="$GIT_SHORT"}
if [[ -d "$INSTALL_ROOT/current/lib" ]]; then
  export COCALC_CLI_PRIVATE_LIB_DIR="$INSTALL_ROOT/current/lib"
  export LD_LIBRARY_PATH="\$COCALC_CLI_PRIVATE_LIB_DIR\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi
exec "$INSTALL_ROOT/bin/cocalc" "\$@"
EOF
chmod +x "$WRAPPER"

cat > "$INSTALL_ROOT/version.json" <<EOF
{
  "version": "$VERSION",
  "artifact_id": "$ARTIFACT_ID",
  "published_at": "$PUBLISHED_AT",
  "git_commit": "$GIT_COMMIT",
  "git_short": "$GIT_SHORT",
  "os": "$OS",
  "arch": "$ARCH",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

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

if command -v cocalc >/dev/null 2>&1; then
  echo "CoCalc CLI installed. Run: cocalc --help"
else
  echo "CoCalc CLI installed. For this shell, run:"
  echo "  $PATH_LINE"
  echo "Then run: cocalc --help"
fi

if ! command -v ssh >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1; then
  echo
  echo "Project SSH commands additionally require an OpenSSH client."
  echo "Debian/Ubuntu: apt-get install openssh-client"
  echo "Fedora/RHEL: dnf install openssh-clients"
fi
