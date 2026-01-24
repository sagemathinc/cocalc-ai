#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$CLOUD_DIR/build/connector"
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

VERSION="${CONNECTOR_VERSION:-$(node -p "require('${CLOUD_DIR}/package.json').version")}"
NAME="cocalc-self-host-connector"

mkdir -p "$OUT_DIR"

build_target() {
  local goos="$1"
  local goarch="$2"
  local target="$OUT_DIR/${NAME}-${VERSION}-${goos}-${goarch}"
  local sign_script="$SCRIPT_DIR/macos-sign-binary.sh"

  echo "Building $target"
  env CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o "$target" .

  if [[ "$goos" == "darwin" ]]; then
    if [[ -x "$sign_script" ]]; then
      "$sign_script" "$target" "$VERSION" "$NAME" || {
        echo "macOS signing failed for $target." >&2
        echo "Make sure you're running this on a local terminal session, not over SSH." >&2
        rm -f "$target"
        exit 1
      }
    else
      echo "macos-sign-binary.sh not found; cannot sign $target." >&2
      echo "Make sure you're running this on a local terminal session, not over SSH." >&2
      rm -f "$target"
      exit 1
    fi
  fi
}

build_target linux amd64
build_target linux arm64
if [[ "$HOST_OS" == "darwin" ]]; then
  build_target darwin arm64
else
  echo "Skipping darwin build on ${HOST_OS}; codesigning requires macOS." >&2
fi

ls -lh "$OUT_DIR"
echo "Built connector binaries in $OUT_DIR"
