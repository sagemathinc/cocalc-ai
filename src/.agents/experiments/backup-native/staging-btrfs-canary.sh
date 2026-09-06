#!/bin/bash
# Operator-only qualification. Never point the test at the project's data mount.
set -euo pipefail
if [ "$#" -ne 3 ] || [ "$(id -u)" -ne 0 ]; then
  echo "usage (as root): $0 <qualified-rustic> <sparse_btrfs.py> <result.json>" >&2
  exit 2
fi
binary=$(realpath -e "$1")
test_script=$(realpath -e "$2")
result=$(realpath -m "$3")
test ! -e "$result"
test "$(sha256sum "$binary" | cut -d' ' -f1)" = "54c898c667ac01f8f8002fd95af729068d579aeae9cd279dd73cb6edebf22e5f"
test "$(sha256sum "$test_script" | cut -d' ' -f1)" = "d2eb36aaae964de480b3f2ebf17aa18292853020946f9906edfbaa3767964bed"
# The loopback file can allocate up to 8 GiB. Keep at least 4 GiB outside it.
available=$(df --output=avail -B1 /var/tmp | tail -1 | tr -d ' ')
test "$available" -ge 12884901888
work=$(mktemp -d /var/tmp/cocalc-sparse-canary.XXXXXXXX)
cleanup() {
  if mountpoint -q "$work/mount"; then
    if ! umount "$work/mount"; then
      echo "cleanup incomplete; retained mounted canary at $work" >&2
      return 1
    fi
  fi
  rm -f "$work/disk.img"
  rmdir "$work/mount" "$work"
}
trap cleanup EXIT
mkdir "$work/mount"
truncate -s 8G "$work/disk.img"
mkfs.btrfs -q "$work/disk.img"
mount -o loop "$work/disk.img" "$work/mount"
touch "$work/mount/.cocalc-disposable-sparse-qualification"
python3 "$test_script" "$binary" "$work/mount" "$result"
echo "Qualification complete: $result"
