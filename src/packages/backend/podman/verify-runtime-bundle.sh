#!/usr/bin/env bash
set -euo pipefail

# Check a container runtime bundle built by build-runtime-bundle.sh the way a
# project host checks it before activating it (validateContainerRuntimeVersion
# in project-host/upgrade.ts), so a broken bundle fails in CI rather than on a
# host. Run it on the target architecture, on Ubuntu 24.04 with the distro
# Podman installed (as on project hosts), so the binaries' shared libraries
# resolve as they will there.
#
#   verify-runtime-bundle.sh container-runtime-linux-amd64.tar.xz amd64

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <container-runtime-linux-ARCH.tar.xz> <amd64|arm64>" >&2
  exit 2
fi
TARBALL="$1"
ARCH="$2"

fail() {
  echo "container runtime bundle check failed: $*" >&2
  exit 1
}

# Only directories and regular files: no symbolic or hard links (types l and
# h in GNU tar's listing), devices or other entries.
bad_entries="$(tar -tvJf "$TARBALL" | awk 'substr($1, 1, 1) != "d" && substr($1, 1, 1) != "-"')"
if [[ -n "$bad_entries" ]]; then
  fail "the archive must hold only directories and regular files:
$bad_entries"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xJf "$TARBALL" -C "$TMP"
DIR="$TMP/container-runtime"
MANIFEST="$DIR/share/cocalc/runtime-manifest.json"
[[ -f "$MANIFEST" ]] || fail "missing share/cocalc/runtime-manifest.json"

jq -e --arg arch "$ARCH" \
  '.schema == "cocalc-container-runtime-v1" and .os == "linux" and .arch == $arch' \
  "$MANIFEST" >/dev/null || fail "manifest schema, os or arch is not cocalc-container-runtime-v1/linux/$ARCH"
jq -e '.host_contract.database_backend == "sqlite"
  and .host_contract.network_backend == "netavark"
  and .host_contract.cgroup_manager == "cgroupfs"
  and (.host_contract.required_commands | type == "array")' \
  "$MANIFEST" >/dev/null || fail "manifest host contract is not sqlite/netavark/cgroupfs with required_commands"
# The same rule project-host applies before activating a runtime
# (upgrade.ts): every command is a non-blank string.
jq -e '.host_contract.required_commands
  | all(.[]; type == "string" and test("\\S"))' \
  "$MANIFEST" >/dev/null || fail "manifest required_commands has a blank or non-string entry"

PODMAN_VERSION="$(jq -r '.components.podman.version // empty' "$MANIFEST")"
PASST_VERSION="$(jq -r '.components.passt.version // empty' "$MANIFEST")"
[[ -n "$PODMAN_VERSION" ]] || fail "manifest has no podman version"
[[ -n "$PASST_VERSION" ]] || fail "manifest has no passt version"

for binary in podman conmon crun netavark aardvark-dns pasta; do
  path="$DIR/bin/$binary"
  [[ -f "$path" && -x "$path" ]] || fail "bin/$binary is not an executable file"
  deps="$(ldd "$path" 2>&1 || true)"
  if grep -qw 'not found' <<<"$deps"; then
    fail "bin/$binary has unavailable shared libraries:
$deps"
  fi
done
if [[ "$ARCH" == amd64 ]]; then
  [[ -f "$DIR/bin/pasta.avx2" && -x "$DIR/bin/pasta.avx2" ]] ||
    fail "bin/pasta.avx2 is not an executable file"
fi

podman_reports="$("$DIR/bin/podman" --version 2>&1)"
grep -qF "$PODMAN_VERSION" <<<"$podman_reports" ||
  fail "podman reports '$podman_reports', manifest says $PODMAN_VERSION"
pasta_reports="$("$DIR/bin/pasta" --version 2>&1 | head -1)"
grep -qF "$PASST_VERSION" <<<"$pasta_reports" ||
  fail "pasta reports '$pasta_reports', manifest says $PASST_VERSION"

# Hosts need these commands; a runner missing one is not a bundle defect.
while IFS= read -r command; do
  command -v "$command" >/dev/null ||
    echo "note: required host command '$command' is not on this runner"
done < <(jq -r '.host_contract.required_commands[]' "$MANIFEST")

echo "ok: $(basename "$TARBALL") podman $PODMAN_VERSION, pasta $PASST_VERSION, arch $ARCH"
