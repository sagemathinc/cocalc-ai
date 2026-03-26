# RootFS Benchmark Results: 2026-03-25 (Rustic Quick Check)

Environment:

- Host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- Machine type: `n2-highmem-4`
- RAM: `32 GB`
- Disk: `200 GB` persistent SSD
- Region: `us-west1`
- Rustic backend: Cloudflare R2 bucket `lite2-dev-wnam`

Method:

- This was a quick due-diligence comparison, not a product-path implementation.
- The source trees were the already-cached benchmark lowerdirs from the
  `2026-03-23` multipart RootFS benchmark run.
- For each workload:
  - back up the cached lowerdir tree to R2 using `rustic`
  - restore it into a fresh btrfs subvolume on the same host
- The btrfs-stream reference numbers below are taken from the earlier multipart
  RootFS benchmark artifacts.

## Summary

| Workload | Rustic backup | Rustic restore | Rustic packed bytes | Btrfs `send+hash+upload` | Btrfs `cache_rootfs` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `package-heavy-jupyter` | `32.19s` | `10.60s` | `473 MB` | `33.50s` | `35.96s` |
| `blob-4g-random` | `229.91s` | `18.90s` | `4.38 GB` | `65.84s` | `106.03s` |

## Results

### `package-heavy-jupyter`

- Image: `cocalc.local/rootfs/a6abe0cf83e386aa4e861b11fd0d0e574b67c4ddd68bfcc0b1a2ca88b056577d`
- Source tree size: `1.4G` (`1,357,315,530` bytes)
- Rustic backup: `32.19s`
- Rustic restore: `10.60s`
- Rustic packed bytes added: `473,020,990`
- Files processed: `41,173`
- Direct btrfs-stream reference:
  - `btrfs_send`: `20.516s`
  - `hash_artifact`: `4.671s`
  - `upload_artifact`: `8.311s`
  - `cache_rootfs`: `35.957s`

Interpretation:

- Rustic was roughly on par with the current btrfs `send+hash+upload` path for
  this package-heavy tree.
- Rustic restore was materially faster than the older `cache_rootfs` number for
  this workload.
- The packed repository size was much smaller than the logical tree, which is
  the main attractive result here.

### `blob-4g-random`

- Image: `cocalc.local/rootfs/b6bc27f742358783e20f04d513809a1afe55c36572a8d9c7ef83519e467140d9`
- Source tree size: `4.3G` (`4,542,984,511` bytes)
- Rustic backup: `229.91s`
- Rustic restore: `18.90s`
- Rustic packed bytes added: `4,384,161,417`
- Files processed: `8,660`
- Direct btrfs-stream reference:
  - `btrfs_send`: `21.160s`
  - `hash_artifact`: `14.904s`
  - `upload_artifact`: `29.773s`
  - old `cache_rootfs`: `106.033s`
  - multipart-download `cache_rootfs`: `44.634s`

Interpretation:

- Rustic backup is dramatically worse on the incompressible giant-blob case.
- Rustic restore is still quite fast, and even beats the best current
  multipart-download `cache_rootfs` number for this workload.
- That makes the tradeoff very clear:
  - Rustic ingest is a serious problem for worst-case full publishes.
  - Rustic restore is better than expected.

## Main Takeaways

- For package-heavy managed images, rustic is more competitive than expected.
- For huge incompressible artifacts, rustic backup is much too slow relative to
  the current btrfs-stream path.
- The best argument for rustic remains repository packing/dedup behavior, not
  raw worst-case publish speed.
- The current RootFS architecture still looks like the right default for full
  publish of large artifacts.
- If we ever revisit rustic seriously, it should be because of:
  - storage efficiency
  - operational simplicity
  - incremental behavior
  not because it clearly wins the worst-case publish benchmark.
