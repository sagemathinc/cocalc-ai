#!/usr/bin/env bash

# Shared CoCalc Star managed container-runtime helpers. This file is sourced by
# release installation, bootstrap, and operator scripts, so do not enable shell
# options or install traps here.

STAR_CONTAINER_RUNTIME_ROOT="${STAR_CONTAINER_RUNTIME_ROOT:-/opt/cocalc/container-runtime}"
STAR_CONTAINER_RUNTIME_CURRENT="${STAR_CONTAINER_RUNTIME_CURRENT:-${STAR_CONTAINER_RUNTIME_ROOT}/current}"

star_container_runtime_arch() {
  local arch="${1:-$(uname -m)}"
  case "$arch" in
    x86_64 | amd64 | x64) printf 'amd64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    *)
      printf 'unsupported managed container-runtime architecture: %s\n' "$arch" >&2
      return 2
      ;;
  esac
}

star_container_runtime_archive() {
  local source_root="$1"
  local arch="${2:-$(star_container_runtime_arch)}"
  local -a archives=(
    "${source_root}"/packages/backend/podman/build/container-runtime-linux-*.tar.xz
  )
  if [ ! -f "${archives[0]}" ]; then
    return 1
  fi
  if [ "${#archives[@]}" -ne 1 ]; then
    printf 'runtime payload must contain exactly one managed container-runtime archive\n' >&2
    return 1
  fi
  case "${archives[0]}" in
    *"container-runtime-linux-${arch}.tar.xz") ;;
    *)
      printf 'managed container-runtime archive does not match host architecture %s: %s\n' \
        "$arch" "${archives[0]}" >&2
      return 1
      ;;
  esac
  printf '%s\n' "${archives[0]}"
}

