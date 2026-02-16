#!/usr/bin/env bash
set -Eeuo pipefail

export NAME="cocalc-launchpad"
export MAIN="bundle/index.js"
export VERSION="$npm_package_version"

FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"   # must match your sea-config.json
MACHINE="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
SIGN_ID="${COCALC_LAUNCHPAD_SIGN_ID:-}"
ENTITLEMENTS="${COCALC_LAUNCHPAD_ENTITLEMENTS:-entitlements.plist}"

# final single-file executable
TARGET="./$NAME-$VERSION-$MACHINE-$OS"

NODE_BIN="$(command -v node)"

echo "Building SEA for $OS"

# 1) Stage the node runtime we’ll inject into
cp "$NODE_BIN" "$TARGET"
chmod u+w "$TARGET"   # make sure it's writable even if copied from system paths

cp ../build/bundle.tar.xz cocalc.tar.xz
envsubst < ./cocalc-template.js  > cocalc.js

# 2) Bundle app into a SEA blob
#    This writes ./sea-prep.blob using your sea-config.json
node --experimental-sea-config sea-config.json

# 3) Platform-specific injection and signing
case "$OS" in
  darwin)
    # Remove existing signature before mutation (ok if it fails on already-unsigned copy)
    codesign --remove-signature "$TARGET" || true

    # Inject the SEA blob into the Mach-O binary, specifying the segment name for macOS
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

    # Re-sign so macOS will run it (Developer ID if provided, otherwise ad-hoc)
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
    # Inject into the ELF binary (no Mach-O segment flag on Linux)
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

rm cocalc.js cocalc.tar.xz sea-prep.blob

mv $TARGET $NAME
mkdir $TARGET
mv $NAME $TARGET
cd $TARGET
ln -s $NAME node
cd ..
tar Jcvf $TARGET.tar.xz $TARGET
rm -rf $TARGET

mkdir -p ../build/sea
mv $TARGET.tar.xz ../build/sea

cd ../build/sea

ls -lh $TARGET.tar.xz

echo "Built `pwd`/$TARGET.tar.xz"
