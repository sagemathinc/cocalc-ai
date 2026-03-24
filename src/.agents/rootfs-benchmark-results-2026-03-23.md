# RootFS Benchmark Results: 2026-03-23

Environment:

- Source host: `rootfs-test-1` (`5ff0a685-99ae-4dc0-974f-7d38480e736e`)
- Destination host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- Machine type: `n2-highmem-4`
- RAM: `32 GB`
- Disk: `200 GB` persistent SSD
- Region: `us-west1`
- Artifact backend: `r2`

## Summary

| Workload | Publish | Cold Start | Warm Start | Main Publish Cost | Main Cold-Start Cost |
| --- | ---: | ---: | ---: | --- | --- |
| `base-empty` | `19.7s` | `9.0s` | `0.68s` | upload `13.0s` | `cache_rootfs` `8.4s` |
| `package-heavy-torch` | `22.0s` | `11.5s` | `0.71s` | upload `16.7s` | `cache_rootfs` `10.9s` |
| `metadata-heavy-repos` | `47.2s` | `18.1s` | `0.76s` | upload `32.2s` | `cache_rootfs` `17.5s` |
| `blob-4g-random` | `256.1s` | `131.1s` | `0.72s` | upload `197.9s` | `cache_rootfs` `129.8s` |

## Main Takeaways

- On these hosts, publish is dominated by artifact upload to R2, not by btrfs send or tree materialization.
- Cold create/start is dominated by `cache_rootfs`, which is expected and healthy.
- Warm create/start is excellent across all workloads: about `0.68s` to `0.76s`.
- Realistic package-heavy and metadata-heavy workloads are in a usable range.
- The worst-case `4 GiB` incompressible workload is expensive but now explainable:
  - publish upload to R2: `161.4s`
  - cold cache on host 2: `129.8s`

## Detailed Results

### `base-empty`

- Prefix: `bench-base-1774288752923`
- Published image: `cocalc.local/rootfs/530b59abfe9a35ae5e739ea0636e2c121086b3364031a7c7d5a5c37dfe863cd2`
- Source start: `3.059s`
- Publish total: `19.710s`
- Cold start: `9.010s`
- Warm start: `0.677s`

Publish timings:

- `publish`: `6.646s`
- `upload`: `12.984s`
- `register_release`: `0.013s`
- `catalog_entry`: `0.022s`

Host publish timings:

- `create_snapshot`: `0.661s`
- `clone_snapshot`: `1.407s`
- `materialize_tree`: `2.742s`
- `hash_tree`: `0.921s`

Upload timings:

- `btrfs_send`: `4.367s`
- `hash_artifact`: `0.884s`
- `upload_artifact`: `7.414s`

Cold start timings:

- `cache_rootfs`: `8.395s`
- `runner_start`: `0.538s`

### `package-heavy-torch`

Workload:

- `apt-get install -y -qq python3-torch python3-torchvision`

Sizes:

- `/usr`: `240,563,299`
- `/var/lib/apt/lists`: `60,033,481`

Results:

- Prefix: `bench-package-heavy-1774287898075`
- Publish total: `21.978s`
- Cold start: `11.487s`
- Warm start: `0.706s`

Publish timings:

- `publish`: `5.192s`
- `upload`: `16.718s`

Host publish timings:

- `create_snapshot`: `0.339s`
- `clone_snapshot`: `0.451s`
- `materialize_tree`: `2.950s`
- `hash_tree`: `0.959s`

Upload timings:

- `btrfs_send`: `4.298s`
- `hash_artifact`: `1.121s`
- `upload_artifact`: `11.021s`

Cold start timings:

- `cache_rootfs`: `10.877s`
- `runner_start`: `0.544s`

### `metadata-heavy-repos`

Workload:

- `git clone --depth 1 https://github.com/sagemathinc/cocalc.git`
- `git clone --depth 1 https://github.com/openai/codex.git`
- `git clone --depth 1 https://github.com/sagemath/sage.git`

Sizes:

- `/opt/repos`: `310,951,005`

Results:

- Prefix: `bench-metadata-1774288620924`
- Publish total: `47.228s`
- Cold start: `18.124s`
- Warm start: `0.761s`

Publish timings:

- `publish`: `14.943s`
- `upload`: `32.194s`

Host publish timings:

- `create_snapshot`: `1.176s`
- `clone_snapshot`: `1.483s`
- `materialize_tree`: `8.847s`
- `hash_tree`: `1.993s`

Upload timings:

- `btrfs_send`: `10.674s`
- `hash_artifact`: `1.977s`
- `upload_artifact`: `19.167s`

Cold start timings:

- `cache_rootfs`: `17.479s`
- `runner_start`: `0.569s`

### `blob-4g-random`

Workload:

- `/opt/random4g.bin` written with `dd if=/dev/urandom bs=4M count=1024`

Sizes:

- `/opt/random4g.bin`: `4,294,967,296`
- `/usr`: `240,563,299`

Results:

- Prefix: `bench-blob-4g-1774287995749`
- Publish total: `256.071s`
- Cold start: `131.079s`
- Warm start: `0.719s`

Publish timings:

- `publish`: `58.034s`
- `upload`: `197.925s`

Host publish timings:

- `create_snapshot`: `11.752s`
- `clone_snapshot`: `0.349s`
- `materialize_tree`: `31.096s`
- `hash_tree`: `13.985s`

Upload timings:

- `btrfs_send`: `21.075s`
- `hash_artifact`: `14.815s`
- `upload_artifact`: `161.399s`

Cold start timings:

- `cache_rootfs`: `129.798s`
- `runner_start`: `1.202s`

## Interpretation

- The current design looks viable for realistic workloads.
- The next major optimization target is still obvious:
  - reduce artifact upload/download cost for very large incompressible images
  - then revisit incremental releases so small edits do not republish large full artifacts
- For product behavior, the current warm-cache numbers are especially strong.