star_inspect_container_runtime_archive() {
  local archive="$1"
  local expected_arch="${2:-$(star_container_runtime_arch)}"
  python3 - "$archive" "$expected_arch" <<'PY'
import hashlib
import json
import re
import sys
import tarfile
from pathlib import PurePosixPath

archive_path, expected_arch = sys.argv[1:]
required = {
    "container-runtime/bin/podman",
    "container-runtime/bin/conmon",
    "container-runtime/bin/crun",
    "container-runtime/bin/netavark",
    "container-runtime/bin/aardvark-dns",
    "container-runtime/etc/containers/containers.conf",
    "container-runtime/share/cocalc/runtime-manifest.json",
}

digest = hashlib.sha256()
with open(archive_path, "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
sha256 = digest.hexdigest()

with tarfile.open(archive_path, mode="r:xz") as archive:
    members = archive.getmembers()
    by_name = {}
    for member in members:
        path = PurePosixPath(member.name)
        if (
            path.is_absolute()
            or ".." in path.parts
            or "\\" in member.name
            or not path.parts
            or path.parts[0] != "container-runtime"
        ):
            raise RuntimeError(f"unsafe container-runtime archive member: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise RuntimeError(
                f"container-runtime archive member must be a directory or regular file: {member.name}"
            )
        if member.name in by_name:
            raise RuntimeError(f"duplicate container-runtime archive member: {member.name}")
        by_name[member.name] = member

    missing = sorted(required.difference(by_name))
    if missing:
        raise RuntimeError(f"container-runtime archive is missing: {', '.join(missing)}")
    for name in required:
        if not by_name[name].isfile():
            raise RuntimeError(f"container-runtime archive member is not a file: {name}")
    for name in required:
        if name.startswith("container-runtime/bin/") and not (by_name[name].mode & 0o111):
            raise RuntimeError(f"container-runtime binary is not executable: {name}")

    manifest_file = archive.extractfile(
        by_name["container-runtime/share/cocalc/runtime-manifest.json"]
    )
    if manifest_file is None:
        raise RuntimeError("unable to read container-runtime manifest")
    manifest = json.load(manifest_file)

if manifest.get("schema") != "cocalc-container-runtime-v1":
    raise RuntimeError("unsupported container-runtime manifest schema")
if manifest.get("os") != "linux":
    raise RuntimeError("managed container-runtime must target Linux")
arch = manifest.get("arch")
if arch != expected_arch:
    raise RuntimeError(
        f"container-runtime architecture is {arch!r}, expected {expected_arch!r}"
    )
version = manifest.get("components", {}).get("podman", {}).get("version")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
    raise RuntimeError(f"invalid Podman version in container-runtime manifest: {version!r}")

runtime_id = f"podman-{version}-{sha256[:16]}"
print("\t".join((runtime_id, version, arch, sha256)))
PY
}

star_validate_installed_container_runtime() {
  local runtime_dir="$1"
  local expected_sha256="${2:-}"
  local binary
  [ -d "$runtime_dir" ] || return 1
  if [ -n "$(find "$runtime_dir" -type d ! -perm -0005 -print -quit)" ]; then
    return 1
  fi
  if [ -n "$(find "$runtime_dir" -type f ! -perm -0004 -print -quit)" ]; then
    return 1
  fi
  for binary in podman conmon crun netavark aardvark-dns; do
    [ -x "${runtime_dir}/bin/${binary}" ] || return 1
    [ -z "$(find "${runtime_dir}/bin/${binary}" ! -perm -0005 -print -quit)" ] || return 1
  done
  [ -f "${runtime_dir}/etc/containers/containers.conf" ] || return 1
  [ -f "${runtime_dir}/share/cocalc/runtime-manifest.json" ] || return 1
  if [ -n "$expected_sha256" ]; then
    [ -f "${runtime_dir}/share/cocalc/bundle-sha256" ] || return 1
    [ "$(tr -d '\r\n' <"${runtime_dir}/share/cocalc/bundle-sha256")" = "$expected_sha256" ] || return 1
  fi
}

star_container_runtime_contract() {
  local runtime_dir="$1"
  python3 - "${runtime_dir}/share/cocalc/runtime-manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
if manifest.get("schema") != "cocalc-container-runtime-v1":
    raise RuntimeError("unsupported container-runtime manifest schema")
contract = manifest.get("host_contract") or {}
expected = {
    "database_backend": "sqlite",
    "network_backend": "netavark",
    "cgroup_manager": "cgroupfs",
}
observed = {key: str(contract.get(key, "")).strip().lower() for key in expected}
if observed != expected:
    raise RuntimeError(
        f"unsupported container-runtime host contract: {observed!r}"
    )
print("\t".join(observed[key] for key in (
    "database_backend", "network_backend", "cgroup_manager"
)))
PY
}

star_run_podman_as_user() {
  local runtime_dir="$1"
  local star_user="$2"
  shift 2
  local podman_bin="" star_uid star_home
  local -a runtime_env=()
  if [ -n "$runtime_dir" ] && [ -x "${runtime_dir}/bin/podman" ]; then
    podman_bin="${runtime_dir}/bin/podman"
    runtime_env=(
      "COCALC_CONTAINER_RUNTIME_CURRENT=${runtime_dir}"
      "COCALC_PODMAN_BIN=${podman_bin}"
      "CONTAINERS_CONF_OVERRIDE=${runtime_dir}/etc/containers/containers.conf"
      "PATH=${runtime_dir}/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
    )
  else
    podman_bin="$(command -v podman 2>/dev/null || true)"
  fi
  [ -n "$podman_bin" ] || return 127
  star_uid="$(id -u "$star_user")" || return
  star_home="$(getent passwd "$star_user" | cut -d: -f6)"
  [ -n "$star_home" ] || return 1
  runuser -u "$star_user" -- env \
    "HOME=${star_home}" \
    "XDG_RUNTIME_DIR=/run/user/${star_uid}" \
    "${runtime_env[@]}" \
    "$podman_bin" "$@"
}

star_podman_info_field() {
  local runtime_dir="$1"
  local star_user="$2"
  local field="$3"
  star_run_podman_as_user "$runtime_dir" "$star_user" \
    info --format "{{.Host.${field}}}" | tr '[:upper:]' '[:lower:]' | tr -d '\r\n'
}

# Validate existing Podman state before changing the active runtime. The caller
# must first stop the project-host service so no new Podman operations can race
# these checks or the subsequent symlink switch.
star_prepare_container_runtime_activation() {
  local runtime_dir="$1"
  local star_user="$2"
  local contract database_backend network_backend cgroup_manager
  local current_runtime="" existing_database_backend existing_network_backend
  local deadline running

  star_validate_installed_container_runtime "$runtime_dir" || return
  contract="$(star_container_runtime_contract "$runtime_dir")" || return
  IFS=$'\t' read -r database_backend network_backend cgroup_manager <<<"$contract"

  if [ -x "${STAR_CONTAINER_RUNTIME_CURRENT}/bin/podman" ]; then
    current_runtime="$(readlink -f "$STAR_CONTAINER_RUNTIME_CURRENT")"
  elif ! command -v podman >/dev/null 2>&1; then
    # A fresh host has no Podman state to migrate. The installer will install
    # runtime dependencies before starting the project-host service.
    return 0
  fi

  existing_database_backend="$(
    star_podman_info_field "$current_runtime" "$star_user" DatabaseBackend
  )" || return
  if [ "$existing_database_backend" != "$database_backend" ]; then
    printf 'container runtime activation requires existing Podman state to use %s; found %s\n' \
      "$database_backend" "${existing_database_backend:-unknown}" >&2
    return 1
  fi

  existing_network_backend="$(
    star_podman_info_field "$current_runtime" "$star_user" NetworkBackend
  )" || return
  if [ "$existing_network_backend" = "$network_backend" ]; then
    return 0
  fi

  printf 'quiescing project containers for container-runtime network migration %s->%s\n' \
    "${existing_network_backend:-unknown}" "$network_backend" >&2
  star_run_podman_as_user "$current_runtime" "$star_user" \
    stop --all --time 5 >/dev/null 2>&1 || true
  deadline=$((SECONDS + 60))
  while true; do
    running="$(
      star_run_podman_as_user "$current_runtime" "$star_user" ps -q
    )" || return
    [ -z "$running" ] && return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'container runtime migration could not quiesce running containers\n' >&2
      return 1
    fi
    sleep 1
  done
}

