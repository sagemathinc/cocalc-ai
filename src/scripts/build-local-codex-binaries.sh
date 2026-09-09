#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UPSTREAM_DIR="${CODEX_UPSTREAM_DIR:-/home/user/upstream/codex}"
CODEX_UPSTREAM_REPO="${CODEX_UPSTREAM_REPO:-https://github.com/openai/codex.git}"
CODEX_VERSION="${CODEX_VERSION:-0.153.4}"
CODEX_TAG="rust-v${CODEX_VERSION}"
CODEX_BRANCH="cocalc-upstream-build-v${CODEX_VERSION}"
# Keep the transport fix scoped to the source version it was validated against.
PATCH_FILES=("${SCRIPT_DIR}/patches/codex-rust-v${CODEX_VERSION}-tcp-user-timeout.patch")
LOCAL_BIN_ROOT="${COCALC_CODEX_LOCAL_BIN_DIR:-${REPO_ROOT}/src/.cache/codex-binaries}"
CARGO_MANIFEST="${UPSTREAM_DIR}/codex-rs/Cargo.toml"
BUILD_PLATFORM="${CODEX_BUILD_PLATFORM:-all}"
HOST_ARCH="$(uname -m)"
ARM_LINKER="${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER:-aarch64-linux-gnu-gcc}"
ARM64_BUILD_TOOL="${CODEX_ARM64_BUILD_TOOL:-auto}"
ARM64_PKG_CONFIG_PATH="${AARCH64_UNKNOWN_LINUX_GNU_PKG_CONFIG_PATH:-/usr/lib/aarch64-linux-gnu/pkgconfig}"
RUST_TOOLCHAIN="${CODEX_RUST_TOOLCHAIN:-1.95.0}"
BUILD_JOBS="${CODEX_BUILD_JOBS:-1}"
RELEASE_LTO="${CODEX_RELEASE_LTO:-off}"
RELEASE_CODEGEN_UNITS="${CODEX_RELEASE_CODEGEN_UNITS:-16}"
ARM64_RELEASE_LTO="${CODEX_ARM64_RELEASE_LTO:-${RELEASE_LTO}}"
ARM64_RELEASE_CODEGEN_UNITS="${CODEX_ARM64_RELEASE_CODEGEN_UNITS:-${RELEASE_CODEGEN_UNITS}}"
ARM64_SYSROOT_LIB_DIR="${AARCH64_UNKNOWN_LINUX_GNU_LIB_DIR:-/usr/lib/aarch64-linux-gnu}"
PUBLISH_AFTER_BUILD="${CODEX_PUBLISH_RELEASE:-0}"
STRIP_BINARIES="${CODEX_STRIP_BINARIES:-1}"
RELEASE_STRIP="${CODEX_RELEASE_STRIP:-symbols}"
if [[ "${STRIP_BINARIES}" != "1" ]]; then
  RELEASE_STRIP="none"
fi
ARM64_RELEASE_STRIP="${CODEX_ARM64_RELEASE_STRIP:-${RELEASE_STRIP}}"

if [[ ! -d "${UPSTREAM_DIR}/.git" ]]; then
  echo "Missing upstream codex checkout at ${UPSTREAM_DIR}" >&2
  exit 1
fi

case "${BUILD_PLATFORM}" in
  all | linux-x64 | linux-arm64) ;;
  *)
    echo "Unsupported CODEX_BUILD_PLATFORM=${BUILD_PLATFORM}; expected all, linux-x64, or linux-arm64" >&2
    exit 1
    ;;
esac

for patch_file in "${PATCH_FILES[@]}"; do
  if [[ ! -f "${patch_file}" ]]; then
    echo "Missing patch file at ${patch_file}" >&2
    exit 1
  fi
done

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

binary_size() {
  stat -c%s "$1" 2>/dev/null || wc -c < "$1"
}

