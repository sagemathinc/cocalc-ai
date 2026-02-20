#!/usr/bin/env bash
set -euo pipefail

ROOT="$(realpath "$(dirname "$0")/../../..")"
SEA_DIR="$(realpath "$(dirname "$0")")"
BUILD_DIR="$ROOT/packages/cli/build/sea"
BUNDLE_ENTRY="$ROOT/packages/cli/build/bundle/index.js"
NAME="cocalc-cli"
VERSION="${npm_package_version:-$(node -p "require('$ROOT/packages/cli/package.json').version")}"
MACHINE="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
NODE_BIN="$(command -v node)"
TARGET="$BUILD_DIR/$NAME-$VERSION-$MACHINE-$OS"
SIGN_ID="${COCALC_CLI_SIGN_ID:-}"
ENTITLEMENTS="${COCALC_CLI_ENTITLEMENTS:-entitlements.plist}"

echo "Building CoCalc CLI SEA for $OS/$MACHINE"

"$SEA_DIR/build-bundle.sh"

if [ ! -f "$BUNDLE_ENTRY" ]; then
  echo "ERROR: missing bundle entry: $BUNDLE_ENTRY" >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
cp "$NODE_BIN" "$TARGET"
chmod u+w "$TARGET"

cp "$BUNDLE_ENTRY" "$SEA_DIR/cocalc.js"

cd "$SEA_DIR"
node --experimental-sea-config sea-config.json

FUSE="$(strings "$NODE_BIN" | rg -o 'NODE_SEA_FUSE_[a-f0-9]+' -m 1 || true)"
if [ -z "$FUSE" ]; then
  echo "ERROR: unable to detect NODE_SEA_FUSE from node binary" >&2
  exit 1
fi

case "$OS" in
  darwin)
    codesign --remove-signature "$TARGET" || true
    env -u npm_config_npm_globalconfig \
      -u npm_config_verify_deps_before_run \
      -u npm_config__jsr_registry \
      -u npm_config_enable_pre_post_scripts \
      -u npm_config_package_import_method \
      -u npm_config_git_checks \
      NPM_CONFIG_LOGLEVEL=error \
      npx -y postject "$TARGET" NODE_SEA_BLOB ./sea-prep.blob \
      --sentinel-fuse "$FUSE" \
      --macho-segment-name NODE_SEA
    if [[ -n "$SIGN_ID" ]]; then
      codesign --force --sign "$SIGN_ID" \
        --options runtime \
        --entitlements "$ENTITLEMENTS" \
        "$TARGET"
    else
      codesign --force --sign - "$TARGET"
    fi
    ;;
  linux)
    env -u npm_config_npm_globalconfig \
      -u npm_config_verify_deps_before_run \
      -u npm_config__jsr_registry \
      -u npm_config_enable_pre_post_scripts \
      -u npm_config_package_import_method \
      -u npm_config_git_checks \
      NPM_CONFIG_LOGLEVEL=error \
      npx -y postject "$TARGET" NODE_SEA_BLOB ./sea-prep.blob \
      --sentinel-fuse "$FUSE"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 2
    ;;
esac

rm -f cocalc.js sea-prep.blob sea.term
ln -sfn "$(basename "$TARGET")" "$BUILD_DIR/$NAME"

echo "Built $TARGET"
ls -lh "$TARGET"
ls -lh "$BUILD_DIR/$NAME"
