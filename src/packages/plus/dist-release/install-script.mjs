/*
 * <store>/install.sh for CoCalc Plus (distribution Phase A): a POSIX sh
 * installer for one release, generated at publish time with every hash
 * embedded, and served from the release store itself (software.cocalc.ai;
 * no hub is involved).
 *
 * It downloads the pinned Node, the bootstrap, the launcher, the manifest and
 * this platform's app part from the store only (no redirects are followed),
 * checks each one's size and sha256, unpacks the app with Node's built-in
 * zstd, and hands over to it (`cocalc-plus update --finish-install`), which
 * fetches the remaining parts and switches `active` with the same
 * transaction every later update uses.
 */

const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"];

export function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function plusInstallScript({
  origin,
  manifestHash,
  manifestSize,
  manifest,
}) {
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]/_-]+$/.test(origin)) {
    throw new Error(`unusable origin: ${origin}`);
  }
  const cases = PLATFORMS.flatMap((platform) => {
    const node = manifest.node.platforms[platform];
    const app = manifest.app[platform];
    if (node == null || app == null) return [];
    return [
      `  ${platform})`,
      `    node_sha=${node.sha256}`,
      `    node_size=${node.size}`,
      `    node_dir=${shQuote(node.dir)}`,
      `    node_bin_sha=${node.binary.sha256}`,
      `    node_bin_size=${node.binary.size}`,
      `    app_sha=${app.sha256}`,
      `    app_size=${app.size}`,
      `    ;;`,
    ];
  }).join("\n");

  return `#!/bin/sh
# CoCalc Plus installer: release ${manifest.release} (version ${manifest.version}) from ${origin}.
#
# This installs CoCalc Plus for your user only, under
# \${XDG_DATA_HOME:-~/.local/share}/cocalc/plus with a launcher in
# ~/.local/bin/cocalc-plus. Your existing CoCalc Plus data is kept.
# Installing it gives ${origin} full code execution as your user, now and on
# every update, and updates come only from there.
set -eu

origin=${shQuote(origin)}
release=${manifest.release}
version=${shQuote(manifest.version)}
manifest=${manifestHash}
manifest_size=${manifestSize}
bootstrap=${manifest.bootstrap.sha256}
bootstrap_size=${manifest.bootstrap.size}
launcher_sha=${manifest.launcher.sha256}
launcher_size=${manifest.launcher.size}

say() { printf '%s\\n' "$*"; }
die() {
  printf 'cocalc-plus install: %s\\n' "$*" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported operating system: $os (Linux and macOS are supported)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported processor: $arch" ;;
esac
if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
  die "musl-based Linux (such as Alpine) is not supported yet"
fi
platform="$os-$arch"
case "$platform" in
${cases}
  *) die "no CoCalc Plus build for $platform yet" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required"
fi

root="\${COCALC_PLUS_DIST_ROOT:-\${XDG_DATA_HOME:-$HOME/.local/share}/cocalc/plus}"
bindir="\${XDG_BIN_HOME:-$HOME/.local/bin}"
launcher="$bindir/cocalc-plus"
[ -L "$root" ] && die "$root is a symbolic link; refusing to install there"

say "Installing CoCalc Plus $version (release $release) from $origin."
say "This gives $origin full code execution as your user, now and on every update."

umask 077
mkdir -p "$root/staging" "$root/node" "$root/targets" "$root/manifests" "$root/blobs"
(umask 022 && mkdir -p "$bindir")
staging=$(mktemp -d "$root/staging/install.XXXXXX")
trap 'rm -rf "$staging"' EXIT INT TERM

# fetch <path> <file> <size> <sha256>: from the store only, never redirected.
fetch() {
  curl -fsS --retry 2 --connect-timeout 20 -o "$2" "$origin$1" ||
    die "download failed: $origin$1"
  got_size=$(wc -c <"$2" | tr -d ' ')
  [ "$got_size" = "$3" ] || die "$origin$1 has the wrong size ($got_size, expected $3)"
  [ "$(sha256 "$2")" = "$4" ] || die "$origin$1 does not match its sha256"
}

intact() {
  [ -f "$1" ] && [ ! -L "$1" ] &&
    [ "$(wc -c <"$1" | tr -d ' ')" = "$2" ] &&
    [ "$(sha256 "$1")" = "$3" ]
}

if ! intact "$root/node/$node_sha/bin/node" "$node_bin_size" "$node_bin_sha"; then
  say "Downloading Node for $platform..."
  fetch "/files/$node_sha" "$staging/node.tar.gz" "$node_size" "$node_sha"
  mkdir "$staging/node"
  tar -xzf "$staging/node.tar.gz" -C "$staging/node" "$node_dir/bin/node" "$node_dir/LICENSE" ||
    die "could not unpack Node"
  intact "$staging/node/$node_dir/bin/node" "$node_bin_size" "$node_bin_sha" ||
    die "the Node binary does not match the release manifest"
  mkdir -p "$staging/node-tree/bin"
  mv "$staging/node/$node_dir/bin/node" "$staging/node-tree/bin/node"
  mv "$staging/node/$node_dir/LICENSE" "$staging/node-tree/LICENSE"
  chmod 700 "$staging/node-tree/bin/node"
  rm -rf "$root/node/$node_sha"
  mv "$staging/node-tree" "$root/node/$node_sha"
fi
node="$root/node/$node_sha/bin/node"

say "Downloading CoCalc Plus..."
if ! intact "$root/targets/$bootstrap/bootstrap.js" "$bootstrap_size" "$bootstrap"; then
  mkdir "$staging/bootstrap"
  fetch "/files/$bootstrap" "$staging/bootstrap/bootstrap.js" "$bootstrap_size" "$bootstrap"
  rm -rf "$root/targets/$bootstrap"
  mv "$staging/bootstrap" "$root/targets/$bootstrap"
fi
fetch "/manifests/$manifest.json" "$staging/manifest.json" "$manifest_size" "$manifest"
fetch "/files/$launcher_sha" "$staging/launcher" "$launcher_size" "$launcher_sha"
if ! intact "$root/blobs/$app_sha" "$app_size" "$app_sha"; then
  fetch "/files/$app_sha" "$staging/app.tar.zst" "$app_size" "$app_sha"
  mv "$staging/app.tar.zst" "$root/blobs/$app_sha"
fi

# Unpack the app with Node's own zstd (no xz or zstd tools needed).
mkdir "$staging/app"
"$node" -e 'const fs=require("fs"),z=require("zlib");fs.createReadStream(process.argv[1]).pipe(z.createZstdDecompress()).pipe(process.stdout)' \\
  "$root/blobs/$app_sha" | tar -xf - -C "$staging/app" ||
  die "could not unpack CoCalc Plus"
[ -f "$staging/app/bundle/index.js" ] || die "the app part has no bundle/index.js"

# The new CoCalc Plus finishes the install: it fetches the remaining parts,
# assembles the release, installs the launcher and switches \`active\`.
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
COCALC_PLUS_DIST_ROOT="$root" "$node" "$staging/app/bundle/index.js" \\
  update --finish-install \\
  --origin "$origin" \\
  --manifest-file "$staging/manifest.json" \\
  --launcher-file "$staging/launcher" \\
  --launcher-path "$launcher" </dev/null ||
  die "the install did not complete"

case ":$PATH:" in
  *":$bindir:"*)
    say "Done. Start it with: cocalc-plus"
    ;;
  *)
    case "$(basename "\${SHELL:-sh}")" in
      zsh) rc="$HOME/.zshrc"; line="export PATH=\\"$bindir:\\$PATH\\"" ;;
      bash) rc="$HOME/.bashrc"; line="export PATH=\\"$bindir:\\$PATH\\"" ;;
      fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $bindir" ;;
      *) rc="$HOME/.profile"; line="export PATH=\\"$bindir:\\$PATH\\"" ;;
    esac
    if ! grep -Fqs "$line" "$rc" 2>/dev/null; then
      mkdir -p "$(dirname "$rc")"
      printf '%s\\n' "$line" >>"$rc"
      say "Added $bindir to PATH in $rc."
    fi
    say "Done. Open a new shell (or run: export PATH=\\"$bindir:\\$PATH\\"), then start it with: cocalc-plus"
    ;;
esac
`;
}
