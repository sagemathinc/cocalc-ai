#!/usr/bin/env bash
# This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
# License: MS-RSL – see LICENSE.md for details

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: root-start-drop-privs.sh --rootfs <path> --home <path>

Prototype the simpler launch model:

1. start a rootless Podman container as container root
2. ensure sudo/ca-certificates/curl and runtime user exist
3. drop privileges to user 1000
4. verify the runtime works as that user
5. report host-side ownership of root-owned and user-owned probe files

Run this as the rootless Podman host user (for example cocalc-host).
EOF
}

ROOTFS=""
HOME_MOUNT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --rootfs)
      ROOTFS="${2:-}"
      shift 2
      ;;
    --home)
      HOME_MOUNT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[ -n "$ROOTFS" ] || { echo "--rootfs is required" >&2; exit 2; }
[ -n "$HOME_MOUNT" ] || { echo "--home is required" >&2; exit 2; }
[ -d "$ROOTFS" ] || { echo "rootfs not found: $ROOTFS" >&2; exit 2; }

mkdir -p "$HOME_MOUNT"

if [ -x "$ROOTFS/bin/bash" ]; then
  SHELL_PATH="/bin/bash"
elif [ -x "$ROOTFS/bin/sh" ]; then
  SHELL_PATH="/bin/sh"
else
  echo "rootfs must contain /bin/bash or /bin/sh" >&2
  exit 2
fi

ROOT_PROBE="/etc/cocalc-root-start-prototype-root"
USER_PROBE="/home/user/cocalc-root-start-prototype-user"

rm -f "${ROOTFS}${ROOT_PROBE}"
rm -f "${HOME_MOUNT}/cocalc-root-start-prototype-user"

INIT_SCRIPT="$(cat <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

want_user="user"
want_uid="1000"
want_gid="1000"
want_home="/home/user"
shell_path="${COCALC_PROTOTYPE_SHELL:?}"

next_free_name() {
  local base="$1"
  local kind="$2"
  local candidate="$base"
  local suffix=0
  while true; do
    if [ "$kind" = "user" ]; then
      if ! getent passwd "$candidate" >/dev/null 2>&1; then
        printf '%s' "$candidate"
        return 0
      fi
    else
      if ! getent group "$candidate" >/dev/null 2>&1; then
        printf '%s' "$candidate"
        return 0
      fi
    fi
    suffix=$((suffix + 1))
    candidate="${base}${suffix}"
  done
}

has_ca_certificates() {
  [ -d /etc/ssl/certs ] || \
    [ -f /etc/ssl/cert.pem ] || \
    [ -f /etc/pki/tls/certs/ca-bundle.crt ] || \
    [ -f /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem ] || \
    [ -f /etc/ssl/ca-bundle.pem ]
}

