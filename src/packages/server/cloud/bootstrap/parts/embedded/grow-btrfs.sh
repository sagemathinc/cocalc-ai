#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "cocalc-grow-btrfs must run as root" >&2
  exit 1
fi
TARGET_GB="${1:-}"
IMAGE_NEW="/var/lib/cocalc/cocalc.img"
IMAGE_OLD="/var/lib/cocalc/btrfs.img"
IMAGE="$IMAGE_NEW"
if [ ! -f "$IMAGE" ] && [ -f "$IMAGE_OLD" ]; then
  IMAGE="$IMAGE_OLD"
fi
MOUNTPOINT="/mnt/cocalc"
ENV_FILE="/etc/cocalc/project-host.env"
if [ -n "$TARGET_GB" ]; then
  TARGET_GB="${TARGET_GB%%[!0-9]*}"
fi
if [ -n "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
  if grep -q '^COCALC_BTRFS_IMAGE_GB=' "$ENV_FILE"; then
    sed -i.bak "s/^COCALC_BTRFS_IMAGE_GB=.*/COCALC_BTRFS_IMAGE_GB=${TARGET_GB}/" "$ENV_FILE"
  else
    echo "COCALC_BTRFS_IMAGE_GB=${TARGET_GB}" >> "$ENV_FILE"
  fi
fi
if ! mountpoint -q "$MOUNTPOINT"; then
  exit 0
fi
MOUNT_SOURCE="$(findmnt -n -o SOURCE "$MOUNTPOINT" 2>/dev/null || true)"
refresh_block_device() {
  local source="$1"
  local resolved parent_name parent part_num base rescan_path
  resolved="$(readlink -f "$source" 2>/dev/null || printf '%s' "$source")"
  parent_name="$(lsblk -no PKNAME "$resolved" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  part_num="$(lsblk -no PARTN "$resolved" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  if [ -n "$parent_name" ]; then
    parent="/dev/$parent_name"
  else
    parent="$resolved"
  fi
  base="$(basename "$parent")"
  rescan_path="/sys/class/block/$base/device/rescan"
  if [ -w "$rescan_path" ]; then
    echo 1 > "$rescan_path" || true
  fi
  blockdev --rereadpt "$parent" >/dev/null 2>&1 || true
  if command -v partprobe >/dev/null 2>&1; then
    partprobe "$parent" >/dev/null 2>&1 || true
  fi
  if command -v udevadm >/dev/null 2>&1; then
    udevadm settle >/dev/null 2>&1 || true
  fi
  if [ -n "$part_num" ]; then
    if ! command -v growpart >/dev/null 2>&1; then
      echo "growpart is required to grow partition-backed filesystem $resolved" >&2
      return 1
    fi
    growpart "$parent" "$part_num" >/dev/null 2>&1 || true
    blockdev --rereadpt "$parent" >/dev/null 2>&1 || true
    if command -v partprobe >/dev/null 2>&1; then
      partprobe "$parent" >/dev/null 2>&1 || true
    fi
    if command -v udevadm >/dev/null 2>&1; then
      udevadm settle >/dev/null 2>&1 || true
    fi
  fi
}
if [ "$MOUNT_SOURCE" = "$IMAGE" ] || [ "${MOUNT_SOURCE#/dev/loop}" != "$MOUNT_SOURCE" ]; then
  if [ ! -f "$IMAGE" ]; then
    exit 0
  fi
  if [ -z "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
    AUTO_MODE="$(grep -E '^COCALC_BTRFS_IMAGE_AUTO=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
    if [ "$AUTO_MODE" = "1" ]; then
      ROOT_TOTAL_GB="$(df -BG / | awk 'NR==2 {gsub(/G/, "", $2); print $2}' || true)"
      RESERVE_GB="$(grep -E '^COCALC_BTRFS_ROOT_RESERVE_GB=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
      if ! echo "$RESERVE_GB" | grep -Eq '^[0-9]+$'; then
        RESERVE_GB=15
      fi
      if echo "$ROOT_TOTAL_GB" | grep -Eq '^[0-9]+$'; then
        TARGET_GB="$((ROOT_TOTAL_GB - RESERVE_GB))"
        if [ "$TARGET_GB" -lt 5 ]; then
          TARGET_GB=5
        fi
      fi
    fi
  fi
  if [ -z "$TARGET_GB" ] && [ -f "$ENV_FILE" ]; then
    TARGET_GB="$(grep -E '^COCALC_BTRFS_IMAGE_GB=' "$ENV_FILE" | tail -n1 | cut -d= -f2 || true)"
  fi
  if [ -z "$TARGET_GB" ] || ! echo "$TARGET_GB" | grep -Eq '^[0-9]+$'; then
    exit 0
  fi
  CURRENT_BYTES="$(stat -c %s "$IMAGE" 2>/dev/null || echo 0)"
  TARGET_BYTES="$((TARGET_GB * 1024 * 1024 * 1024))"
  if [ "$CURRENT_BYTES" -lt "$TARGET_BYTES" ]; then
    echo "bootstrap: growing btrfs image to ${TARGET_GB}G"
    truncate -s "${TARGET_GB}G" "$IMAGE"
    LOOP_DEV="$(losetup -j "$IMAGE" | head -n1 | cut -d: -f1 || true)"
    if [ -n "$LOOP_DEV" ]; then
      losetup -c "$LOOP_DEV" || true
    fi
  fi
  btrfs filesystem resize max "$MOUNTPOINT" >/dev/null 2>&1 || true
  exit 0
fi
refresh_block_device "$MOUNT_SOURCE" || true
btrfs filesystem resize max "$MOUNTPOINT" >/dev/null 2>&1 || true
