#!/bin/bash
# Loopback btrfs (simple quotas) regression for #1246/#1277 backup restores:
# the operation sequence of restoreBackupWithHistory, with the allocating
# staging volume joined to the project's quota group (fixed) or not (old).
#   sudo bash sqtest-restore.sh fixed|old
set -u
MODE=${1:-fixed}
MiB=$((1024 * 1024))
Q=$((200 * MiB))          # the disk quota
R=$((100 * MiB))          # the history's reserve (Q + R for the group)
FILES=20                  # MiB of files in the home
OLD=10                    # MiB of old history
RESTORED=250              # MiB of history in the backup: more than Q
ROOM=$(((2 * RESTORED + 64) * MiB))
IMG=/tmp/sqtest-restore.img
MNT=/tmp/sqtest-restore
G=1/1

cleanup() {
  umount "$MNT" 2>/dev/null
  rm -f "$IMG"
  rmdir "$MNT" 2>/dev/null
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
mb() { echo $(($1 / MiB)); }
group_total() { btrfs qgroup show -prc --raw "$MNT" | awk -v g=$G '$1 == g {print $2}'; }
write() { # file MiB
  dd if=/dev/urandom of="$1" bs=1M count="$2" status=none conv=fsync
}

truncate -s 3G "$IMG"
mkfs.btrfs -q "$IMG"
mkdir -p "$MNT"
mount -o loop "$IMG" "$MNT"
btrfs quota enable --simple "$MNT"
btrfs subvolume create "$MNT/home" >/dev/null
btrfs subvolume create "$MNT/vol" >/dev/null
mkdir -p "$MNT/.persist-import"
btrfs qgroup create $G "$MNT"
btrfs qgroup assign --no-rescan "$MNT/home" $G "$MNT"
btrfs qgroup assign --no-rescan "$MNT/vol" $G "$MNT"
btrfs qgroup limit $Q "$MNT/home" "$MNT"
btrfs qgroup limit $((Q + R)) "$MNT/vol" "$MNT"
btrfs qgroup limit $((Q + R)) $G "$MNT"

write "$MNT/home/files" $FILES
write "$MNT/vol/old.db" $OLD
sync
echo "before: group $(mb $(group_total)) MiB"

# restoreInto: the backup's history, downloaded where only the host can write
btrfs subvolume create "$MNT/.persist-import/restore-src" >/dev/null
btrfs qgroup limit $((Q + R)) "$MNT/.persist-import/restore-src" "$MNT"
write "$MNT/.persist-import/restore-src/a.db" $RESTORED
sync

# withRoom: a temporary override raises the disk quota by ROOM (the group
# follows: (Q + ROOM) + R)
btrfs qgroup limit $((Q + ROOM)) "$MNT/home" "$MNT"
btrfs qgroup limit $((Q + ROOM + R)) $G "$MNT"

if [ "$MODE" = fixed ]; then
  # requireQuotaGroup(source)
  btrfs qgroup assign --no-rescan "$MNT/.persist-import/restore-src" $G "$MNT"
fi
# prepareMergedVolume: snapshot of the live history, joined, then the
# restored databases reflinked in
btrfs subvolume snapshot "$MNT/vol" "$MNT/.persist-import/restore-staged" >/dev/null
if [ "$MODE" = fixed ]; then
  btrfs qgroup assign --no-rescan "$MNT/.persist-import/restore-staged" $G "$MNT"
fi
cp --reflink=always "$MNT/.persist-import/restore-src/a.db" "$MNT/.persist-import/restore-staged/a.db" ||
  fail "reflink into the staged volume"

# restoreFiles: the whole-home restore writes the history's copy into the home
mkdir -p "$MNT/home/.cocalc-persist"
write "$MNT/home/.cocalc-persist/a.db" $RESTORED || fail "the home's copy of the history did not fit (no room?)"
sync
echo "during: group $(mb $(group_total)) MiB (files + old + copy + staged)"

# swapInVolume
mv "$MNT/vol" "$MNT/.persist-import/replaced"
mv "$MNT/.persist-import/restore-staged" "$MNT/vol"
btrfs qgroup assign --no-rescan "$MNT/vol" $G "$MNT" 2>/dev/null
# cleanRestoredHome, then what was staged goes, then the room
rm -rf "$MNT/home/.cocalc-persist"
btrfs subvolume delete "$MNT/.persist-import/restore-src" >/dev/null
btrfs subvolume delete "$MNT/.persist-import/replaced" >/dev/null
sync
btrfs subvolume sync "$MNT" >/dev/null 2>&1
btrfs qgroup limit $Q "$MNT/home" "$MNT"
btrfs qgroup limit $((Q + R)) "$MNT/vol" "$MNT"
btrfs qgroup limit $((Q + R)) $G "$MNT"
sync

TOTAL=$(group_total)
echo "after: group $(mb $TOTAL) MiB; members: $(btrfs qgroup show -prc --raw "$MNT" | awk -v g=$G '$1 == g {print $6}')"
EXPECT=$(((FILES + RESTORED) * MiB))
if [ "$MODE" = fixed ]; then
  # the restored history (charged to the deleted source) still counts
  [ "$TOTAL" -ge $((EXPECT - 8 * MiB)) ] || fail "restored history not counted: $(mb $TOTAL) MiB"
  [ "$TOTAL" -gt "$Q" ] || fail "expected history beyond Q"
  # enforcement: the next allocation is refused at Q + R
  if write "$MNT/vol/more.db" 60 2>/dev/null; then
    fail "wrote past the group's limit"
  fi
  echo "enforced: a write past Q + R was refused"
  echo "PASS (fixed): restored history counted after its staging was deleted; limits back; enforced"
else
  echo "old sequence: group counts $(mb $TOTAL) MiB of $(mb $EXPECT) MiB actually held"
  [ "$TOTAL" -lt $((EXPECT - 100 * MiB)) ] && echo "CONFIRMED (old): restored history uncounted"
fi