install_missing_packages() {
  local need_sudo=0
  local need_curl=0
  local need_certs=0
  command -v sudo >/dev/null 2>&1 || need_sudo=1
  command -v curl >/dev/null 2>&1 || need_curl=1
  has_ca_certificates || need_certs=1
  if [ "$need_sudo" = 0 ] && [ "$need_curl" = 0 ] && [ "$need_certs" = 0 ]; then
    return 0
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends sudo ca-certificates curl
    rm -rf /var/lib/apt/lists/*
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y sudo ca-certificates curl
    dnf clean all
    return 0
  fi
  if command -v yum >/dev/null 2>&1; then
    yum install -y sudo ca-certificates curl
    yum clean all
    return 0
  fi
  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install --no-recommends sudo ca-certificates curl
    zypper clean --all
    return 0
  fi
  echo "no supported package manager found" >&2
  exit 1
}

install_missing_packages

existing_gid_group="$(getent group "$want_gid" | cut -d: -f1 || true)"
if getent group "$want_user" >/dev/null 2>&1; then
  current_gid="$(getent group "$want_user" | cut -d: -f3)"
  if [ "$current_gid" != "$want_gid" ]; then
    if [ -n "$existing_gid_group" ] && [ "$existing_gid_group" != "$want_user" ]; then
      temp_group="$(next_free_name "$existing_gid_group" group)"
      groupmod -n "$temp_group" "$existing_gid_group"
    fi
    groupmod -g "$want_gid" "$want_user"
  fi
elif [ -n "$existing_gid_group" ]; then
  groupmod -n "$want_user" "$existing_gid_group"
else
  groupadd -g "$want_gid" "$want_user"
fi

existing_uid_user="$(getent passwd "$want_uid" | cut -d: -f1 || true)"
if getent passwd "$want_user" >/dev/null 2>&1; then
  current_uid="$(id -u "$want_user")"
  if [ "$current_uid" != "$want_uid" ]; then
    if [ -n "$existing_uid_user" ] && [ "$existing_uid_user" != "$want_user" ]; then
      usermod -l "$want_user" -d "$want_home" -m "$existing_uid_user"
    else
      usermod -u "$want_uid" "$want_user"
    fi
  fi
  usermod -g "$want_gid" -d "$want_home" -m -s "$shell_path" "$want_user"
elif [ -n "$existing_uid_user" ]; then
  usermod -l "$want_user" -d "$want_home" -m -s "$shell_path" "$existing_uid_user"
  usermod -g "$want_gid" "$want_user"
else
  useradd -m -d "$want_home" -s "$shell_path" -u "$want_uid" -g "$want_gid" "$want_user"
fi

mkdir -p /etc/sudoers.d "$want_home"
cat >/etc/sudoers.d/cocalc-user <<EOF_SUDO
$want_user ALL=(ALL) NOPASSWD:ALL
Defaults:$want_user !requiretty
EOF_SUDO
chmod 0440 /etc/sudoers.d/cocalc-user

touch /etc/cocalc-root-start-prototype-root
chmod 0644 /etc/cocalc-root-start-prototype-root
chown root:root /etc/cocalc-root-start-prototype-root
chown "$want_uid:$want_gid" "$want_home"

sudo -u "$want_user" -H env HOME="$want_home" USER="$want_user" LOGNAME="$want_user" \
  "$shell_path" -c '
    set -euo pipefail
    whoami
    id
    pwd
    touch /home/user/cocalc-root-start-prototype-user
    sudo -n true
  '
EOF
)"

VALIDATE_SCRIPT="$(cat <<'EOF'
set -euo pipefail
echo "runtime_user=$(whoami)"
echo "runtime_id=$(id -u):$(id -g)"
echo "runtime_pwd=$(pwd)"
sudo -n true
sudo -n sh -c 'printf "root_probe_inside=%s:%s\n" "$(stat -c "%u" /etc/cocalc-root-start-prototype-root)" "$(stat -c "%g" /etc/cocalc-root-start-prototype-root)"'
printf "user_probe_inside=%s:%s\n" "$(stat -c "%u" /home/user/cocalc-root-start-prototype-user)" "$(stat -c "%g" /home/user/cocalc-root-start-prototype-user)"
EOF
)"

podman run --rm --network host \
  --userns=keep-id:uid=1000,gid=1000 \
  --user 0:0 \
  --workdir / \
  -e BASH_ENV=/dev/null \
  -e ENV=/dev/null \
  -e HOME=/root \
  -e USER=root \
  -e LOGNAME=root \
  -e COCALC_PROTOTYPE_SHELL="$SHELL_PATH" \
  --mount "type=bind,source=${HOME_MOUNT},target=/home/user,rw" \
  --security-opt label=disable \
  --rootfs "$ROOTFS" \
  "$SHELL_PATH" -c "$INIT_SCRIPT" >/dev/null

echo "container validation:"
podman run --rm --network host \
  --userns=keep-id:uid=1000,gid=1000 \
  --user 1000:1000 \
  --workdir /home/user \
  -e BASH_ENV=/dev/null \
  -e ENV=/dev/null \
  -e HOME=/home/user \
  -e USER=user \
  -e LOGNAME=user \
  --mount "type=bind,source=${HOME_MOUNT},target=/home/user,rw" \
  --security-opt label=disable \
  --rootfs "$ROOTFS" \
  "$SHELL_PATH" -c "$VALIDATE_SCRIPT"

echo
echo "host ownership:"
stat -c "root_probe_host=%u:%g %n" "${ROOTFS}${ROOT_PROBE}"
stat -c "user_probe_host=%u:%g %n" "${HOME_MOUNT}/cocalc-root-start-prototype-user"