star_install_container_runtime_archive() {
  local archive="$1"
  local expected_arch="${2:-$(star_container_runtime_arch)}"
  local metadata runtime_id version arch sha256 target tmp
  metadata="$(star_inspect_container_runtime_archive "$archive" "$expected_arch")" || return
  IFS=$'\t' read -r runtime_id version arch sha256 <<<"$metadata"
  case "$runtime_id" in
    podman-[0-9]*-[0-9a-f][0-9a-f]*) ;;
    *)
      printf 'invalid managed container-runtime id: %s\n' "$runtime_id" >&2
      return 1
      ;;
  esac

  install -d -m 0755 -o root -g root "$STAR_CONTAINER_RUNTIME_ROOT"
  target="${STAR_CONTAINER_RUNTIME_ROOT}/${runtime_id}"
  STAR_INSTALLED_CONTAINER_RUNTIME_CREATED=0
  if [ -e "$target" ]; then
    if ! star_validate_installed_container_runtime "$target" "$sha256"; then
      printf 'existing managed container-runtime is invalid: %s\n' "$target" >&2
      return 1
    fi
  else
    tmp="$(mktemp -d "${STAR_CONTAINER_RUNTIME_ROOT}/.install.${runtime_id}.XXXXXX")"
    if ! tar -xJf "$archive" --strip-components=1 -C "$tmp"; then
      rm -rf "$tmp"
      return 1
    fi
    printf '%s\n' "$sha256" >"${tmp}/share/cocalc/bundle-sha256"
    chmod 0644 "${tmp}/share/cocalc/bundle-sha256"
    chown -R root:root "$tmp"
    chmod -R u+rwX,go+rX,go-w "$tmp"
    if ! star_validate_installed_container_runtime "$tmp" "$sha256"; then
      rm -rf "$tmp"
      printf 'extracted managed container-runtime failed validation\n' >&2
      return 1
    fi
    mv "$tmp" "$target"
    STAR_INSTALLED_CONTAINER_RUNTIME_CREATED=1
  fi

  STAR_INSTALLED_CONTAINER_RUNTIME_ID="$runtime_id"
  STAR_INSTALLED_CONTAINER_RUNTIME_VERSION="$version"
  STAR_INSTALLED_CONTAINER_RUNTIME_ARCH="$arch"
  STAR_INSTALLED_CONTAINER_RUNTIME_SHA256="$sha256"
  STAR_INSTALLED_CONTAINER_RUNTIME_PATH="$target"
  export STAR_INSTALLED_CONTAINER_RUNTIME_ID
  export STAR_INSTALLED_CONTAINER_RUNTIME_VERSION
  export STAR_INSTALLED_CONTAINER_RUNTIME_ARCH
  export STAR_INSTALLED_CONTAINER_RUNTIME_SHA256
  export STAR_INSTALLED_CONTAINER_RUNTIME_PATH
  export STAR_INSTALLED_CONTAINER_RUNTIME_CREATED
}

