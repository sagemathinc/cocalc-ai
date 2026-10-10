#!/usr/bin/env bash
set -euo pipefail

# Build the CoCalc project-host container runtime against the same userspace as
# production hosts. Source archives and the compiler are checksum pinned; the
# output never replaces the host's distro Podman.

PODMAN_VERSION="${PODMAN_VERSION:-5.8.6}"
CONMON_VERSION="${CONMON_VERSION:-2.2.1}"
CRUN_VERSION="${CRUN_VERSION:-1.29.1}"
GO_VERSION="${GO_VERSION:-1.25.14}"
RUST_VERSION="${RUST_VERSION:-1.83.0}"
NETAVARK_VERSION="${NETAVARK_VERSION:-1.16.1}"
AARDVARK_VERSION="${AARDVARK_VERSION:-1.16.0}"
# pasta (from passt) carries every project's network traffic. Ubuntu 24.04's
# 2024-02 build leaves Nagle on for its host-side sockets, which delays the
# second of two quick small writes by the peer's delayed ACK (~40 ms).
PASST_VERSION="${PASST_VERSION:-2026_10_02.cba3570}"
PASST_COMMIT="${PASST_COMMIT:-cba357068dc586e7540971eb40bb56c5e62c4de1}"
BUILD_IMAGE="${COCALC_CONTAINER_RUNTIME_BUILD_IMAGE:-ubuntu:24.04}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
ARCH="${COCALC_CONTAINER_RUNTIME_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported container runtime architecture: $ARCH" >&2; exit 2 ;;
esac
OUTPUT="$BUILD_DIR/container-runtime-linux-$ARCH.tar.xz"

case "$ARCH" in
  amd64)
    GO_SHA256="a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712"
    RUST_TARGET="x86_64-unknown-linux-gnu"
    RUST_SHA256="bd9d53d09d4b60826288336de19fb9c5c7592081e4e4520d6de2f65ee8d79087"
    CRUN_SHA256="0a5ea25cafe618bbfbf1c747871155063619f18025ccdd8ad648c97633f35d57"
    ;;
  arm64)
    GO_SHA256="9bf234ea70ffec9347fdf6b22ce4add51717d3386a38a441e8c8743fceb5eaee"
    RUST_TARGET="aarch64-unknown-linux-gnu"
    RUST_SHA256="ec70c500e2744f0db55bd495ef90534a31fd9c0d5f5a2d752182a59e439ddee3"
    CRUN_SHA256="1ea99c6fc7a8e17a4a1d666df09cccb0769a4db0aa738cf38c967a777a731b1d"
    ;;
esac

PODMAN_SHA256="107eb5b04fa1133a309204b6d888bc21c7750c53d9f714dcca28b81ed38a45eb"
CONMON_SHA256="814fb5979a3a4b8576b1f901e606b482bebb41cb7e57926e6d5765ee786b96d3"
NETAVARK_SHA256="e655fcd882fe891bcc8328ddcfff3745831c8b1013ae59f012d37ce87175b0b3"
AARDVARK_SHA256="6c84a3371087d6af95407b0d3de26cdc1e720ae8cd983a9bdaec8883e2216959"
PASST_SHA256="2bd6f52562a201e8960c17d6ae459a10bb18dc7ef2e7fa617ec82a872db9e403"

if [[ "${1:-}" != "--inner" ]]; then
  ENGINE="${COCALC_CONTAINER_BUILD_ENGINE:-}"
  if [[ -z "$ENGINE" ]]; then
    if command -v podman >/dev/null 2>&1; then
      ENGINE=podman
    elif command -v docker >/dev/null 2>&1; then
      ENGINE=docker
    else
      echo "building the container runtime requires podman or docker" >&2
      exit 1
    fi
  fi

  mkdir -p "$BUILD_DIR"
  TMP="$(mktemp -d)"
  cleanup() { rm -rf "$TMP"; }
  trap cleanup EXIT
  cp "$0" "$TMP/build.sh"
  chmod 755 "$TMP/build.sh"

  # Rootful Docker leaves the build tree owned by root, which the host-side
  # cleanup cannot remove. Rootless podman and rootless Docker already map
  # container root to the invoking user, where a chown would map to a
  # subordinate UID instead.
  WORK_OWNER=""
  if [[ "$ENGINE" == "docker" ]] &&
    ! docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
    WORK_OWNER="$(id -u):$(id -g)"
  fi

  "$ENGINE" run --rm \
    --platform "linux/$ARCH" \
    -e COCALC_RUNTIME_BUILD_INNER=1 \
    -e WORK_OWNER="$WORK_OWNER" \
    -e PODMAN_VERSION="$PODMAN_VERSION" \
    -e CONMON_VERSION="$CONMON_VERSION" \
    -e CRUN_VERSION="$CRUN_VERSION" \
    -e GO_VERSION="$GO_VERSION" \
    -e GO_SHA256="$GO_SHA256" \
    -e RUST_VERSION="$RUST_VERSION" \
    -e RUST_TARGET="$RUST_TARGET" \
    -e RUST_SHA256="$RUST_SHA256" \
    -e NETAVARK_VERSION="$NETAVARK_VERSION" \
    -e AARDVARK_VERSION="$AARDVARK_VERSION" \
    -e PASST_VERSION="$PASST_VERSION" \
    -e PASST_COMMIT="$PASST_COMMIT" \
    -e PODMAN_SHA256="$PODMAN_SHA256" \
    -e CONMON_SHA256="$CONMON_SHA256" \
    -e CRUN_SHA256="$CRUN_SHA256" \
    -e NETAVARK_SHA256="$NETAVARK_SHA256" \
    -e AARDVARK_SHA256="$AARDVARK_SHA256" \
    -e PASST_SHA256="$PASST_SHA256" \
    -e ARCH="$ARCH" \
    -v "$TMP:/work" \
    "$BUILD_IMAGE" bash /work/build.sh --inner

  test -s "$TMP/container-runtime-linux-$ARCH.tar.xz"
  install -m 0644 "$TMP/container-runtime-linux-$ARCH.tar.xz" "$OUTPUT"
  echo "$OUTPUT"
  exit 0
