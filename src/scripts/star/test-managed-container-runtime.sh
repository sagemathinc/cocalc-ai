#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

tmp="$(mktemp -d)"
chmod 0755 "$tmp"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

export STAR_CONTAINER_RUNTIME_ROOT="${tmp}/installed"
export STAR_CONTAINER_RUNTIME_CURRENT="${STAR_CONTAINER_RUNTIME_ROOT}/current"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/managed-container-runtime.sh"

stage="${tmp}/stage/container-runtime"
mkdir -p \
  "${stage}/bin" \
  "${stage}/etc/containers" \
  "${stage}/share/cocalc"
for binary in podman conmon crun netavark aardvark-dns; do
  if [ "$binary" = "podman" ]; then
    cat >"${stage}/bin/${binary}" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *DatabaseBackend*) printf 'sqlite\n' ;;
  *NetworkBackend*) printf 'netavark\n' ;;
  *CgroupManager*) printf 'cgroupfs\n' ;;
  "ps -q") ;;
  *) printf 'podman test version\n' ;;
esac
EOF
  else
    cat >"${stage}/bin/${binary}" <<EOF
#!/usr/bin/env bash
printf '${binary} test version\n'
EOF
  fi
  chmod 0755 "${stage}/bin/${binary}"
done
cat >"${stage}/etc/containers/containers.conf" <<'EOF'
[engine]
runtime = "/opt/cocalc/container-runtime/current/bin/crun"
EOF
cat >"${stage}/share/cocalc/runtime-manifest.json" <<'EOF'
{
  "schema": "cocalc-container-runtime-v1",
  "os": "linux",
  "arch": "amd64",
  "components": {"podman": {"version": "5.8.6"}},
  "host_contract": {
    "database_backend": "sqlite",
    "network_backend": "netavark",
    "cgroup_manager": "cgroupfs",
    "required_commands": []
  }
}
EOF

archive="${tmp}/container-runtime-linux-amd64.tar.xz"
tar -C "${tmp}/stage" -cJf "$archive" container-runtime

metadata="$(star_inspect_container_runtime_archive "$archive" amd64)"
IFS=$'\t' read -r runtime_id runtime_version runtime_arch runtime_sha256 <<<"$metadata"
[[ "$runtime_id" == podman-5.8.6-* ]]
[ "$runtime_version" = "5.8.6" ]
[ "$runtime_arch" = "amd64" ]
[[ "$runtime_sha256" =~ ^[0-9a-f]{64}$ ]]
if star_inspect_container_runtime_archive "$archive" arm64 >/dev/null 2>&1; then
  echo "wrong-architecture runtime archive unexpectedly passed validation" >&2
  exit 1
fi

star_install_container_runtime_archive "$archive" amd64
[ "$STAR_INSTALLED_CONTAINER_RUNTIME_CREATED" = "1" ]
[ -d "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH" ]
[ "$(stat -c %u:%g "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH")" = "0:0" ]
runuser -u nobody -- test -r "${STAR_INSTALLED_CONTAINER_RUNTIME_PATH}/etc/containers/containers.conf"
runuser -u nobody -- test -x "${STAR_INSTALLED_CONTAINER_RUNTIME_PATH}/bin/podman"
star_activate_container_runtime "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH"
[ "$(readlink -f "$STAR_CONTAINER_RUNTIME_CURRENT")" = "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH" ]
star_prepare_container_runtime_activation \
  "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH" nobody
star_configure_container_runtime_env
[ "$COCALC_PODMAN_BIN" = "${STAR_CONTAINER_RUNTIME_CURRENT}/bin/podman" ]
[ "$CONTAINERS_CONF_OVERRIDE" = "${STAR_CONTAINER_RUNTIME_CURRENT}/etc/containers/containers.conf" ]
"$COCALC_PODMAN_BIN" --version | grep -q '^podman test version$'

star_install_container_runtime_archive "$archive" amd64
[ "$STAR_INSTALLED_CONTAINER_RUNTIME_CREATED" = "0" ]

release_dir="${tmp}/release"
mkdir -p "$release_dir"
cat >"${release_dir}/release.json" <<EOF
{"container_runtime_id":"${STAR_INSTALLED_CONTAINER_RUNTIME_ID}"}
EOF
rm -f "$STAR_CONTAINER_RUNTIME_CURRENT"
star_activate_release_container_runtime "$release_dir"
[ "$(readlink -f "$STAR_CONTAINER_RUNTIME_CURRENT")" = "$STAR_INSTALLED_CONTAINER_RUNTIME_PATH" ]
mkdir -p "${tmp}/legacy-release"
if star_activate_release_container_runtime "${tmp}/legacy-release"; then
  echo "release without managed runtime metadata unexpectedly activated" >&2
  exit 1
else
  [ "$?" = "2" ]
fi

rm -f "$STAR_CONTAINER_RUNTIME_CURRENT"
unset COCALC_CONTAINER_RUNTIME_CURRENT COCALC_PODMAN_BIN CONTAINERS_CONF_OVERRIDE
if star_configure_container_runtime_env; then
  echo "missing managed runtime unexpectedly configured an environment" >&2
  exit 1
fi
[ -z "$(star_container_runtime_shell_exports)" ]

install_script="${SCRIPT_DIR}/install-from-tarball.sh"
stop_line="$(grep -n 'systemctl stop cocalc-star-project-host.service' "$install_script" | cut -d: -f1)"
prepare_line="$(grep -n 'star_prepare_container_runtime_activation' "$install_script" | cut -d: -f1)"
activate_line="$(grep -n 'star_activate_container_runtime' "$install_script" | cut -d: -f1)"
[ "$stop_line" -lt "$prepare_line" ]
[ "$prepare_line" -lt "$activate_line" ]

rollback_script="${SCRIPT_DIR}/../star-poc/star-poc.sh"
rollback_body="$(sed -n '/^rollback_release()/,/^}/p' "$rollback_script")"
rollback_stop_line="$(grep -n 'systemctl stop cocalc-star-project-host.service' <<<"$rollback_body" | cut -d: -f1)"
rollback_prepare_line="$(grep -n 'star_prepare_container_runtime_activation' <<<"$rollback_body" | cut -d: -f1)"
rollback_activate_line="$(grep -n 'star_activate_container_runtime' <<<"$rollback_body" | cut -d: -f1)"
[ "$rollback_stop_line" -lt "$rollback_prepare_line" ]
[ "$rollback_prepare_line" -lt "$rollback_activate_line" ]
grep -q 'systemctl is-active --quiet cocalc-star-project-host.service' <<<"$rollback_body"
[ "$(grep -c 'systemctl start cocalc-star-project-host.service' <<<"$rollback_body")" -eq 2 ]
grep -q 'if ! star_prepare_container_runtime_activation' <<<"$rollback_body"
grep -q 'if ! star_activate_container_runtime' <<<"$rollback_body"

printf 'managed container-runtime tests: ok\n'
