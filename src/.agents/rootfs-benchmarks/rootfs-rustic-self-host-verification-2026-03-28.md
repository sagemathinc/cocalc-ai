# RootFS Rustic Self-Host Verification

Date: March 28, 2026

## Goal

Verify that managed RootFS publish and restore work end to end for self-hosted
project-hosts using the launchpad local `rest-server` path instead of hosted
R2.

## Environment

- Hub workspace: `/home/wstein/build/cocalc-lite2`
- Source self-host VM:
  - Multipass VM: `cocalc-rootfs-selfhost-1774729491-src`
  - SSH target: `ubuntu@10.224.106.47`
  - host_id: `0d369af2-b58b-48f6-bb52-354d53172dc7`
- Destination self-host VM:
  - Multipass VM: `cocalc-rootfs-selfhost-1774729491-dst`
  - SSH target: `ubuntu@10.224.106.120`
  - host_id: `57fa46b5-bf0b-4a9b-b652-7219262e201e`

## Workload

Create a minimal RootFS mutation on the source project that is easy to verify
after restore:

- `/usr/local/bin/rootfs-selfhost-smoke-a`
- `/usr/local/bin/rootfs-selfhost-smoke-b`

These two paths are hardlinked to the same inode and contain:

```bash
#!/bin/bash
echo SELFHOST_ROOTFS_OK

# linked marker
```

The source host confirmed:

```text
/usr/local/bin/rootfs-selfhost-smoke-a 320 2 53
/usr/local/bin/rootfs-selfhost-smoke-b 320 2 53
```

So both files had the same inode, link count `2`, and size `53`.

## First Failure

The first self-hosted publish failed immediately with:

```text
No repository config file found for `rest:http://.../rootfs-images/`
```

Root cause:

- the launchpad `rest-server` repo path was created,
- the generated repo profile on the host was correct,
- but the privileged RootFS backup wrapper
  `cocalc-runtime-storage rootfs-rustic-backup`
  did not lazily initialize the rustic repository on first use.

This bug did not affect hosted R2 because that path was already operating
against initialized shared repos.

## Fix

Patch the RootFS backup wrapper so it does:

1. `rustic repoinfo`
2. if missing, `rustic init --no-progress`
3. if `init` races with another initializer, re-check `repoinfo`

The source fix is in:

- [bootstrap.py](/home/wstein/build/cocalc-lite2/src/packages/server/cloud/bootstrap/bootstrap.py)

## Successful Rerun

Source project:

- project_id: `ba051afc-0418-4480-8065-22968ebf9c10`

Successful publish:

- op_id: `bccfd05c-1c3a-4cc0-8232-864fea1a4966`
- release_id: `f92c9600-2950-4e12-aebf-3cac54e31476`
- image_id: `a381cbfb-43d7-4bd3-9023-95bc29403390`
- image:
  `cocalc.local/rootfs/5a614c13c0ed0086f76fc2cb3c5a636939f84532d42ca79d1c8265d448ddde4b`
- duration: `5585ms`
- upload phase: `upload_rustic=3008ms`

Destination project created from that image:

- project_id: `650ed2c9-aaa4-4105-af5a-9fe94ae1a993`

Verification on the destination host:

```text
SELFHOST_ROOTFS_OK
/usr/local/bin/rootfs-selfhost-smoke-a 3353 2 53
/usr/local/bin/rootfs-selfhost-smoke-b 3353 2 53
```

Interpretation:

- the destination project started successfully from the self-hosted published
  RootFS image,
- the executable payload was restored correctly,
- the hardlink relationship was preserved,
- and the cache miss restore path worked through launchpad local `rest-server`.

## Conclusion

Self-hosted RootFS publish and restore now work end to end through the
launchpad `rest-server` path.

The first live smoke found one real bug, and after fixing it the rerun passed.
