# RootFS Benchmark Results: 2026-03-23 (Multipart R2 Upload)

Environment:

- Source host: `rootfs-test-1` (`5ff0a685-99ae-4dc0-974f-7d38480e736e`)
- Destination host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- Machine type: `n2-highmem-4`
- RAM: `32 GB`
- Disk: `200 GB` persistent SSD
- Region: `us-west1`
- Upload mode: multipart R2 upload
- Defaults: `64 MB` parts, concurrency `8`

## Summary

| Workload | Publish | Cold Start | Warm Start | `upload_artifact` | `cache_rootfs` |
| --- | ---: | ---: | ---: | ---: | ---: |
| `base-empty` | `12.2s` | `8.9s` | `0.76s` | `3.5s` | `8.3s` |
| `package-heavy-jupyter` | `57.3s` | `36.6s` | `0.76s` | `8.3s` | `36.0s` |
| `metadata-heavy-repos` | `32.9s` | `24.4s` | `1.39s` | `6.1s` | `23.7s` |
| `blob-4g-random` | `121.0s` | `106.8s` | `0.71s` | `29.8s` | `106.0s` |

## Main Takeaways

- Multipart upload materially improved the upload bottleneck.
- The biggest improvement is on the worst-case `4 GiB` random artifact:
  - `upload_artifact` dropped from `161.4s` to `29.8s`
  - total publish dropped from `256.1s` to `121.0s`
- For the metadata-heavy repo workload:
  - `upload_artifact` dropped from `19.2s` to `6.1s`
  - total publish dropped from `47.2s` to `32.9s`
- For base images:
  - `upload_artifact` dropped from `7.4s` to `3.5s`
  - total publish dropped from `19.7s` to `12.2s`
- Cold starts are still dominated by `cache_rootfs`, which is expected because download/extract on host 2 is still single-stream.

## Workloads

### `base-empty`

- Prefix: `bench-multipart-base-empty-1774292335985`
- Publish total: `12.176s`
- Cold start: `8.948s`
- Warm start: `0.757s`

Upload timings:

- `btrfs_send`: `3.691s`
- `hash_artifact`: `0.847s`
- `upload_artifact`: `3.541s`

### `package-heavy-jupyter`

Workload:

- `apt-get install -y -qq jupyter-notebook python3-jupyterlab-server python3-jupyterlab-pygments python3-widgetsnbextension`

Sizes:

- `/usr`: `1,124,276,164`

Results:

- Prefix: `bench-multipart-package-heavy-jupyter-1774292788937`
- Setup: `100.606s`
- Publish total: `57.280s`
- Cold start: `36.607s`
- Warm start: `0.760s`

Upload timings:

- `btrfs_send`: `20.516s`
- `hash_artifact`: `4.671s`
- `upload_artifact`: `8.311s`

### `metadata-heavy-repos`

Workload:

- shallow clones of:
  - `sagemathinc/cocalc`
  - `openai/codex`
  - `sagemath/sage`

Sizes:

- `/opt/repos`: `310,982,413`

Results:

- Prefix: `bench-multipart-metadata-heavy-repos-1774292405647`
- Setup: `18.287s`
- Publish total: `32.870s`
- Cold start: `24.368s`
- Warm start: `1.385s`

Upload timings:

- `btrfs_send`: `11.951s`
- `hash_artifact`: `1.984s`
- `upload_artifact`: `6.143s`

### `blob-4g-random`

Workload:

- `/opt/random4g.bin` written with `dd if=/dev/urandom bs=4M count=1024`

Results:

- Prefix: `bench-multipart-blob-4g-random-1774292489957`
- Publish total: `120.989s`
- Cold start: `106.765s`
- Warm start: `0.710s`

Upload timings:

- `btrfs_send`: `21.160s`
- `hash_artifact`: `14.904s`
- `upload_artifact`: `29.773s`

## Interpretation

- The upload bottleneck is now much healthier.
- For large artifacts, publish is no longer dominated almost entirely by the network `PUT`; local tree materialization and hashing are now comparable to network cost.
- The next obvious performance target is the destination-side `cache_rootfs` path.
- The longer-term structural win remains incremental releases, especially for small edits to large base images.
