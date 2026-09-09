#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CODEX_VERSION="${CODEX_VERSION:-0.153.4}"
RELEASE_REPO="${CODEX_RELEASE_REPO:-sagemathinc/codex}"
RELEASE_TAG="${CODEX_RELEASE_TAG:-v${CODEX_VERSION}}"
LOCAL_BIN_ROOT="${COCALC_CODEX_LOCAL_BIN_DIR:-${REPO_ROOT}/src/.cache/codex-binaries}"
MANIFEST_PATH="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/manifest.json"
X64_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-x64/codex"
ARM64_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-arm64/codex"
X64_HOST_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-x64/codex-code-mode-host"
ARM64_HOST_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-arm64/codex-code-mode-host"
X64_ASSET="codex-v${CODEX_VERSION}-linux-x64.xz"
ARM64_ASSET="codex-v${CODEX_VERSION}-linux-arm64.xz"
X64_HOST_ASSET="codex-code-mode-host-v${CODEX_VERSION}-linux-x64.xz"
ARM64_HOST_ASSET="codex-code-mode-host-v${CODEX_VERSION}-linux-arm64.xz"
MANIFEST_ASSET="codex-v${CODEX_VERSION}-manifest.json"
CHECKSUM_ASSET="codex-v${CODEX_VERSION}-SHA256SUMS"

for path in \
  "${MANIFEST_PATH}" \
  "${X64_SOURCE}" \
  "${ARM64_SOURCE}" \
  "${X64_HOST_SOURCE}" \
  "${ARM64_HOST_SOURCE}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Missing build artifact at ${path}" >&2
    exit 1
  fi
done

if ! command -v readelf >/dev/null 2>&1; then
  echo "Publishing Codex binaries requires readelf from binutils" >&2
  exit 1
fi

verify_portable_linux_binary() {
  local binary="$1"
  if readelf -l "${binary}" | grep -q 'Requesting program interpreter'; then
    echo "Refusing dynamically linked release binary with an ELF interpreter: ${binary}" >&2
    exit 1
  fi
  if readelf -d "${binary}" 2>/dev/null | grep -q '(NEEDED)'; then
    echo "Refusing release binary with shared-library dependencies: ${binary}" >&2
    exit 1
  fi
}

for binary in \
  "${X64_SOURCE}" \
  "${ARM64_SOURCE}" \
  "${X64_HOST_SOURCE}" \
  "${ARM64_HOST_SOURCE}"; do
  verify_portable_linux_binary "${binary}"
done

if ! command -v gh >/dev/null 2>&1; then
  echo "Missing gh CLI" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated" >&2
  exit 1
fi

get_manifest_field() {
  local field="$1"
  node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const field = process.argv[2];
if (!(field in manifest)) {
  process.exit(1);
}
process.stdout.write(String(manifest[field]));
' "${MANIFEST_PATH}" "${field}"
}

if command -v sha256sum >/dev/null 2>&1; then
  sha256_cmd() {
    sha256sum "$@"
  }
elif command -v shasum >/dev/null 2>&1; then
  sha256_cmd() {
    shasum -a 256 "$@"
  }
else
  echo "Need sha256sum or shasum to publish release checksums" >&2
  exit 1
fi

UPSTREAM_HEAD="$(get_manifest_field upstream_head)"
BUILD_TIMESTAMP="$(get_manifest_field built_at_utc)"
SOURCE_DESCRIPTION="$(get_manifest_field source_description)"
LINUX_LIBC="$(get_manifest_field linux_libc)"
if [[ "${LINUX_LIBC}" != "musl" ]]; then
  echo "Refusing to publish non-musl Linux release artifacts (linux_libc=${LINUX_LIBC})" >&2
  exit 1
fi
RELEASE_TARGET="${CODEX_RELEASE_TARGET:-main}"
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGING_DIR}"' EXIT

xz -T0 -9 -c "${X64_SOURCE}" > "${STAGING_DIR}/${X64_ASSET}"
xz -T0 -9 -c "${ARM64_SOURCE}" > "${STAGING_DIR}/${ARM64_ASSET}"
xz -T0 -9 -c "${X64_HOST_SOURCE}" > "${STAGING_DIR}/${X64_HOST_ASSET}"
xz -T0 -9 -c "${ARM64_HOST_SOURCE}" > "${STAGING_DIR}/${ARM64_HOST_ASSET}"
cp "${MANIFEST_PATH}" "${STAGING_DIR}/${MANIFEST_ASSET}"

(
  cd "${STAGING_DIR}"
  sha256_cmd \
    "${X64_ASSET}" \
    "${ARM64_ASSET}" \
    "${X64_HOST_ASSET}" \
    "${ARM64_HOST_ASSET}" \
    "${MANIFEST_ASSET}" > "${CHECKSUM_ASSET}"
)

RELEASE_NOTES="${STAGING_DIR}/release-notes.md"
cat > "${RELEASE_NOTES}" <<EOF
Codex ${CODEX_VERSION} for CoCalc.

Built from upstream commit \`${UPSTREAM_HEAD}\` (${SOURCE_DESCRIPTION}).

Assets:
- \`${X64_ASSET}\`
- \`${ARM64_ASSET}\`
- \`${X64_HOST_ASSET}\`
- \`${ARM64_HOST_ASSET}\`
- \`${MANIFEST_ASSET}\`
- \`${CHECKSUM_ASSET}\`

Built at: \`${BUILD_TIMESTAMP}\`
EOF

ASSETS=(
  "${STAGING_DIR}/${X64_ASSET}"
  "${STAGING_DIR}/${ARM64_ASSET}"
  "${STAGING_DIR}/${X64_HOST_ASSET}"
  "${STAGING_DIR}/${ARM64_HOST_ASSET}"
  "${STAGING_DIR}/${MANIFEST_ASSET}"
  "${STAGING_DIR}/${CHECKSUM_ASSET}"
)

if ! gh release view "${RELEASE_TAG}" --repo "${RELEASE_REPO}" >/dev/null 2>&1; then
  RELEASE_BODY="$(cat "${RELEASE_NOTES}")"
  gh api "repos/${RELEASE_REPO}/releases" --method POST \
    -f tag_name="${RELEASE_TAG}" \
    -f target_commitish="${RELEASE_TARGET}" \
    -f name="v${CODEX_VERSION}" \
    -f body="${RELEASE_BODY}" >/dev/null
fi

gh release upload "${RELEASE_TAG}" "${ASSETS[@]}" --repo "${RELEASE_REPO}" --clobber
gh release edit "${RELEASE_TAG}" --repo "${RELEASE_REPO}" --title "v${CODEX_VERSION}" --notes-file "${RELEASE_NOTES}"

echo "Published ${RELEASE_REPO} release ${RELEASE_TAG}"
