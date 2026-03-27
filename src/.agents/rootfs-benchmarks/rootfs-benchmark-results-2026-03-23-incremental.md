# RootFS Benchmark Results: 2026-03-23 (Incremental Releases)

Environment:

- Source host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- Destination host: `rootfs-test-1` (`5ff0a685-99ae-4dc0-974f-7d38480e736e`)
- Machine type: `n2-highmem-4`
- RAM: `32 GB`
- Disk: `200 GB` persistent SSD
- Region: `us-west1`
- Upload mode: multipart R2 upload
- Download mode: multipart R2 download
- Delta depth: `1`

## Workload

- Parent image:
  - `cocalc.local/rootfs/6b9872bc71a1b6b8480a5b08f28d1fb24fb82383b12e0379f2a37004c33467de`
- Source project:
  - `cac84af9-1e2d-475c-8c73-cb22b8c12dec`
- Change:
  - Sage source tree checked out as `/sage`
  - source tree size on source host: `638M`

## Investigation Note

The first publish attempt (`9e813246-48b4-49ad-a485-54052919a202`) hung because the
project had originally been created on host 1, then later moved to host 2, and
file-server control-plane RPCs were still using stale cached project routing.

That was fixed by forcing fresh host placement lookup for routed file-server
clients:

- commit `4e5039508f`
- subject: `server/conat: bypass stale route cache for file-server control ops`

## Successful Incremental Publish

- Publish op:
  - `6ef3136f-fd5f-4984-8ebb-fe8630dd7e47`
- Child image:
  - `cocalc.local/rootfs/42ff7aee58781188b3a2921b972fc1521a5f2456efe3806693994d293aaa1f29`
- Image id:
  - `85a10d16-0052-41bd-817e-b2c491b7b721`
- Release id:
  - `7638a3cb-ce01-4690-80d6-a32348003b4e`
- Artifact kind:
  - `delta`
- Parent release:
  - `29e35fde-ef7b-4eda-9dd4-5db7a7dcb170`
- Artifact bytes:
  - `644,618,451`
- Artifact path:
  - `rootfs/releases/42ff7aee58781188b3a2921b972fc1521a5f2456efe3806693994d293aaa1f29/delta-from-6b9872bc71a1b6b8480a5b08f28d1fb24fb82383b12e0379f2a37004c33467de.btrfs`

Publish timings:

- total: `59.325s`
- validate: `0.006s`
- publish: `40.751s`
- upload: `18.512s`
- register_release: `0.014s`
- catalog_entry: `0.014s`
- replicate: `0.003s`

Host-side publish timings:

- create_snapshot: `0.142s`
- clone_snapshot: `0.247s`
- materialize_tree: `7.544s`
- hash_tree: `29.237s`
- register_cache_entry: `3.026s`

Host-side upload timings:

- btrfs_send: `8.131s`
- hash_artifact: `2.322s`
- upload_artifact: `7.844s`

## Cross-Host Cold Consume

- Destination project:
  - `86712958-4c10-4b6e-a8bd-21bf2aa7bfda`
- Destination host:
  - `rootfs-test-1`
- Start op:
  - `10579235-a118-4da3-a421-94d959a77e48`
- Final state:
  - `running`

Start timings:

- total: `15.969s`
- cache_rootfs: `15.037s`
- runner_start: `0.790s`
- apply_pending_copies: `0.112s`
- refresh_authorized_keys: `0.029s`
- prepare_config: `0.001s`

Host-side incremental fetch timings observed in logs:

- download delta artifact from R2: `3.252s`
- receive/materialize delta artifact: `11.380s`

## Content Verification

- Source host project-root view:
  - `/mnt/cocalc/data/cache/project-roots/cac84af9-1e2d-475c-8c73-cb22b8c12dec/sage`
  - `638M`
- Destination host project-root view:
  - `/mnt/cocalc/data/cache/project-roots/86712958-4c10-4b6e-a8bd-21bf2aa7bfda/sage`
  - `638M`

## Takeaways

- The first depth-1 incremental release works end to end after fixing stale
  routed file-server clients.
- A `638M` source-tree addition became a `644.6 MB` delta artifact.
- Cross-host cold consume of that delta completed in about `16s`, with almost
  all of the time in `cache_rootfs`.
- For this workload, incremental releases are already materially better than
  republishing a full large image.
