#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

detect_arch() {
  if [ -n "${COCALC_STAR_RELEASE_ARCH:-}" ]; then
    printf '%s\n' "$COCALC_STAR_RELEASE_ARCH"
    return
  fi
  case "$(uname -m)" in
    x86_64 | amd64) printf 'x64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    *) die "unsupported architecture $(uname -m); set COCALC_STAR_RELEASE_ARCH=x64 or arm64" ;;
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
  cocalc-star-runtime-linux-<arch>.tar.gz
  SHA256SUMS
  release-notes.md

Environment:
  COCALC_STAR_RELEASE_ARCH   x64 or arm64. Defaults from uname -m.
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

arch="$(detect_arch)"
case "$arch" in
  x64 | arm64) ;;
  *) die "unsupported COCALC_STAR_RELEASE_ARCH=$arch; expected x64 or arm64" ;;
esac

output_dir="${1:-${STAR_GITHUB_RELEASE_DIR:-${REPO_ROOT}/dist/star/github}}"
release_id="${STAR_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(short_head)}"
runtime_asset="cocalc-star-runtime-linux-${arch}.tar.gz"
runtime_output="${output_dir}/${runtime_asset}"
installer_output="${output_dir}/install-cocalc-star.sh"
release_notes_output="${output_dir}/release-notes.md"

mkdir -p "$output_dir"

STAR_RELEASE_MODE=runtime \
  STAR_RELEASE_ID="$release_id" \
  COCALC_STAR_RELEASE_ARCH="$arch" \
  "${SCRIPT_DIR}/build-star-release.sh" "$runtime_output"

cp "${SCRIPT_DIR}/install-release.sh" "$installer_output"
chmod 0755 "$installer_output"

(
  cd "$output_dir"
  sha256sum install-cocalc-star.sh "$runtime_asset" >SHA256SUMS
)

cat >"$release_notes_output" <<EOF
CoCalc Star runtime release from commit $(short_head).

## Install

Run this on a fresh Ubuntu VM:

\`\`\`sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh \\
  | sudo STAR_ASSUME_YES=1 bash
\`\`\`

If you know the SSH target for the VM, include it so the installer prints an exact
port-forward command at the end:

\`\`\`sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh \\
  | sudo STAR_ASSUME_YES=1 STAR_SSH_TARGET=ubuntu@<vm-ip-or-hostname> bash
\`\`\`

After install, keep the printed SSH tunnel open on your laptop and open the
printed local bootstrap URL to create the admin account.

## Assets

- \`install-cocalc-star.sh\`
- \`${runtime_asset}\`
- \`SHA256SUMS\`
EOF

cat <<EOF
Built CoCalc Star GitHub release assets:
  $installer_output
  $runtime_output
  ${output_dir}/SHA256SUMS
  $release_notes_output

Release id:
  $release_id

GitHub release upload example:
  gh release create "$release_id" "$installer_output" "$runtime_output" "${output_dir}/SHA256SUMS" --repo sagemathinc/cocalc-ai --title "CoCalc Star $release_id" --notes-file "$release_notes_output"

Installer line after upload:
  curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh | sudo STAR_ASSUME_YES=1 bash
EOF
