# RootFS Benchmark Results 2026-03-22

Environment:

- git commit: `31feb972ebffdef575a7d336423a14a9e46d98d3`
- source host: `rootfs-test-1` (`5ff0a685-99ae-4dc0-974f-7d38480e736e`)
- destination host: `rootfs-test-2` (`18521f3d-1d43-4663-aec3-91fc7374d114`)
- both hosts: `n2-highcpu-4`, 4 vCPU, 4 GB RAM, 500 GB SSD, `us-west1`

## Completed

### `base-empty`

- source project: `62fbb4e7-86f4-4dc6-b40d-22e07e7ffd8d`
- publish op: `841d3064-6009-49d3-ba6b-74d399f12291`
- image: `cocalc.local/rootfs/c96e63cb2312aaab62e78a10145933e555141c8b10ff25b116e36e063a68d088`
- release: `415b47aa-28e3-4a01-9c29-789412862ecd`
- artifact backend: `r2`
- replica bucket: `lite2-dev-wnam`
- artifact bytes: `252606889`

Timings:

- source create to `running`: `2.832s`
- publish wall clock: `25.707s`
- publish LRO duration: `20376 ms`
- cold create on destination to `running`: `9.433s`
- warm create on destination to `running`: `2.787s`

## In Progress / Blocked

### `blob-4g-random`

Source workflow:

- source project restored from snapshot `rootfs-benchmark-reset-base`
- source project: `62fbb4e7-86f4-4dc6-b40d-22e07e7ffd8d`
- random file written under `/opt`
- publish op: `e9c98401-7231-4fb4-b80d-c6f40de963de`
- content key: `757c142ac7ee01ad3a8f6577dc69f5a80cbc3230691f715254e8b00b3046dad0`

Observed behavior:

- setup completed successfully using a background `project exec`
- publish advanced into `phase = upload`
- the original `cocalc rootfs publish --wait` path timed out client-side while the LRO kept running
- direct DB polling showed the op still in `upload` after more than 14 minutes
- repeated LRO samples showed `updated_at` advancing every ~30s while remaining in `upload`

This is a meaningful result even before completion:

- direct host -> R2 upload removed the old laptop hub detour
- but worst-case incompressible publishes on these hosts are still very expensive
- the current upload path may be merely slow, or it may still have a transport bottleneck worth debugging

## Benchmark Blockers Found

1. `projects.exec` is still flaky on many projects.

   Short `project exec` calls hang or time out on several projects on both test
   hosts. One source project was stable enough to continue benchmarking, but
   this made the benchmark program effectively serialized through that single
   project.

2. `cocalc rootfs publish --wait` has a practical wait ceiling below the true
   worst-case publish time.

   For heavy uploads, the CLI wait path returned:

   - `rootfs publish timed out (op=e9c98401-7231-4fb4-b80d-c6f40de963de, last_status=running)`

   The LRO itself continued running correctly in the backend.

3. We still do not persist per-phase timings in the LRO.

   This made it necessary to inspect `long_running_operations` directly to
   confirm that the heavy publish was spending its time in `upload`.

## Immediate Takeaways

- `base-empty` looks good.
- warm-cache create is excellent.
- cold create for a small image is acceptable.
- heavy worst-case publish remains the main open performance question.
- the next engineering work with the highest leverage is:
  - fix `projects.exec` reliability on fresh/running projects
  - add persisted phase timings to RootFS publish/create LROs
  - debug or optimize the large direct-to-R2 upload path
