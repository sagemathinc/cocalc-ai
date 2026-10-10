#!/usr/bin/env bash
set -Eeuo pipefail

# Install a pinned headless Chromium for one architecture into
# <dest>/cocalc-chromium, for the shared browser (`cocalc project browser start`).
# This is part of the project tools bundle, so every project has a working
# browser at /opt/cocalc/bin2/cocalc-chromium/chromium with nothing to install.
#
# The browser is Chrome for Testing's headless shell (no GTK, Pango or Cairo),
# the Stable channel's, pinned by SHA256.  Keep it current: it loads
# arbitrary websites.  To update, take the Stable version from
# https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json
# (check-chromium-version.py says when it is behind), set CHROME_VERSION and
# both ZIP_SHA256 below, and rebuild the tools. The shared libraries it needs beyond glibc are
# taken from Ubuntu 20.04 packages, so they need nothing newer than glibc 2.31
# and do not depend on what the project image provides. The wrapper puts them
# on LD_LIBRARY_PATH for the browser process only.
#
# Every input is pinned: the .deb files and their SHA256 are listed in
# chromium-libs.lock (made by pin-chromium-libs.py from Ubuntu's signed
# indexes), so a build downloads nothing it has not checked, and builds are
# reproducible.
#
# Usage:
#   ./install-chromium.sh <amd64|arm64> <dest-dir>

ARCH="${1:?architecture required}"
DEST="${2:?destination required}"

CHROME_VERSION="155.0.8059.39"
case "$ARCH" in
  amd64)
    PLATFORM="linux64"
    ZIP_SHA256="39dcb8c46550632a3d911850ab3b8af840b4e3f6d8622faa2018eb8756278786"
    MIRROR="https://archive.ubuntu.com/ubuntu"
    ;;
  arm64)
    PLATFORM="linux-arm64"
    ZIP_SHA256="9fb86f7c0b2734c5febc0bbb4e85f37da43553f3f8a7970949828c5713e87e94"
    MIRROR="https://ports.ubuntu.com/ubuntu-ports"
    ;;
  *) echo "Unsupported Chromium architecture: $ARCH" >&2; exit 1 ;;
esac
SUITE="focal"
# The library packages and their exact files (checked below too: a missing
# library fails the build).
LOCK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/chromium-libs.lock"
# Provided by every glibc system.
BASE_LIBS=" libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 \
libresolv.so.2 libgcc_s.so.1 libz.so.1 ld-linux-x86-64.so.2 \
ld-linux-aarch64.so.1 "

# Not "chromium": bin2 is on PATH, and a directory must not shadow a browser.
INSTALL="$DEST/cocalc-chromium"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$INSTALL"
mkdir -p "$INSTALL"

ZIP="chrome-headless-shell-$PLATFORM.zip"
echo "  - Downloading Chrome headless shell $CHROME_VERSION ($ARCH)"
curl -sSfL --proto '=https' --retry 3 -o "$WORK/$ZIP" \
  "https://storage.googleapis.com/chrome-for-testing-public/$CHROME_VERSION/$PLATFORM/$ZIP"
echo "$ZIP_SHA256  $WORK/$ZIP" | sha256sum -c --quiet -
python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
  "$WORK/$ZIP" "$WORK/unzip"
mv "$WORK/unzip/chrome-headless-shell-$PLATFORM" "$INSTALL/browser"
chmod +x "$INSTALL/browser/chrome-headless-shell"
# Packaging metadata for distro installers; not used here.
rm -f "$INSTALL/browser/deb.deps" "$INSTALL/browser/rpm.deps"

echo "  - Downloading pinned Ubuntu $SUITE libraries ($ARCH)"
mkdir -p "$WORK/debs" "$WORK/root" "$INSTALL/lib" "$INSTALL/share/licenses"
count=0
while read -r arch package version filename sha256; do
  case "$arch" in "" | "#"*) continue ;; esac
  [ "$arch" = "$ARCH" ] || continue
  case "$filename" in pool/*.deb) ;; *)
    echo "Bad file in $LOCK: $filename" >&2
    exit 1
    ;;
  esac
  deb="$WORK/debs/$(basename "$filename")"
  curl -sSfL --proto '=https' --retry 3 -o "$deb" "$MIRROR/$filename"
  echo "$sha256  $deb" | sha256sum -c --quiet -
  dpkg-deb -x "$deb" "$WORK/root"
  if [ -f "$WORK/root/usr/share/doc/$package/copyright" ]; then
    cp "$WORK/root/usr/share/doc/$package/copyright" \
      "$INSTALL/share/licenses/$package.copyright"
  fi
  count=$((count + 1))
done <"$LOCK"
if [ "$count" -eq 0 ]; then
  echo "No pinned libraries for $ARCH in $LOCK" >&2
  exit 1
fi
# Flatten into lib/: copy the real files, then point each symlink at the
# file it resolves to (some, like NSS's, are relative to other directories).
find "$WORK/root" -name '*.so*' -type f -exec cp -a {} "$INSTALL/lib/" \;
find "$WORK/root" -name '*.so*' -type l | while read -r link; do
  target="$(basename "$(readlink -f "$link")")"
  name="$(basename "$link")"
  [ "$target" = "$name" ] || ln -sfn "$target" "$INSTALL/lib/$name"
done
for lib in "$INSTALL"/lib/*; do
  if [ ! -e "$lib" ]; then
    echo "Bundled Chromium has a dangling library link: $lib" >&2
    exit 1
  fi
done

# Every library the browser loads must be bundled or part of glibc/libgcc.
missing=""
for elf in "$INSTALL/browser/chrome-headless-shell" "$INSTALL"/browser/*.so* \
  "$INSTALL"/lib/*.so*; do
  [ -L "$elf" ] && continue
  for needed in $(readelf -d "$elf" 2>/dev/null |
    awk '/NEEDED/ { gsub(/[][]/, "", $5); print $5 }'); do
    case "$BASE_LIBS" in *" $needed "*) continue ;; esac
    if [ ! -e "$INSTALL/lib/$needed" ] && [ ! -e "$INSTALL/browser/$needed" ]; then
      missing="$missing $(basename "$elf"):$needed"
    fi
  done
done
if [ -n "$missing" ]; then
  echo "Bundled Chromium has unresolved libraries:$missing" >&2
  exit 1
fi

cat >"$INSTALL/chromium" <<'EOF'
#!/usr/bin/env sh
# Headless Chromium bundled with CoCalc (see install-chromium.sh).
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
LD_LIBRARY_PATH="$DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# The bundled GLib must not load the image's GIO modules.
GIO_MODULE_DIR="$DIR/lib/gio-modules"
export LD_LIBRARY_PATH GIO_MODULE_DIR
exec "$DIR/browser/chrome-headless-shell" "$@"
EOF
chmod +x "$INSTALL/chromium"
printf 'chrome-headless-shell %s (%s), libraries from Ubuntu %s\n' \
  "$CHROME_VERSION" "$ARCH" "$SUITE" >"$INSTALL/VERSION"
du -sh "$INSTALL" | awk '{print "  - Chromium installed: " $1}'
