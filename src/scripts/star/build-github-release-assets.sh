#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

release_arches() {
  local arch="${COCALC_STAR_RELEASE_ARCH:-all}"
  case "$arch" in
    all | both) printf 'x64\narm64\n' ;;
    x64 | arm64) printf '%s\n' "$arch" ;;
    *) die "unsupported COCALC_STAR_RELEASE_ARCH=$arch; expected x64, arm64, or all" ;;
  esac
}

short_head() {
  git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf 'unknown'
}

usage() {
  cat <<EOF
Usage:
  $0 [output-dir]

Build the public GitHub release assets for the copy/paste CoCalc Star installer:

  install-cocalc-star.sh
  install-cocalc-star-local-lima.sh
  cocalc-star-runtime-linux-x64.tar.gz
  cocalc-star-runtime-linux-arm64.tar.gz
  SHA256SUMS
  release-notes.md

Environment:
  COCALC_STAR_RELEASE_ARCH   x64, arm64, or all. Default: all.
  STAR_RELEASE_ID            Release id embedded in the artifact.
  STAR_GITHUB_RELEASE_DIR    Default output dir if no positional dir is given.

Example:
  $0 dist/star/github
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

output_dir="${1:-${STAR_GITHUB_RELEASE_DIR:-${REPO_ROOT}/dist/star/github}}"
release_id="${STAR_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(short_head)}"
installer_output="${output_dir}/install-cocalc-star.sh"
lima_installer_output="${output_dir}/install-cocalc-star-local-lima.sh"
release_notes_output="${output_dir}/release-notes.md"

mkdir -p "$output_dir"

mapfile -t arches < <(release_arches)
runtime_assets=()
first_runtime=1
for arch in "${arches[@]}"; do
  runtime_asset="cocalc-star-runtime-linux-${arch}.tar.gz"
  runtime_assets+=("$runtime_asset")
  runtime_output="${output_dir}/${runtime_asset}"
  if [ "$first_runtime" = "1" ]; then
    STAR_RELEASE_MODE=runtime \
      STAR_RELEASE_ID="$release_id" \
      COCALC_STAR_RELEASE_ARCH="$arch" \
      "${SCRIPT_DIR}/build-star-release.sh" "$runtime_output"
    first_runtime=0
  else
    STAR_RUNTIME_BUILD=0 \
      STAR_RELEASE_MODE=runtime \
      STAR_RELEASE_ID="$release_id" \
      COCALC_STAR_RELEASE_ARCH="$arch" \
      "${SCRIPT_DIR}/build-star-release.sh" "$runtime_output"
  fi
done

cp "${SCRIPT_DIR}/install-release.sh" "$installer_output"
chmod 0755 "$installer_output"
cp "${SCRIPT_DIR}/install-local-lima.sh" "$lima_installer_output"
chmod 0755 "$lima_installer_output"

(
  cd "$output_dir"
  sha256sum install-cocalc-star.sh install-cocalc-star-local-lima.sh "${runtime_assets[@]}" >SHA256SUMS
)

runtime_asset_paths="$(
  for asset in "${runtime_assets[@]}"; do
    printf '  %s/%s\n' "$output_dir" "$asset"
  done
)"
runtime_asset_args="$(
  for asset in "${runtime_assets[@]}"; do
    printf ' "%s/%s"' "$output_dir" "$asset"
  done
)"
runtime_asset_notes="$(
  for asset in "${runtime_assets[@]}"; do
    printf -- '- `%s`\n' "$asset"
  done
)"

cat >"$release_notes_output" <<EOF
CoCalc Star runtime release from commit $(short_head).

## Install

Run this on a fresh Ubuntu VM:

\`\`\`sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh | sudo bash
\`\`\`

The installer auto-detects the VM public IPv4 address and uses sslip.io for the
zero-config public HTTPS onboarding URL when possible. It also auto-detects
Linux x86_64 vs Linux arm64 and downloads the matching runtime asset.

For a local laptop VM using Lima:

\`\`\`sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star-local-lima.sh | bash
\`\`\`

The Lima installer creates or starts a local Ubuntu VM, forwards
\`http://localhost:8170\` to the guest, installs CoCalc Star inside the VM, and
prints the local bootstrap URL.

If you know the SSH target for the VM, include it so the fallback local access
instructions can print an exact port-forward command:

\`\`\`sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh \\
  | sudo STAR_SSH_TARGET=ubuntu@<vm-ip-or-hostname> bash
\`\`\`

After install, open the printed public bootstrap URL to create the admin account.

## Assets

- \`install-cocalc-star.sh\`
- \`install-cocalc-star-local-lima.sh\`
$runtime_asset_notes
- \`SHA256SUMS\`
EOF

cat <<EOF
Built CoCalc Star GitHub release assets:
  $installer_output
  $lima_installer_output
$runtime_asset_paths
  ${output_dir}/SHA256SUMS
  $release_notes_output

Release id:
  $release_id

GitHub release upload example:
  gh release create "$release_id" "$installer_output" "$lima_installer_output"$runtime_asset_args "${output_dir}/SHA256SUMS" --repo sagemathinc/cocalc-ai --title "CoCalc Star $release_id" --notes-file "$release_notes_output"

Installer line after upload:
  curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh | sudo bash

Local Lima installer line after upload:
  curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star-local-lima.sh | bash
EOF
