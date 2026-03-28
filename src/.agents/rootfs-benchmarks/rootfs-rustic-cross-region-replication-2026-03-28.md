# RootFS Rustic Cross-Region Replication Smoke

Date: March 28, 2026

## Goal

Verify that a hosted rustic-backed RootFS release can be replicated from the
default North America repo to the Europe repo, then resolved and restored from
Europe for a Europe host.

## Source Release

- image:
  `cocalc.local/rootfs/e6ef9499a6bfd36d1e1fc514f5b7cf7839a2d8a2444794ba89a19da7715cc82a`
- label: `manifest-verify-jupyter-hardlinks`
- release id: `e129cfd1-407f-453a-b150-19942371ca0e`
- source snapshot id:
  `e6ef9499a6bfd36d1e1fc514f5b7cf7839a2d8a2444794ba89a19da7715cc82a`
- source repo: `r2:rootfs-images:wnam`

## Target Host

- host: `rootfs-test-3-europe`
- host id: `c99af0ac-1be2-4692-8109-584b5d4ac216`
- cloud region: `europe-west10`
- target rustic repo: `r2:rootfs-images:weur`

## What Was Verified

1. Hub-side access resolution for the Europe host returned:
   - the existing `wnam` snapshot as the current source,
   - plus `regional_replication_target = weur`.
2. On the Europe host, restore from `wnam` succeeded.
3. The restored tree still had the expected hardlink topology:
   - `hardlink_group_count = 3`
   - `entry_count = 53677`
   - `regular_file_count = 39422`
   - `total_regular_bytes = 1357317324`
4. The Europe host re-backed that tree into `weur`.
5. The new Europe replica snapshot id was:
   `0afd68dda206040fcd12de4c4d264a46357b961d329037b4db3ee70ed3a9635c`
6. After registering the replica in the DB, Europe-host access resolution
   switched to:
   - region `weur`
   - repo selector `r2:rootfs-images:weur`
   - snapshot id
     `0afd68dda206040fcd12de4c4d264a46357b961d329037b4db3ee70ed3a9635c`
7. A second restore from the new `weur` replica also succeeded, with the same:
   - `hardlink_group_count = 3`
   - `entry_count = 53677`
   - `regular_file_count = 39422`
   - `total_regular_bytes = 1357317324`
8. A U.S. host still resolved the same image to the original `wnam` snapshot,
   so replica preference remained region-local rather than globally replacing
   the source.

## Notes

- The direct host smoke was used instead of a fully automatic host-pull smoke
  because the local `lite2.cocalc.ai` route was returning `502` during this
  test window, so project-host websocket control-plane traffic was unhealthy.
- The manual smoke still exercised the actual rustic source repo, target repo,
  replica registration, and release-resolution logic.
- The first raw Europe backup needed `rustic init` for the brand-new `weur`
  repo. The normal `cocalc-runtime-storage rootfs-rustic-backup` wrapper
  already handles that automatically.