strip_binary_if_available() {
  local binary="$1"
  local label="$2"
  shift 2
  if [[ "${STRIP_BINARIES}" != "1" ]]; then
    echo "Skipping strip for ${label}: CODEX_STRIP_BINARIES=${STRIP_BINARIES}"
    return
  fi

  local before
  before="$(binary_size "${binary}")"
  local tool
  for tool in "$@"; do
    if [[ -z "${tool}" ]] || ! command -v "${tool}" >/dev/null 2>&1; then
      continue
    fi
    if "${tool}" "${binary}"; then
      local after
      after="$(binary_size "${binary}")"
      echo "Stripped ${label} with ${tool}: ${before} -> ${after} bytes"
      return
    fi
  done

  echo "Skipping extra strip for ${label}; no usable strip tool found among: $*"
}

configure_rusty_v8() {
  local target="$1"
  local -a paths
  mapfile -t paths < <(
    cd "${UPSTREAM_DIR}"
    CODEX_REPO_ROOT="${UPSTREAM_DIR}" python3 - "${target}" <<'PY'
import sys

from scripts.codex_package.targets import TARGET_SPECS
from scripts.codex_package.v8 import resolve_codex_v8_cargo_env

env = resolve_codex_v8_cargo_env(TARGET_SPECS[sys.argv[1]])
print(env["RUSTY_V8_ARCHIVE"])
print(env["RUSTY_V8_SRC_BINDING_PATH"])
PY
  )
  if [[ "${#paths[@]}" != "2" ]]; then
    echo "Unable to resolve Codex rusty_v8 artifacts for ${target}" >&2
    exit 1
  fi
  export RUSTY_V8_ARCHIVE="${paths[0]}"
  export RUSTY_V8_SRC_BINDING_PATH="${paths[1]}"
  echo "Using Codex rusty_v8 artifacts for ${target}"
}

echo "Using upstream checkout: ${UPSTREAM_DIR}"
echo "Using upstream source: ${CODEX_UPSTREAM_REPO}"
echo "Using output directory: ${LOCAL_BIN_ROOT}/${CODEX_VERSION}"
echo "Using Rust toolchain: ${RUST_TOOLCHAIN}"
echo "Using Cargo build jobs: ${BUILD_JOBS}"
echo "Building platform: ${BUILD_PLATFORM} on ${HOST_ARCH}"

export RUSTUP_TOOLCHAIN="${RUST_TOOLCHAIN}"

git -C "${UPSTREAM_DIR}" fetch "${CODEX_UPSTREAM_REPO}" "refs/tags/${CODEX_TAG}:refs/tags/${CODEX_TAG}"
if [[ -n "$(git -C "${UPSTREAM_DIR}" status --short --untracked-files=no)" ]]; then
  echo "Refusing to discard tracked changes in ${UPSTREAM_DIR}" >&2
  exit 1
fi
git -C "${UPSTREAM_DIR}" switch -C "${CODEX_BRANCH}" "${CODEX_TAG}"

if [[ "${#PATCH_FILES[@]}" -gt 0 ]]; then
  for patch_file in "${PATCH_FILES[@]}"; do
    git -C "${UPSTREAM_DIR}" apply --whitespace=nowarn "${patch_file}"
  done
fi

cargo metadata --format-version 1 --manifest-path "${CARGO_MANIFEST}" >/dev/null

X64_DEST="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-x64"
ARM64_DEST="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-arm64"
if [[ "${BUILD_PLATFORM}" != "all" ]]; then
  # A selective rebuild invalidates provenance for any previously assembled
  # two-platform release until a new combined manifest is created.
  rm -f "${LOCAL_BIN_ROOT}/${CODEX_VERSION}/manifest.json"
fi

