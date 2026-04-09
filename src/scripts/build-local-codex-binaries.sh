#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UPSTREAM_DIR="${CODEX_UPSTREAM_DIR:-/home/wstein/upstream/codex}"
CODEX_VERSION="${CODEX_VERSION:-0.118.0}"
CODEX_TAG="rust-v${CODEX_VERSION}"
CODEX_BRANCH="cocalc-tcp-user-timeout-v${CODEX_VERSION}"
PATCH_FILE="${REPO_ROOT}/src/scripts/patches/codex-rust-v0.118.0-tcp-user-timeout.patch"
LOCAL_BIN_ROOT="${COCALC_CODEX_LOCAL_BIN_DIR:-${REPO_ROOT}/src/.cache/codex-binaries}"
CARGO_MANIFEST="${UPSTREAM_DIR}/codex-rs/Cargo.toml"
ARM_LINKER="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER:-aarch64-linux-gnu-gcc}"
ARM64_BUILD_TOOL="${CODEX_ARM64_BUILD_TOOL:-auto}"
ARM64_PKG_CONFIG_PATH="${AARCH64_UNKNOWN_LINUX_GNU_PKG_CONFIG_PATH:-/usr/lib/aarch64-linux-gnu/pkgconfig}"
ARM64_RELEASE_LTO="${CODEX_ARM64_RELEASE_LTO:-off}"
ARM64_RELEASE_CODEGEN_UNITS="${CODEX_ARM64_RELEASE_CODEGEN_UNITS:-16}"
ARM64_SYSROOT_LIB_DIR="${AARCH64_UNKNOWN_LINUX_GNU_LIB_DIR:-/usr/lib/aarch64-linux-gnu}"

if [[ ! -d "${UPSTREAM_DIR}/.git" ]]; then
  echo "Missing upstream codex checkout at ${UPSTREAM_DIR}" >&2
  exit 1
fi

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "Missing patch file at ${PATCH_FILE}" >&2
  exit 1
fi

require_arm64_cross_libs() {
  local missing=0
  for lib in openssl.pc libcap.so liblzma.so libbz2.so; do
    case "${lib}" in
      openssl.pc)
        if [[ ! -f "${ARM64_PKG_CONFIG_PATH}/${lib}" ]]; then
          missing=1
        fi
        ;;
      *)
        if [[ ! -e "${ARM64_SYSROOT_LIB_DIR}/${lib}" ]]; then
          missing=1
        fi
        ;;
    esac
  done
  if [[ "${missing}" != "0" ]]; then
    cat >&2 <<EOF
Missing arm64 cross-link prerequisites.

Install them on this laptop with:
  sudo dpkg --add-architecture arm64
  sudo apt-get update
  sudo apt-get install -y libssl-dev:arm64 libcap-dev:arm64 liblzma-dev:arm64 libbz2-dev:arm64
EOF
    exit 1
  fi
}

echo "Using upstream checkout: ${UPSTREAM_DIR}"
echo "Using output directory: ${LOCAL_BIN_ROOT}/${CODEX_VERSION}"

git -C "${UPSTREAM_DIR}" fetch --tags
git -C "${UPSTREAM_DIR}" checkout "${CODEX_TAG}"
git -C "${UPSTREAM_DIR}" switch -C "${CODEX_BRANCH}"
git -C "${UPSTREAM_DIR}" restore codex-rs/Cargo.lock

if ! grep -q 'CODEX_TCP_USER_TIMEOUT_MS' "${UPSTREAM_DIR}/codex-rs/login/src/auth/default_client.rs"; then
  git -C "${UPSTREAM_DIR}" apply "${PATCH_FILE}"
fi

cargo fmt --manifest-path "${CARGO_MANIFEST}" --all >/dev/null
git -C "${UPSTREAM_DIR}" restore codex-rs/Cargo.lock

cargo build --release --locked -p codex-cli --manifest-path "${CARGO_MANIFEST}"
case "${ARM64_BUILD_TOOL}" in
  auto)
    if [[ -f "${ARM64_PKG_CONFIG_PATH}/openssl.pc" ]]; then
      require_arm64_cross_libs
      PKG_CONFIG_ALLOW_CROSS=1 \
        PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
        CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
        cargo build --release --locked --target aarch64-unknown-linux-gnu -p codex-cli --manifest-path "${CARGO_MANIFEST}"
    elif command -v cross >/dev/null 2>&1; then
      CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
        cross build --release --locked --target aarch64-unknown-linux-gnu -p codex-cli --manifest-path "${CARGO_MANIFEST}"
    else
      require_arm64_cross_libs
      PKG_CONFIG_ALLOW_CROSS=1 \
        PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
        CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
        cargo build --release --locked --target aarch64-unknown-linux-gnu -p codex-cli --manifest-path "${CARGO_MANIFEST}"
    fi
    ;;
  cross)
    CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
      cross build --release --locked --target aarch64-unknown-linux-gnu -p codex-cli --manifest-path "${CARGO_MANIFEST}"
    ;;
  cargo)
    require_arm64_cross_libs
    PKG_CONFIG_ALLOW_CROSS=1 \
      PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
      CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
      cargo build --release --locked --target aarch64-unknown-linux-gnu -p codex-cli --manifest-path "${CARGO_MANIFEST}"
    ;;
  *)
    echo "Unsupported CODEX_ARM64_BUILD_TOOL=${ARM64_BUILD_TOOL}" >&2
    exit 1
    ;;
esac

X64_DEST="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-x64"
ARM64_DEST="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-arm64"
mkdir -p "${X64_DEST}" "${ARM64_DEST}"

install -m 755 "${UPSTREAM_DIR}/codex-rs/target/release/codex" "${X64_DEST}/codex"
install -m 755 "${UPSTREAM_DIR}/codex-rs/target/aarch64-unknown-linux-gnu/release/codex" "${ARM64_DEST}/codex"

UPSTREAM_HEAD="$(git -C "${UPSTREAM_DIR}" rev-parse HEAD)"
cat > "${LOCAL_BIN_ROOT}/${CODEX_VERSION}/manifest.json" <<EOF
{
  "version": "${CODEX_VERSION}",
  "tag": "${CODEX_TAG}",
  "branch": "${CODEX_BRANCH}",
  "upstream_head": "${UPSTREAM_HEAD}",
  "x64_binary": "${X64_DEST}/codex",
  "arm64_binary": "${ARM64_DEST}/codex",
  "built_at_utc": "$(date -u +%FT%TZ)"
}
EOF

echo
echo "Built patched codex binaries:"
echo "  x64:   ${X64_DEST}/codex"
echo "  arm64: ${ARM64_DEST}/codex"
echo "Manifest:"
echo "  ${LOCAL_BIN_ROOT}/${CODEX_VERSION}/manifest.json"
