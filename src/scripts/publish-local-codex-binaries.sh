#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CODEX_VERSION="${CODEX_VERSION:-0.123.0}"
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

UPSTREAM_HEAD="$(get_manifest_field upstream_head)"
BUILD_TIMESTAMP="$(get_manifest_field built_at_utc)"
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

if gh release view "${RELEASE_TAG}" --repo "${RELEASE_REPO}" >/dev/null 2>&1; then
  gh release upload "${RELEASE_TAG}" "${ASSETS[@]}" --repo "${RELEASE_REPO}" --clobber
  gh release edit "${RELEASE_TAG}" --repo "${RELEASE_REPO}" --title "v${CODEX_VERSION}" --notes-file "${RELEASE_NOTES}"
else
  gh release create "${RELEASE_TAG}" "${ASSETS[@]}" \
    --repo "${RELEASE_REPO}" \
    --target "${UPSTREAM_HEAD}" \
    --title "v${CODEX_VERSION}" \
    --notes-file "${RELEASE_NOTES}"
fi

echo "Published ${RELEASE_REPO} release ${RELEASE_TAG}"