build_x64() {
  if [[ "${HOST_ARCH}" != "x86_64" ]]; then
    echo "linux-x64 must be built natively on an x86_64 host" >&2
    exit 1
  fi
  configure_rusty_v8 "x86_64-unknown-linux-gnu"
  CARGO_PROFILE_RELEASE_LTO="${RELEASE_LTO}" \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${RELEASE_CODEGEN_UNITS}" \
    CARGO_PROFILE_RELEASE_STRIP="${RELEASE_STRIP}" \
    cargo build --release --locked --jobs "${BUILD_JOBS}" \
      -p codex-cli \
      -p codex-code-mode-host \
      --manifest-path "${CARGO_MANIFEST}"

  mkdir -p "${X64_DEST}"
  install -m 755 "${UPSTREAM_DIR}/codex-rs/target/release/codex" "${X64_DEST}/codex"
  install -m 755 "${UPSTREAM_DIR}/codex-rs/target/release/codex-code-mode-host" "${X64_DEST}/codex-code-mode-host"
  strip_binary_if_available "${X64_DEST}/codex" "linux-x64 codex" \
    "${CODEX_X64_STRIP_TOOL:-}" strip llvm-strip
  strip_binary_if_available "${X64_DEST}/codex-code-mode-host" "linux-x64 codex-code-mode-host" \
    "${CODEX_X64_STRIP_TOOL:-}" strip llvm-strip
}

build_arm64() {
  local build_output
  configure_rusty_v8 "aarch64-unknown-linux-gnu"
  if [[ "${HOST_ARCH}" == "aarch64" || "${HOST_ARCH}" == "arm64" ]]; then
    CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
      CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
      cargo build --release --locked --jobs "${BUILD_JOBS}" \
        -p codex-cli \
        -p codex-code-mode-host \
        --manifest-path "${CARGO_MANIFEST}"
    build_output="${UPSTREAM_DIR}/codex-rs/target/release"
  else
    case "${ARM64_BUILD_TOOL}" in
      auto)
        if [[ -f "${ARM64_PKG_CONFIG_PATH}/openssl.pc" ]]; then
          require_arm64_cross_libs
          PKG_CONFIG_ALLOW_CROSS=1 \
            PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
            CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
            CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
            CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
            CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
            cargo build --release --locked --jobs "${BUILD_JOBS}" --target aarch64-unknown-linux-gnu \
              -p codex-cli \
              -p codex-code-mode-host \
              --manifest-path "${CARGO_MANIFEST}"
        elif command -v cross >/dev/null 2>&1; then
          CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
            CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
            CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
            cross build --release --locked --jobs "${BUILD_JOBS}" --target aarch64-unknown-linux-gnu \
              -p codex-cli \
              -p codex-code-mode-host \
              --manifest-path "${CARGO_MANIFEST}"
        else
          require_arm64_cross_libs
          PKG_CONFIG_ALLOW_CROSS=1 \
            PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
            CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
            CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
            CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
            CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
            cargo build --release --locked --jobs "${BUILD_JOBS}" --target aarch64-unknown-linux-gnu \
              -p codex-cli \
              -p codex-code-mode-host \
              --manifest-path "${CARGO_MANIFEST}"
        fi
        ;;
      cross)
        CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
          CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
          CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
          cross build --release --locked --jobs "${BUILD_JOBS}" --target aarch64-unknown-linux-gnu \
            -p codex-cli \
            -p codex-code-mode-host \
            --manifest-path "${CARGO_MANIFEST}"
        ;;
      cargo)
        require_arm64_cross_libs
        PKG_CONFIG_ALLOW_CROSS=1 \
          PKG_CONFIG_PATH="${ARM64_PKG_CONFIG_PATH}" \
          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${ARM_LINKER}" \
          CARGO_PROFILE_RELEASE_LTO="${ARM64_RELEASE_LTO}" \
          CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${ARM64_RELEASE_CODEGEN_UNITS}" \
          CARGO_PROFILE_RELEASE_STRIP="${ARM64_RELEASE_STRIP}" \
          cargo build --release --locked --jobs "${BUILD_JOBS}" --target aarch64-unknown-linux-gnu \
            -p codex-cli \
            -p codex-code-mode-host \
            --manifest-path "${CARGO_MANIFEST}"
        ;;
      *)
        echo "Unsupported CODEX_ARM64_BUILD_TOOL=${ARM64_BUILD_TOOL}" >&2
        exit 1
        ;;
    esac
    build_output="${UPSTREAM_DIR}/codex-rs/target/aarch64-unknown-linux-gnu/release"
  fi

  mkdir -p "${ARM64_DEST}"
  install -m 755 "${build_output}/codex" "${ARM64_DEST}/codex"
  install -m 755 "${build_output}/codex-code-mode-host" "${ARM64_DEST}/codex-code-mode-host"
  strip_binary_if_available "${ARM64_DEST}/codex" "linux-arm64 codex" \
    "${CODEX_ARM64_STRIP_TOOL:-}" aarch64-linux-gnu-strip strip llvm-strip
  strip_binary_if_available "${ARM64_DEST}/codex-code-mode-host" "linux-arm64 codex-code-mode-host" \
    "${CODEX_ARM64_STRIP_TOOL:-}" aarch64-linux-gnu-strip strip llvm-strip
}