fi

if [[ "${1:-}" != "--inner" || "${COCALC_RUNTIME_BUILD_INNER:-}" != "1" ]]; then
  echo "internal container runtime builder invocation is invalid" >&2
  exit 2
fi

# Hand the build tree back even when a step fails, so the host-side cleanup
# can always remove it.
if [[ -n "${WORK_OWNER:-}" ]]; then
  trap 'chown -R "$WORK_OWNER" /work' EXIT
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  autoconf automake ca-certificates curl gcc git jq libapparmor-dev \
  libassuan-dev libbtrfs-dev libcap-dev libdevmapper-dev libglib2.0-dev \
  libgpg-error-dev libgpgme-dev libseccomp-dev libsystemd-dev libtool \
  libyajl-dev make pkg-config protobuf-compiler xz-utils
rm -rf /var/lib/apt/lists/*

fetch() {
  local url="$1" sha="$2" dest="$3"
  curl -fL --retry 5 --retry-all-errors "$url" -o "$dest"
  echo "$sha  $dest" | sha256sum -c -
}

SRC=/work/src
STAGE=/work/stage/container-runtime
mkdir -p "$SRC" "$STAGE/bin" "$STAGE/etc/containers" "$STAGE/share/cocalc"

GO_ARCHIVE="$SRC/go.tar.gz"
fetch "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" "$GO_SHA256" "$GO_ARCHIVE"
# Go releases must be installed into an empty tree; extracting over an older
# release can leave stale standard-library files and produce invalid builds.
if [[ -d /usr/local/go ]]; then
  find /usr/local/go -depth -delete
fi
tar -xzf "$GO_ARCHIVE" -C /usr/local
export GOROOT=/usr/local/go
export PATH="/usr/local/go/bin:$PATH"
# Fail rather than silently downloading an unpinned compiler requested by a
# dependency's go.mod toolchain directive.
export GOTOOLCHAIN=local

PODMAN_ARCHIVE="$SRC/podman.tar.gz"
CONMON_ARCHIVE="$SRC/conmon.tar.gz"
CRUN_BINARY="$SRC/crun"
NETAVARK_ARCHIVE="$SRC/netavark.tar.gz"
AARDVARK_ARCHIVE="$SRC/aardvark.tar.gz"
PASST_ARCHIVE="$SRC/passt.tar.xz"
fetch "https://github.com/podman-container-tools/podman/archive/refs/tags/v${PODMAN_VERSION}.tar.gz" "$PODMAN_SHA256" "$PODMAN_ARCHIVE"
fetch "https://github.com/containers/conmon/archive/refs/tags/v${CONMON_VERSION}.tar.gz" "$CONMON_SHA256" "$CONMON_ARCHIVE"
fetch "https://github.com/containers/crun/releases/download/${CRUN_VERSION}/crun-${CRUN_VERSION}-linux-${ARCH}" "$CRUN_SHA256" "$CRUN_BINARY"
fetch "https://github.com/containers/netavark/archive/refs/tags/v${NETAVARK_VERSION}.tar.gz" "$NETAVARK_SHA256" "$NETAVARK_ARCHIVE"
fetch "https://github.com/containers/aardvark-dns/archive/refs/tags/v${AARDVARK_VERSION}.tar.gz" "$AARDVARK_SHA256" "$AARDVARK_ARCHIVE"
fetch "https://passt.top/passt/snapshot/passt-${PASST_COMMIT}.tar.xz" "$PASST_SHA256" "$PASST_ARCHIVE"
tar -xzf "$PODMAN_ARCHIVE" -C "$SRC"
tar -xzf "$CONMON_ARCHIVE" -C "$SRC"
tar -xzf "$NETAVARK_ARCHIVE" -C "$SRC"
tar -xzf "$AARDVARK_ARCHIVE" -C "$SRC"
tar -xJf "$PASST_ARCHIVE" -C "$SRC"

RUST_ARCHIVE="$SRC/rust.tar.gz"
fetch "https://static.rust-lang.org/dist/2024-11-28/rust-${RUST_VERSION}-${RUST_TARGET}.tar.gz" "$RUST_SHA256" "$RUST_ARCHIVE"
tar -xzf "$RUST_ARCHIVE" -C "$SRC"
"$SRC/rust-${RUST_VERSION}-${RUST_TARGET}/install.sh" --prefix=/usr/local --disable-ldconfig
export LD_LIBRARY_PATH="/usr/local/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

make -C "$SRC/podman-$PODMAN_VERSION" -j"$(nproc)" \
  BUILDTAGS="seccomp apparmor systemd" bin/podman
install -m 0755 "$SRC/podman-$PODMAN_VERSION/bin/podman" "$STAGE/bin/podman"

make -C "$SRC/conmon-$CONMON_VERSION" -j"$(nproc)"
install -m 0755 "$SRC/conmon-$CONMON_VERSION/bin/conmon" "$STAGE/bin/conmon"

install -m 0755 "$CRUN_BINARY" "$STAGE/bin/crun"

cargo build --locked --release --manifest-path "$SRC/netavark-$NETAVARK_VERSION/Cargo.toml"
install -m 0755 "$SRC/netavark-$NETAVARK_VERSION/target/release/netavark" "$STAGE/bin/netavark"
cargo build --locked --release --manifest-path "$SRC/aardvark-dns-$AARDVARK_VERSION/Cargo.toml"
install -m 0755 "$SRC/aardvark-dns-$AARDVARK_VERSION/target/release/aardvark-dns" "$STAGE/bin/aardvark-dns"

# Podman finds pasta through helper_binaries_dir below, ahead of the distro
# copy. The pasta names are links to passt, which picks its mode from argv[0];
# on x86_64 passt re-executes its own path plus .avx2 when the CPU supports it.
PASST_BINARIES=(passt pasta)
if [[ "$ARCH" == amd64 ]]; then
  PASST_BINARIES+=(passt.avx2 pasta.avx2)
fi
make -C "$SRC/passt-$PASST_COMMIT" -j"$(nproc)" VERSION="$PASST_VERSION" \
  "${PASST_BINARIES[@]}"
install -m 0755 "$SRC/passt-$PASST_COMMIT/passt" "$STAGE/bin/passt"
ln -s passt "$STAGE/bin/pasta"
if [[ "$ARCH" == amd64 ]]; then
  install -m 0755 "$SRC/passt-$PASST_COMMIT/passt.avx2" "$STAGE/bin/passt.avx2"
  ln -s passt.avx2 "$STAGE/bin/pasta.avx2"
fi

cat > "$STAGE/etc/containers/containers.conf" <<'EOF'
[engine]
conmon_path = ["/opt/cocalc/container-runtime/current/bin/conmon"]
helper_binaries_dir = ["/opt/cocalc/container-runtime/current/bin", "/usr/libexec/podman", "/usr/lib/podman", "/usr/local/libexec/podman"]
runtime = "/opt/cocalc/container-runtime/current/bin/crun"

[network]
network_backend = "netavark"
EOF

for binary in podman conmon crun netavark aardvark-dns passt; do
  ldd "$STAGE/bin/$binary" > "$STAGE/share/cocalc/ldd-$binary.txt" || true
done

jq -n \
  --arg podman "$PODMAN_VERSION" \
  --arg conmon "$CONMON_VERSION" \
  --arg crun "$CRUN_VERSION" \
  --arg netavark "$NETAVARK_VERSION" \
  --arg aardvark "$AARDVARK_VERSION" \
  --arg passt "$PASST_VERSION" \
  --arg passt_commit "$PASST_COMMIT" \
  --arg passt_sha256 "$PASST_SHA256" \
  --arg go "$GO_VERSION" \
  --arg arch "$ARCH" \
  --arg podman_sha256 "$PODMAN_SHA256" \
  --arg conmon_sha256 "$CONMON_SHA256" \
  --arg crun_sha256 "$CRUN_SHA256" \
  '{schema:"cocalc-container-runtime-v1",os:"linux",arch:$arch,build_userspace:"ubuntu:24.04",components:{podman:{version:$podman,source_sha256:$podman_sha256},conmon:{version:$conmon,source_sha256:$conmon_sha256},crun:{version:$crun,binary_sha256:$crun_sha256},netavark:{version:$netavark},aardvark_dns:{version:$aardvark},passt:{version:$passt,commit:$passt_commit,source_sha256:$passt_sha256},go:{version:$go}},host_contract:{database_backend:"sqlite",cgroup_manager:"cgroupfs",network_backend:"netavark",required_commands:["catatonit","fuse-overlayfs","iptables","nft","pasta","slirp4netns"]}}' \
  > "$STAGE/share/cocalc/runtime-manifest.json"

for binary in podman conmon crun netavark aardvark-dns pasta; do
  "$STAGE/bin/$binary" --version > "$STAGE/share/cocalc/version-$binary.txt" 2>&1
done

tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner \
  -C /work/stage -cJf "/work/container-runtime-linux-$ARCH.tar.xz" container-runtime
