# CoCalcFS -- the Cocalc project file system

## Btrfs Quota Upgrades

Quota mutations run through `btrfs/quota-queue.ts`, under the per-filesystem
mutation lock. Keep the quota-group selector and the ioctl target separate:

```sh
btrfs qgroup limit 128M /mount/project /mount
```

The first path selects the project's current level-0 quota group; the final
path opens the filesystem mount for the ioctl. Do not shorten this to
`btrfs qgroup limit 128M /mount/project`. On affected kernels, starting the
quota-limit transaction against an already over-quota subvolume fails with
`Disk quota exceeded`, even when the operation would increase its limit.
Changing to an explicit numeric qgroup ID while still opening the project path
does not avoid the failure.

This was reproduced on Ubuntu with kernel `7.0.0-1011-gcp` and btrfs-progs
`6.6.3`, using a disposable 1 GiB image with simple quotas. After writing 64 MiB
and lowering the limit to 32 MiB, the old command failed and the mount-targeted
command successfully raised it to 128 MiB. The regression also covers usage
retained by a read-only snapshot after deleting the live copy.

The relevant upstream implementation is
[btrfs-progs' quota-limit command](https://github.com/kdave/btrfs-progs/blob/v6.6.3/cmds/qgroup.c#L2025),
which accepts a subvolume path in the qgroup-selector position, and
[Linux's quota-limit ioctl](https://github.com/torvalds/linux/blob/v7.0/fs/btrfs/ioctl.c#L3529),
which starts a transaction on the root opened by the final path before applying
the new limit.

The mount must belong to the subvolume's filesystem, as supplied by
`SubvolumeQuota`. No quota-mode change, tracking qgroup, cached ID, snapshot
deletion, or privileged-wrapper update is needed.

### Regression Test

On a disposable Linux VM with Btrfs simple-quota support, loop devices, and
passwordless sudo, run from `src/packages/file-server` after installing and
building its dependencies:

```sh
COCALC_FORCE_BTRFS_TESTS=1 pnpm test --runTestsByPath btrfs/test/quota-upgrade.test.ts
```

The test creates and unmounts its own sparse image. It exercises the actual
quota queue, checks the new limit and successful writes, verifies retained data
by SHA-256, and verifies neighboring quota limits are unchanged. Ordinary unit
tests cover command selection, coalescing, and mutation priority without mounts.

### Deployment

The change is in the file-server used by the **project-host runtime**; deploying
only the hub is insufficient. After upgrading affected hosts, verify that the
pending desired quota has actually been applied and the project can start
before reporting recovery. The fix does not change membership entitlements or
delete project data.
