/*
 * <site>/cli/install.sh (distribution Phase A): a POSIX sh installer for the
 * site's current CLI release, generated with every hash embedded.
 *
 * It downloads the pinned Node, the bootstrap and the bundle from this origin
 * only (no redirects are followed), checks each one's size and sha256, and then
 * hands over to the new CLI (`cocalc update --finish-install`), which records
 * the origin and switches the `active` pointer with the same transaction
 * every later update uses.
 */

import {
  CLI_PLATFORMS,
  type CliReleaseManifest,
} from "@cocalc/util/cli-distribution/schema";

// Single-quote for POSIX sh.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installScript({
  origin,
  manifestHash,
  manifestSize,
  manifest,
}: {
  origin: string;
  manifestHash: string;
  manifestSize: number;
  manifest: CliReleaseManifest;
}): string {
  if (!/^https?:\/\/[A-Za-z0-9.:\[\]/_-]+$/.test(origin)) {
    throw new Error(`unusable origin: ${origin}`);
  }
  const platformCases = CLI_PLATFORMS.flatMap((platform) => {
    const archive = manifest.node.platforms[platform];
    if (archive == null) return [];
    return [
      `  ${platform})`,
      `    node_sha=${archive.sha256}`,
      `    node_size=${archive.size}`,
      `    node_dir=${shQuote(archive.dir)}`,
      `    node_bin_sha=${archive.binary.sha256}`,
      `    node_bin_size=${archive.binary.size}`,
      `    ;;`,
    ];
  }).join("\n");

  return `#!/bin/sh
# CoCalc CLI installer: ${origin}, CLI release ${manifest.release}.
#
# This installs the CLI for your user only, under
# \${XDG_DATA_HOME:-~/.local/share}/cocalc/cli with a launcher in ~/.local/bin.
# Installing it gives ${origin} full code execution as your user, now and on
# every update, and updates come only from ${origin}.
set -eu

origin=${shQuote(origin)}
release=${manifest.release}
manifest=${manifestHash}
manifest_size=${manifestSize}
bootstrap=${manifest.bootstrap.sha256}
bootstrap_size=${manifest.bootstrap.size}
bundle=${manifest.bundle.sha256}
bundle_size=${manifest.bundle.size}
launcher_sha=${manifest.launcher.sha256}
launcher_size=${manifest.launcher.size}

say() { printf '%s\\n' "$*"; }
die() {
  printf 'cocalc install: %s\\n' "$*" >&2
  exit 1
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported operating system: $os (Linux and macOS are supported; on Windows, use WSL2)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported processor: $arch" ;;
esac
# The official Node needs glibc. A glibc system may also have the musl package
# (/lib/ld-musl-*, as on many Ubuntu images), so refuse only without glibc.
if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1 &&
  ls /lib/ld-musl-* >/dev/null 2>&1; then
  die "musl-based Linux (such as Alpine) is not supported yet"
fi
platform="$os-$arch"
case "$platform" in
${platformCases}
  *) die "no CLI build for $platform" ;;
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

root="\${COCALC_CLI_ROOT:-\${XDG_DATA_HOME:-$HOME/.local/share}/cocalc/cli}"
bindir="\${XDG_BIN_HOME:-$HOME/.local/bin}"
launcher="$bindir/cocalc"
[ -L "$root" ] && die "$root is a symbolic link; refusing to install there"

say "Installing the CoCalc CLI (release $release) from $origin."
say "This gives $origin full code execution as your user, now and on every update."

umask 077
mkdir -p "$root/staging" "$root/node" "$root/targets" "$root/manifests"
(umask 022 && mkdir -p "$bindir")
staging=$(mktemp -d "$root/staging/install.XXXXXX")
trap 'rm -rf "$staging"' EXIT INT TERM

# fetch <path> <file> <size> <sha256>: from this origin only, never redirected.
fetch() {
  curl -fsS --retry 2 --connect-timeout 20 -o "$2" "$origin$1" ||
    die "download failed: $origin$1"
  got_size=$(wc -c <"$2" | tr -d ' ')
  [ "$got_size" = "$3" ] || die "$origin$1 has the wrong size ($got_size, expected $3)"
  [ "$(sha256 "$2")" = "$4" ] || die "$origin$1 does not match its sha256"
}

# intact <file> <size> <sha256>: an existing file is reused only if intact.
intact() {
  [ -f "$1" ] && [ ! -L "$1" ] &&
    [ "$(wc -c <"$1" | tr -d ' ')" = "$2" ] &&
    [ "$(sha256 "$1")" = "$3" ]
}

# put <dir> <name> <size> <sha256>: install targets/<sha256>/<name>, replacing
# a damaged copy.
put() {
  if ! intact "$root/targets/$4/$2" "$3" "$4"; then
    mkdir "$staging/$1"
    fetch "/cli/files/$manifest/$4" "$staging/$1/$2" "$3" "$4"
    rm -rf "$root/targets/$4"
    mv "$staging/$1" "$root/targets/$4"
  fi
}

if ! intact "$root/node/$node_sha/bin/node" "$node_bin_size" "$node_bin_sha"; then
  say "Downloading Node for $platform..."
  fetch "/cli/files/$manifest/$node_sha" "$staging/node.tar.gz" "$node_size" "$node_sha"
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

# The official Node needs a few system libraries, e.g. libatomic.so.1, which
# minimal container images lack: name the missing ones instead of failing later.
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
node="$root/node/$node_sha/bin/node"
if ! "$node" --version >/dev/null 2>&1; then
  missing=$(ldd "$node" 2>/dev/null | awk '/not found/ { printf "%s ", $1 }')
  [ -n "$missing" ] || die "Node ($node_dir) does not run on this system"
  hint=""
  case " $missing" in
    *" libatomic.so.1 "*)
      hint=" (on Debian or Ubuntu: sudo apt-get install libatomic1; on Fedora or RHEL: sudo dnf install libatomic)"
      ;;
  esac
  die "Node needs system libraries that are missing: $missing$hint. Install them and run this again."
fi

say "Downloading the CLI..."
put bootstrap bootstrap.js "$bootstrap_size" "$bootstrap"
put bundle cocalc.js "$bundle_size" "$bundle"
fetch "/cli/manifests/$manifest.json" "$staging/manifest.json" "$manifest_size" "$manifest"
cp "$staging/manifest.json" "$root/manifests/$manifest.json"
fetch "/cli/files/$manifest/$launcher_sha" "$staging/launcher" "$launcher_size" "$launcher_sha"

unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
# The new CLI finishes the install: it records the origin (asking first if
# this replaces another site), installs the launcher and switches \`active\`.
COCALC_CLI_ROOT="$root" \\
  COCALC_CLI_ACTIVE="v1 $manifest $node_sha $bootstrap $bundle" \\
  "$root/node/$node_sha/bin/node" \\
  "$root/targets/$bootstrap/bootstrap.js" "$root/targets/$bundle/cocalc.js" \\
  update --finish-install \\
  --origin "$origin" \\
  --manifest-file "$staging/manifest.json" \\
  --launcher-file "$staging/launcher" \\
  --launcher-path "$launcher" </dev/null ||
  die "the install did not complete"

case ":$PATH:" in
  *":$bindir:"*)
    say "Done. Run: cocalc --help"
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
    say "Done. Open a new shell (or run: export PATH=\\"$bindir:\\$PATH\\"), then run: cocalc --help"
    ;;
esac
`;
}
