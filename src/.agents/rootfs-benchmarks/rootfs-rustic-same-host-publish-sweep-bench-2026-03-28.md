# RootFS Rustic Same-Host Publish Sweep On bench

Measured on March 28, 2026 against host
`0ec9acaf-432a-4c3c-a76e-8cec615f0fe5` (`bench`), a 16-vCPU / 64-GB test
host, using real managed RootFS publishes of the same `apt`/Jupyter-based
image.

Important context:

- RootFS publish now skips btrfs quota bookkeeping entirely.
- The earlier small-host qgroup failures were useful for finding the general
  quota bug, but they are no longer on the RootFS publish critical path.
- All runs below succeeded. No rustic failures and no btrfs quota failures were
  observed.

## 8 queued publishes

Measured with 8 real projects already running on `bench`.

Raw wall-clock results:

- per-host `1`: `181.73s`
- per-host `2`: `46.35s`
- per-host `3`: `34.29s`
- per-host `4`: `20.24s`
- per-host `6`: `18.19s`
- per-host `8`: `18.18s`

Average in-worker publish duration:

- per-host `1`: `5.85s`
- per-host `2`: `5.73s`
- per-host `3`: `6.40s`
- per-host `4`: `7.58s`
- per-host `6`: `9.05s`
- per-host `8`: `11.62s`

Throughput:

- per-host `1`: `0.044 ops/s`
- per-host `2`: `0.173 ops/s`
- per-host `3`: `0.233 ops/s`
- per-host `4`: `0.395 ops/s`
- per-host `6`: `0.440 ops/s`
- per-host `8`: `0.440 ops/s`

Interpretation:

- Throughput improved sharply up to `4`.
- `6` and `8` had similar total throughput, with `8` only increasing per-op
  runtime.

Raw data:

- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-8-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-8-projects.json)

## 16 queued publishes

Measured after adding 8 more real projects on the same host.

Raw wall-clock results:

- per-host `4`: `87.01s`
- per-host `8`: `30.37s`
- per-host `12`: `34.40s`
- per-host `16`: `22.31s`

Average in-worker publish duration:

- per-host `4`: `8.36s`
- per-host `8`: `9.75s`
- per-host `12`: `13.44s`
- per-host `16`: `17.18s`

Throughput:

- per-host `4`: `0.184 ops/s`
- per-host `8`: `0.527 ops/s`
- per-host `12`: `0.465 ops/s`
- per-host `16`: `0.717 ops/s`

Interpretation:

- `16` was clearly best for total wall clock on this host with 16 queued
  publishes.
- `12` was worse than `8`, which indicates a queue-refill effect in the hub
  worker, not a host failure.

Raw data:

- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-16-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-16-projects.json)

## 32 queued publishes

Measured after adding 16 more real projects on the same host.

Raw wall-clock results:

- per-host `16`: `50.88s`
- per-host `24`: `62.72s`
- per-host `32`: `38.61s`

Average in-worker publish duration:

- per-host `16`: `18.85s`
- per-host `24`: `23.40s`
- per-host `32`: `33.76s`

Throughput:

- per-host `16`: `0.629 ops/s`
- per-host `24`: `0.510 ops/s`
- per-host `32`: `0.829 ops/s`

Interpretation:

- `32` gave the best total wall clock and the best throughput in this stress
  run.
- However, it did so by materially increasing per-op runtime relative to `16`.
- `24` again underperformed, which reinforces that the current hub worker
  refill cadence matters a lot whenever queued publishes exceed the per-host
  cap.

Raw data:

- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-32-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-32-projects.json)

## Overall Conclusion

What the `bench` sweeps prove:

- RootFS publish no longer has the earlier qgroup safety ceiling.
- This 16-vCPU / 64-GB host stayed clean all the way up to `32` concurrent
  publishes.
- If the goal is pure throughput under a large backlog, `32` was best in this
  measurement.
- If the goal is a more balanced tradeoff between throughput and individual
  publish runtime, `16` looks like the more conservative starting point on this
  host class.

One caveat is important:

- the current RootFS publish worker refills slots on a `5s` tick, not
  immediately when a publish completes
- because of that, runs where `queued publishes > cap` are partly measuring
  host capacity and partly measuring refill cadence

So the next tuning step is not only "pick a number". It is:

- consider raising the per-host default substantially on large hosts
- and separately consider making RootFS publish refill immediately on slot
  completion so queued workloads benchmark cleanly
