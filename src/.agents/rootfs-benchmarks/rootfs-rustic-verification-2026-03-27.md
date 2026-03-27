# RootFS Rustic Verification: 2026-03-27

This records the first exact-manifest verification pass for the rustic-backed
managed RootFS path, plus an initial publish-parallelism sweep.

## Verification Matrix

Two workloads were verified end to end:

1. publish from the source project,
2. restore into a cached readonly image on the source host,
3. restore into a cached readonly image on the destination host,
4. compare exact manifests and hardlink topology.

### Workloads

| Workload                | Source host     | Destination host | Publish time |  Entries | Regular bytes | Hardlink groups | Result      |
| ----------------------- | --------------- | ---------------- | -----------: | -------: | ------------: | --------------: | ----------- |
| `apt-jupyter-hardlinks` | `rootfs-test-2` | `rootfs-test-1`  |     `16.15s` | `47,164` |     `1.36 GB` |             `3` | exact match |
| `project-1b-hardlinks`  | `rootfs-test-1` | `rootfs-test-2`  |     `21.50s` | `54,221` |     `2.01 GB` |             `1` | exact match |

### Exact manifest matches

`apt-jupyter-hardlinks`

- source project manifest: `318f5d47f9819100cae4599ae227f7e8fa13cdf03603651934f9c29ac12ffcaa`
- source cached restore: `318f5d47f9819100cae4599ae227f7e8fa13cdf03603651934f9c29ac12ffcaa`
- destination cached restore: `318f5d47f9819100cae4599ae227f7e8fa13cdf03603651934f9c29ac12ffcaa`
- hardlink digest: `8a5e357803a87283bc909d63f07edcd84cc96f346220eef63f82855d1ab7f550`

`project-1b-hardlinks`

- source project manifest: `39e9afb0ed3c53e1255097d3397341bc8480bd1d9ba017c9a3f62650fd0dc833`
- source cached restore: `39e9afb0ed3c53e1255097d3397341bc8480bd1d9ba017c9a3f62650fd0dc833`
- destination cached restore: `39e9afb0ed3c53e1255097d3397341bc8480bd1d9ba017c9a3f62650fd0dc833`
- hardlink digest: `4d77daf3b20e5146deed0a02e3bfb3b9d0ae8b81fae94e92768ecc122a146b99`

So for both workloads:

- file-content manifests matched exactly,
- hardlink topology matched exactly,
- same-host and cross-host cached restores matched the source project.

## Publish Parallelism Sweep

Two known-good workloads were published with the global `project-rootfs-publish`
parallel limit pinned first to `1`, then to `2`.

| Parallel limit | Wall time | Jupyter workload | Project-1b workload | Result         |
| -------------- | --------: | ---------------: | ------------------: | -------------- |
| `1`            |  `44.23s` |         `18.57s` |            `44.21s` | both succeeded |
| `2`            |  `21.36s` |         `16.43s` |            `21.33s` | both succeeded |

Initial conclusion:

- `1` is too conservative for this two-host dev setup.
- `2` nearly halves total wall clock for two publishes with no failures.
- The first concrete tuning recommendation is to use `2` as the hosted dev
  default and continue measuring from there.

## Notes

- The verifier compared source project manifests against restored cached images,
  not against arbitrary consumer projects, since consumer projects drift after
  startup and are not a valid source of truth.
- The restore commands used the same host-side rustic restore path as managed
  RootFS cache pulls.
- This is an initial matrix, not the final exit criterion. `conda`, `pnpm`,
  `pip`, mixed scientific stacks, and cross-region replication still need to be
  added.