case "${BUILD_PLATFORM}" in
  all)
    build_x64
    build_arm64
    ;;
  linux-x64)
    build_x64
    ;;
  linux-arm64)
    build_arm64
    ;;
esac

UPSTREAM_HEAD="$(git -C "${UPSTREAM_DIR}" rev-parse HEAD)"
X64_BINARY=""
X64_HOST_BINARY=""
ARM64_BINARY=""
ARM64_HOST_BINARY=""
if [[ "${BUILD_PLATFORM}" == "all" || "${BUILD_PLATFORM}" == "linux-x64" ]]; then
  X64_BINARY="${X64_DEST}/codex"
  X64_HOST_BINARY="${X64_DEST}/codex-code-mode-host"
fi
if [[ "${BUILD_PLATFORM}" == "all" || "${BUILD_PLATFORM}" == "linux-arm64" ]]; then
  ARM64_BINARY="${ARM64_DEST}/codex"
  ARM64_HOST_BINARY="${ARM64_DEST}/codex-code-mode-host"
fi
MANIFEST_NAME="manifest.json"
if [[ "${BUILD_PLATFORM}" != "all" ]]; then
  MANIFEST_NAME="manifest-${BUILD_PLATFORM}.json"
fi
MANIFEST_PATH="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/${MANIFEST_NAME}"
cat > "${MANIFEST_PATH}" <<EOF
{
  "version": "${CODEX_VERSION}",
  "tag": "${CODEX_TAG}",
  "branch": "${CODEX_BRANCH}",
  "upstream_head": "${UPSTREAM_HEAD}",
  "source_description": "upstream release with CoCalc Linux TCP user timeout override",
  "patches": ["$(basename "${PATCH_FILES[0]}")"],
  "build_platform": "${BUILD_PLATFORM}",
  "host_arch": "${HOST_ARCH}",
  "rust_toolchain": "${RUST_TOOLCHAIN}",
  "x64_binary": "${X64_BINARY}",
  "x64_code_mode_host_binary": "${X64_HOST_BINARY}",
  "arm64_binary": "${ARM64_BINARY}",
  "arm64_code_mode_host_binary": "${ARM64_HOST_BINARY}",
  "strip_binaries": "${STRIP_BINARIES}",
  "release_strip": "${RELEASE_STRIP}",
  "arm64_release_strip": "${ARM64_RELEASE_STRIP}",
  "built_at_utc": "$(date -u +%FT%TZ)"
}
EOF

echo
echo "Built patched codex binaries for ${BUILD_PLATFORM}:"
echo "Manifest:"
echo "  ${MANIFEST_PATH}"

if [[ "${PUBLISH_AFTER_BUILD}" == "1" ]]; then
  if [[ "${BUILD_PLATFORM}" != "all" ]]; then
    echo "Publishing requires CODEX_BUILD_PLATFORM=all or a separately assembled manifest" >&2
    exit 1
  fi
  echo
  echo "Publishing release assets for v${CODEX_VERSION}"
  "${SCRIPT_DIR}/publish-local-codex-binaries.sh"
fi
