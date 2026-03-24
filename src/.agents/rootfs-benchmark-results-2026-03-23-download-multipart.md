# RootFS Benchmark Results: 2026-03-23 (Multipart R2 Download Follow-up)

Target:

- Source host: `rootfs-test-1` (`5ff0a685-99ae-4dc0-974f-7d38480e736e`)
- Destination host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- Download mode: multipart R2 ranged `GET`
- Defaults: `64 MB` parts, concurrency `8`

## Result

Workload:

- previously published `4 GiB` random-rootfs workload
- source project mutated slightly to force a new content key and a true cold fetch on host 2

Published image:

- `cocalc.local/rootfs/52aefb04a1ee913d2ba53ad0fe9d9a936ffdb2d059a1f95060646b8d2d025f5e`

Timings:

- publish total: `112.154s`
- cold start total: `47.031s`
- cold `cache_rootfs`: `44.634s`
- warm start total: `0.723s`

## Comparison To Prior Single-Stream Download

- previous cold start: `106.765s`
- previous cold `cache_rootfs`: `106.033s`
- new cold start: `47.031s`
- new cold `cache_rootfs`: `44.634s`

## Takeaway

Multipart download substantially improved the destination-side bottleneck for the worst-case large image.

For this `4 GiB` workload:

- cold start improved by about `2.27x`
- `cache_rootfs` improved by about `2.38x`

So the two biggest obvious network bottlenecks are now addressed:

- multipart upload on publish
- multipart download on cold cache

The next structural performance win is still incremental releases, since that reduces artifact size instead of only transferring the same full artifact faster.
