#!/usr/bin/env bash
set -Eeuo pipefail

# Install a pinned headless Chromium for one architecture into
# <dest>/chromium, for the shared browser (`cocalc project browser start`).
# This is part of the project tools bundle, so every project has a working
# browser at /opt/cocalc/bin2/chromium/chromium with nothing to install.
#
# The browser is Playwright's chromium-headless-shell build (no GTK, Pango or
# Cairo). The shared libraries it needs beyond glibc are taken from Ubuntu
# 20.04 packages, so they need nothing newer than glibc 2.31 and do not depend
# on what the project image provides. The wrapper puts them on
# LD_LIBRARY_PATH for the browser process only.
#
# Usage:
#   ./install-chromium.sh <amd64|arm64> <dest-dir>

ARCH="${1:?architecture required}"
DEST="${2:?destination required}"

# Playwright 1.57 (Chromium 143.0.7499.4).
CHROMIUM_REVISION="1200"
case "$ARCH" in
  amd64)
    ZIP="chromium-headless-shell-linux.zip"
    ZIP_SHA256="a9a525cb3832d59a810f78f8ba6c5ed3592a6a488984627f5d827c2a365c8a5a"
    ZIP_DIR="chrome-headless-shell-linux64"
    ZIP_BIN="chrome-headless-shell"
    MIRROR="http://archive.ubuntu.com/ubuntu"
    ;;
  arm64)
    ZIP="chromium-headless-shell-linux-arm64.zip"
    ZIP_SHA256="2321e3d1d497b21b79aa822d6c9e13c5b155249a9df7cf028f009f1159907c75"
    ZIP_DIR="chrome-linux"
    ZIP_BIN="headless_shell"
    MIRROR="http://ports.ubuntu.com/ubuntu-ports"
    ;;
  *) echo "Unsupported Chromium architecture: $ARCH" >&2; exit 1 ;;
esac
SUITE="focal"

# Packages providing every library the browser needs that is not part of
# glibc/libgcc (checked below, so a missing one fails the build).
PACKAGES=(
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libblkid1 libbsd0
  libdbus-1-3 libdrm2 libexpat1 libffi7 libgbm1 libgcrypt20 libglib2.0-0
  libgpg-error0 liblz4-1 liblzma5 libmount1 libnspr4 libnss3 libpcre2-8-0
  libpcre3 libselinux1 libsqlite3-0 libsystemd0 libudev1 libwayland-server0 libx11-6
  libxau6 libxcb-randr0 libxcb1 libxcomposite1 libxdamage1 libxdmcp6 libxext6
  libxfixes3 libxi6 libxkbcommon0 libxrandr2 libxrender1 libzstd1
)
# Provided by every glibc system.
BASE_LIBS=" libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 librt.so.1 \
libresolv.so.2 libgcc_s.so.1 libz.so.1 ld-linux-x86-64.so.2 \
ld-linux-aarch64.so.1 "

INSTALL="$DEST/chromium"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
rm -rf "$INSTALL"
mkdir -p "$INSTALL"

echo "  - Downloading Chromium headless shell r$CHROMIUM_REVISION ($ARCH)"
curl -sSfL --retry 3 -o "$WORK/$ZIP" \
  "https://cdn.playwright.dev/builds/chromium/$CHROMIUM_REVISION/$ZIP"
echo "$ZIP_SHA256  $WORK/$ZIP" | sha256sum -c --quiet -
python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
  "$WORK/$ZIP" "$WORK/unzip"
mv "$WORK/unzip/$ZIP_DIR" "$INSTALL/browser"
if [ "$ZIP_BIN" != chrome-headless-shell ]; then
  mv "$INSTALL/browser/$ZIP_BIN" "$INSTALL/browser/chrome-headless-shell"
fi
chmod +x "$INSTALL/browser/chrome-headless-shell"
# Packaging metadata for distro installers; not used here.
rm -f "$INSTALL/browser/deb.deps" "$INSTALL/browser/rpm.deps"

echo "  - Downloading Ubuntu $SUITE libraries ($ARCH)"
INDEX="$WORK/Packages"
for pocket in "$SUITE" "$SUITE-updates" "$SUITE-security"; do
  for component in main universe; do
    curl -sSfL --retry 3 \
      "$MIRROR/dists/$pocket/$component/binary-$ARCH/Packages.xz" |
      xz -dc >>"$INDEX"
    echo >>"$INDEX"
  done
done
mkdir -p "$WORK/debs" "$WORK/root" "$INSTALL/lib" "$INSTALL/share/licenses"
for package in "${PACKAGES[@]}"; do
  # Pick the highest version across the release, updates and security pockets.
  read -r version filename sha256 < <(
    awk -v p="$package" '
      $1 == "Package:" { cur = $2; v = ""; f = ""; s = "" }
      cur == p && $1 == "Version:" { v = $2 }
      cur == p && $1 == "Filename:" { f = $2 }
      cur == p && $1 == "SHA256:" { s = $2 }
      cur == p && $0 == "" && f != "" { print v, f, s; cur = "" }
    ' "$INDEX" | sort -V -k1,1 | tail -1
  ) || true
  if [ -z "${filename:-}" ]; then
    echo "Missing Ubuntu package $package for $ARCH" >&2
    exit 1
  fi
  deb="$WORK/debs/$(basename "$filename")"
  curl -sSfL --retry 3 -o "$deb" "$MIRROR/$filename"
  echo "$sha256  $deb" | sha256sum -c --quiet -
  dpkg-deb -x "$deb" "$WORK/root"
  if [ -f "$WORK/root/usr/share/doc/$package/copyright" ]; then
    cp "$WORK/root/usr/share/doc/$package/copyright" \
      "$INSTALL/share/licenses/$package.copyright"
  fi
  unset version filename sha256
done
find "$WORK/root" -name '*.so*' \( -type f -o -type l \) \
  -exec cp -a {} "$INSTALL/lib/" \;

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
printf 'chromium-headless-shell r%s (%s), libraries from Ubuntu %s\n' \
  "$CHROMIUM_REVISION" "$ARCH" "$SUITE" >"$INSTALL/VERSION"
du -sh "$INSTALL" | awk '{print "  - Chromium installed: " $1}'
