#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  promote-github-release-channel.sh [--upload] <release-id> <channel> [output-dir]

Create CoCalc Star channel assets for a GitHub release channel such as
`cocalc-star-candidate` or `cocalc-star-stable`.

The channel release contains generic installers and a small manifest that points
at immutable release artifacts from <release-id>. Public installers should use
the stable channel. Testers can use the candidate channel.

Examples:
  src/scripts/star/promote-github-release-channel.sh 20260608T010203Z-abcdef candidate
  src/scripts/star/promote-github-release-channel.sh --upload 20260608T010203Z-abcdef stable

Environment:
  COCALC_STAR_GITHUB_REPO       GitHub repo. Default: sagemathinc/cocalc-ai
  COCALC_STAR_CHANNEL_TAG       Override channel release tag.
  COCALC_STAR_IMMUTABLE_BASE_URL
                                Override immutable release asset base URL.
  COCALC_STAR_GIT_REVISION      Optional git revision to record in manifests.
EOF
}

upload=0
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--upload" ]]; then
  upload=1
  shift
fi

release_id="${1:-}"
channel="${2:-}"
output_dir="${3:-${REPO_ROOT}/dist/star/channel-${channel}}"

[ -n "$release_id" ] || die "missing release id"
[ -n "$channel" ] || die "missing channel"
case "$release_id" in
  *[!A-Za-z0-9._-]* | "") die "invalid release id: $release_id" ;;
esac
case "$channel" in
  stable | candidate | dev) ;;
  *) die "unsupported channel: $channel; expected stable, candidate, or dev" ;;
esac

repo="${COCALC_STAR_GITHUB_REPO:-sagemathinc/cocalc-ai}"
channel_tag="${COCALC_STAR_CHANNEL_TAG:-cocalc-star-${channel}}"
immutable_base_url="${COCALC_STAR_IMMUTABLE_BASE_URL:-https://github.com/${repo}/releases/download/${release_id}}"
promoted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git_revision="${COCALC_STAR_GIT_REVISION:-}"

mkdir -p "$output_dir"

installer_output="${output_dir}/install-cocalc-star.sh"
lima_installer_output="${output_dir}/install-cocalc-star-local-lima.sh"
env_manifest_output="${output_dir}/cocalc-star-channel.env"
json_manifest_output="${output_dir}/cocalc-star-channel.json"
notes_output="${output_dir}/channel-notes.md"

cp "${SCRIPT_DIR}/install-release.sh" "$installer_output"
chmod 0755 "$installer_output"
cp "${SCRIPT_DIR}/install-local-lima.sh" "$lima_installer_output"
chmod 0755 "$lima_installer_output"

cat >"$env_manifest_output" <<EOF
# CoCalc Star release channel manifest v1
COCALC_STAR_CHANNEL=${channel}
COCALC_STAR_RELEASE_ID=${release_id}
COCALC_STAR_RELEASE_BASE_URL=${immutable_base_url}
COCALC_STAR_RUNTIME_LINUX_X64_URL=${immutable_base_url}/cocalc-star-runtime-linux-x64.tar.gz
COCALC_STAR_RUNTIME_LINUX_ARM64_URL=${immutable_base_url}/cocalc-star-runtime-linux-arm64.tar.gz
COCALC_STAR_PROMOTED_AT=${promoted_at}
COCALC_STAR_GIT_REVISION=${git_revision}
EOF

cat >"$json_manifest_output" <<EOF
{
  "schema": "cocalc-star-channel-v1",
  "product": "cocalc-star",
  "channel": "${channel}",
  "release_id": "${release_id}",
  "release_base_url": "${immutable_base_url}",
  "promoted_at": "${promoted_at}",
  "git_revision": "${git_revision}",
  "assets": {
    "linux_x64": "${immutable_base_url}/cocalc-star-runtime-linux-x64.tar.gz",
    "linux_arm64": "${immutable_base_url}/cocalc-star-runtime-linux-arm64.tar.gz"
  }
}
EOF

cat >"$notes_output" <<EOF
CoCalc Star ${channel} channel.

Current release:

  ${release_id}

Public install:

  curl -fsSL https://github.com/${repo}/releases/download/${channel_tag}/install-cocalc-star.sh | sudo bash

Local Lima install:

  curl -fsSL https://github.com/${repo}/releases/download/${channel_tag}/install-cocalc-star-local-lima.sh \\
    | COCALC_STAR_LIMA_SHARED_DIR="\$HOME/cocalc-star-scratch" bash

The channel manifest points at immutable release artifacts under:

  ${immutable_base_url}
EOF

(
  cd "$output_dir"
  sha256sum \
    install-cocalc-star.sh \
    install-cocalc-star-local-lima.sh \
    cocalc-star-channel.env \
    cocalc-star-channel.json >SHA256SUMS
)

cat <<EOF
Created CoCalc Star ${channel} channel assets:
  ${installer_output}
  ${lima_installer_output}
  ${env_manifest_output}
  ${json_manifest_output}
  ${output_dir}/SHA256SUMS
  ${notes_output}

Channel tag:
  ${channel_tag}

Immutable release:
  ${release_id}

Default install URL for this channel:
  https://github.com/${repo}/releases/download/${channel_tag}/install-cocalc-star.sh
EOF

if [ "$upload" != "1" ]; then
  cat <<EOF

Upload without changing GitHub's latest release pointer:
  ${SCRIPT_DIR}/promote-github-release-channel.sh --upload ${release_id} ${channel}
EOF
  exit 0
fi

command -v gh >/dev/null 2>&1 || die "gh is required for --upload"

assets=(
  "$installer_output"
  "$lima_installer_output"
  "$env_manifest_output"
  "$json_manifest_output"
  "${output_dir}/SHA256SUMS"
)

if gh release view "$channel_tag" --repo "$repo" >/dev/null 2>&1; then
  gh release upload "$channel_tag" "${assets[@]}" --repo "$repo" --clobber
  gh release edit "$channel_tag" \
    --repo "$repo" \
    --title "CoCalc Star ${channel} channel" \
    --notes-file "$notes_output"
else
  create_args=(
    release create "$channel_tag"
    "${assets[@]}"
    --repo "$repo"
    --title "CoCalc Star ${channel} channel"
    --notes-file "$notes_output"
    --latest=false
  )
  if [ "$channel" != "stable" ]; then
    create_args+=(--prerelease)
  fi
  gh "${create_args[@]}"
fi

cat <<EOF

Uploaded CoCalc Star ${channel} channel ${channel_tag} -> ${release_id}.
EOF