star_atomic_symlink() {
  local target="$1"
  local link="$2"
  local tmp="${link}.tmp.$$"
  mkdir -p "${link%/*}"
  rm -f "$tmp"
  ln -s "$target" "$tmp"
  mv -Tf "$tmp" "$link"
}

star_activate_container_runtime() {
  local runtime_dir="$1"
  star_validate_installed_container_runtime "$runtime_dir" || {
    printf 'refusing to activate invalid managed container-runtime: %s\n' "$runtime_dir" >&2
    return 1
  }
  star_atomic_symlink "$runtime_dir" "$STAR_CONTAINER_RUNTIME_CURRENT"
}

star_configure_container_runtime_env() {
  local runtime_current="${COCALC_CONTAINER_RUNTIME_CURRENT:-$STAR_CONTAINER_RUNTIME_CURRENT}"
  if [ ! -x "${runtime_current}/bin/podman" ]; then
    return 1
  fi
  COCALC_CONTAINER_RUNTIME_CURRENT="$runtime_current"
  COCALC_PODMAN_BIN="${runtime_current}/bin/podman"
  CONTAINERS_CONF_OVERRIDE="${runtime_current}/etc/containers/containers.conf"
  case ":${PATH:-}:" in
    *":${runtime_current}/bin:"*) ;;
    *) PATH="${runtime_current}/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" ;;
  esac
  export COCALC_CONTAINER_RUNTIME_CURRENT COCALC_PODMAN_BIN
  export CONTAINERS_CONF_OVERRIDE PATH
}

star_container_runtime_shell_exports() {
  local runtime_current="${COCALC_CONTAINER_RUNTIME_CURRENT:-$STAR_CONTAINER_RUNTIME_CURRENT}"
  [ -x "${runtime_current}/bin/podman" ] || return 0
  printf 'export COCALC_CONTAINER_RUNTIME_CURRENT=%q; ' "$runtime_current"
  printf 'export COCALC_PODMAN_BIN=%q; ' "${runtime_current}/bin/podman"
  printf 'export CONTAINERS_CONF_OVERRIDE=%q; ' "${runtime_current}/etc/containers/containers.conf"
  # shellcheck disable=SC2016
  printf 'export PATH=%q:$PATH; ' "${runtime_current}/bin"
}

star_release_container_runtime_id() {
  local release_dir="$1"
  python3 - "${release_dir}/release.json" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
try:
    value = json.loads(path.read_text(encoding="utf-8")).get("container_runtime_id")
except Exception:
    raise SystemExit(1)
if not isinstance(value, str) or not re.fullmatch(
    r"podman-[0-9]+(?:\.[0-9]+){1,3}-[0-9a-f]{16}", value
):
    raise SystemExit(1)
print(value)
PY
}

star_activate_release_container_runtime() {
  local release_dir="$1"
  local runtime_id runtime_dir
  runtime_id="$(star_release_container_runtime_id "$release_dir")" || return 2
  runtime_dir="${STAR_CONTAINER_RUNTIME_ROOT}/${runtime_id}"
  star_activate_container_runtime "$runtime_dir"
}
