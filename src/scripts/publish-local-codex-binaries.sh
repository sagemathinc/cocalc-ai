#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UPSTREAM_DIR="${CODEX_UPSTREAM_DIR:-/home/user/upstream/codex}"
CODEX_VERSION="${CODEX_VERSION:-0.124.0}"
RELEASE_REPO="${CODEX_RELEASE_REPO:-sagemathinc/codex}"
RELEASE_TAG="${CODEX_RELEASE_TAG:-v${CODEX_VERSION}}"
LOCAL_BIN_ROOT="${COCALC_CODEX_LOCAL_BIN_DIR:-${REPO_ROOT}/src/.cache/codex-binaries}"
MANIFEST_PATH="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/manifest.json"
X64_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-x64/codex"
ARM64_SOURCE="${LOCAL_BIN_ROOT}/${CODEX_VERSION}/linux-arm64/codex"
X64_ASSET="codex-v${CODEX_VERSION}-linux-x64"
ARM64_ASSET="codex-v${CODEX_VERSION}-linux-arm64"
MANIFEST_ASSET="codex-v${CODEX_VERSION}-manifest.json"
CHECKSUM_ASSET="codex-v${CODEX_VERSION}-SHA256SUMS"

for path in "${MANIFEST_PATH}" "${X64_SOURCE}" "${ARM64_SOURCE}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Missing build artifact at ${path}" >&2
    exit 1
  fi
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

MANIFEST_TAG="$(get_manifest_field tag)"
UPSTREAM_HEAD="$(get_manifest_field upstream_head)"
BUILD_TIMESTAMP="$(get_manifest_field built_at_utc)"
RELEASE_TARGET="${CODEX_RELEASE_TARGET:-${MANIFEST_TAG}}"
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGING_DIR}"' EXIT

cp "${X64_SOURCE}" "${STAGING_DIR}/${X64_ASSET}"
cp "${ARM64_SOURCE}" "${STAGING_DIR}/${ARM64_ASSET}"
cp "${MANIFEST_PATH}" "${STAGING_DIR}/${MANIFEST_ASSET}"
chmod 755 "${STAGING_DIR}/${X64_ASSET}" "${STAGING_DIR}/${ARM64_ASSET}"

(
  cd "${STAGING_DIR}"
  sha256_cmd "${X64_ASSET}" "${ARM64_ASSET}" "${MANIFEST_ASSET}" > "${CHECKSUM_ASSET}"
)

RELEASE_NOTES="${STAGING_DIR}/release-notes.md"
cat > "${RELEASE_NOTES}" <<EOF
Codex ${CODEX_VERSION} for CoCalc.

Built from upstream commit \`${UPSTREAM_HEAD}\` with CoCalc patches:
- TCP user timeout override support
- \`CODEX_FORCE_LOCAL_COMPACT\` local compaction override

Assets:
- \`${X64_ASSET}\`
- \`${ARM64_ASSET}\`
- \`${MANIFEST_ASSET}\`
- \`${CHECKSUM_ASSET}\`

Built at: \`${BUILD_TIMESTAMP}\`
EOF

ASSETS=(
  "${STAGING_DIR}/${X64_ASSET}"
  "${STAGING_DIR}/${ARM64_ASSET}"
  "${STAGING_DIR}/${MANIFEST_ASSET}"
  "${STAGING_DIR}/${CHECKSUM_ASSET}"
)

if ! gh release view "${RELEASE_TAG}" --repo "${RELEASE_REPO}" >/dev/null 2>&1; then
  if [[ ! -d "${UPSTREAM_DIR}/.git" ]]; then
    echo "Missing upstream codex checkout at ${UPSTREAM_DIR}" >&2
    exit 1
  fi
  if [[ "${RELEASE_TARGET}" == "${MANIFEST_TAG}" ]]; then
    if ! git -C "${UPSTREAM_DIR}" rev-parse --verify "${MANIFEST_TAG}^{commit}" >/dev/null 2>&1; then
      echo "Missing source tag ${MANIFEST_TAG} in ${UPSTREAM_DIR}" >&2
      exit 1
    fi
    if ! git -C "${UPSTREAM_DIR}" ls-remote --exit-code origin "refs/tags/${MANIFEST_TAG}" >/dev/null 2>&1; then
      git -C "${UPSTREAM_DIR}" push origin "refs/tags/${MANIFEST_TAG}:refs/tags/${MANIFEST_TAG}"
    fi
  fi
  if ! git -C "${UPSTREAM_DIR}" rev-parse --verify "${RELEASE_TARGET}^{commit}" >/dev/null 2>&1; then
    echo "Missing release target ${RELEASE_TARGET} in ${UPSTREAM_DIR}" >&2
    exit 1
  fi
  git -C "${UPSTREAM_DIR}" tag -f "${RELEASE_TAG}" "${RELEASE_TARGET}" >/dev/null
  git -C "${UPSTREAM_DIR}" push origin "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}" --force
fi

if ! gh release view "${RELEASE_TAG}" --repo "${RELEASE_REPO}" >/dev/null 2>&1; then
  RELEASE_BODY="$(cat "${RELEASE_NOTES}")"
  gh api "repos/${RELEASE_REPO}/releases" --method POST \
    -f tag_name="${RELEASE_TAG}" \
    -f name="v${CODEX_VERSION}" \
    -f body="${RELEASE_BODY}" >/dev/null
fi

gh release upload "${RELEASE_TAG}" "${ASSETS[@]}" --repo "${RELEASE_REPO}" --clobber
gh release edit "${RELEASE_TAG}" --repo "${RELEASE_REPO}" --title "v${CODEX_VERSION}" --notes-file "${RELEASE_NOTES}"

echo "Published ${RELEASE_REPO} release ${RELEASE_TAG}"
