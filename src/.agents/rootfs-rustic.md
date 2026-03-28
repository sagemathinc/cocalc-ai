# RootFS Rustic Status And Next Steps

This document is the current status of the RootFS-to-rustic work, not just the
original migration plan.

Last refreshed: March 27, 2026

## Executive Summary

Managed RootFS is now substantially on the rustic design:

- new managed RootFS publishes store as rustic snapshots,
- managed releases use the rustic `snapshot_id` as their immutable identity,
- project-hosts publish directly from the merged overlay view,
- managed images restore from rustic-backed cache entries and work cross-host,
- initial exact-manifest verification passed on real workloads,
- RootFS publish now has:
  - a high global cap, and
  - a separate per-host cap.

The biggest remaining work is no longer "basic migration". It is:

- broader verification,
- cross-region replication,
- self-hosted `rest-server` support,
- cleanup/removal of the remaining btrfs-delta assumptions and UI leftovers.

## Status

### Implemented

- Rustic is the primary managed RootFS storage backend.
- Managed releases are identified by rustic `snapshot_id`.
- RootFS publish no longer computes `hash_tree` on the critical path.
- Project-host publish goes directly from the merged overlay view to rustic.
- Managed RootFS restore/cache works from rustic-backed releases.
- Cross-host publish/create/start smoke tests succeeded.
- Manifest-based verification tooling exists and is integrated.
- Initial exact-manifest cross-host verification passed.
- RootFS publish exposes a real global concurrency cap.
- RootFS publish also has a separate per-host admission cap.
- A single debug env cap can force all parallel-op limits down during bug
  hunting.

### Partially Implemented

- The data model already supports rustic-backed managed releases, but there is
  still cleanup to do around legacy btrfs-stream-oriented fields and logic.
- The RootFS UI behavior is working, but some storage-era concepts and
  codepaths still need simplification/removal.
- A simplified btrfs fallback still exists and has not yet been pruned down to
  the final intended scope.

### Not Implemented Yet

- Cross-region RootFS snapshot replication.
- Self-hosted RootFS via `rest-server`.
- Full verification matrix for `conda`, `pnpm`, `pip`, mixed scientific images,
  and cross-region restore.
- Final deletion of the old btrfs delta model.
- Benchmarking and possible enablement of clone-plus-restore optimization on
  destination hosts.

## Architectural Decisions That Still Stand

These decisions still look correct:

1. Rustic is the primary managed RootFS backend.
2. Hosted deployment should use one shared rustic repo per region.
3. Self-hosted deployment should use `rest-server`.
4. `full` versus `delta` should not be part of the RootFS product story.
5. The btrfs delta path should be removed rather than preserved.
6. Encryption is not a RootFS product requirement.

One important new data point strengthens this direction:

- project backups have now also converged on shared rustic repos, assigned in
  the database, instead of legacy per-project repos.

That means "shared rustic repos" is no longer only a RootFS design idea. It is
becoming a common CoCalc storage pattern.

## Current Implementation

### Publish Path

Current behavior:

1. capture the visible merged RootFS tree,
2. back it up directly into rustic,
3. use the resulting rustic `snapshot_id` as the managed release identity,
4. register/update the managed release and catalog entry.

Important consequences:

- there is no longer a separate full-tree SHA-256 pass on the critical path,
- publish time is now dominated mainly by rustic itself,
- RootFS identity is no longer tied to a custom tar-based digest pass.

### Restore / Cache Path

Current behavior:

1. resolve the managed release,
2. restore the rustic snapshot into the host cache,
3. finalize it as the readonly cached RootFS image,
4. mount it as a lowerdir for projects.

Cross-host restores are working in the current hosted dev setup.

### Identity Model

Current managed image identity:

- `runtime_image = cocalc.local/rootfs/<rustic_snapshot_id>`
- `content_key = rustic_snapshot_id`

This is intentionally not a pure content hash. It is the rustic snapshot object
id, which is already stable and immutable enough for our release model.

### Btrfs Role Now

Btrfs still matters locally for:

- overlay lowerdirs,
- project runtime filesystem behavior,
- local cache entries,
- snapshots / rollback / host-local reuse.

Btrfs is no longer the main network distribution format for managed RootFS.

## Parallelism

### Current Settings

Current RootFS publish admission model:

- global RootFS publish cap: `100`
- per-host RootFS publish cap: `1`
- debug fuse for all workers: `COCALC_PARALLEL_OPS_DEBUG_CAP`

The intended meaning is:

- the global cap is now a broad fleet-wide safety fuse,
- the per-host cap is the real local protection against overscheduling one
  project-host,
- the debug env exists specifically so development can force serialized
  execution and surface hangs/leaks quickly.

### What Data We Actually Have

We do have one concrete measurement:

- on the two-host hosted dev setup,
- with two RootFS publishes on different hosts,
- global limit `1` took `44.23s` wall clock,
- global limit `2` took `21.36s` wall clock.

That proved:

- `global = 1` was too restrictive,
- unrelated hosts should not be serialized by the hub.

### What We Do Not Yet Have

We do **not** yet have direct same-host RootFS publish scaling data for:

- per-host `1`
- per-host `2`
- per-host `3`
- larger same-host concurrency sweeps on bigger machines

So there is currently no evidence-based reason to say that the per-host limit
should already be `2` or `3`.

The current conservative default of `1` is still reasonable until we run:

1. same-host publish sweep at `1/2/3` on the current small test host,
2. the same sweep on a larger CPU host,
3. measurement of wall clock, per-op latency, CPU, disk, and network pressure.

### Next Parallelism Question

The next concrete tuning task is:

- benchmark same-host RootFS publish concurrency,
- then decide whether the per-host default should move from `1` to `2` or
  higher.

## Verification

RootFS-rustic now has an explicit verification program because rustic upstream
does not provide enough restore-fidelity coverage for our requirements.

### Current Verified Workloads

The first exact-manifest cross-host verification pass succeeded for:

- `apt-jupyter-hardlinks`
- `project-1b-hardlinks`

For both workloads:

- source project manifest matched source cached restore exactly,
- source project manifest matched destination cached restore exactly,
- hardlink topology matched exactly.

Detailed results:

- [rootfs-rustic-verification-2026-03-27.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-verification-2026-03-27.md)
- [rootfs-rustic-verification-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-verification-2026-03-27.json)

### Remaining Verification Matrix

Still required:

- `conda`-heavy image
- `pnpm` / Node.js image
- Python / `pip` image
- mixed scientific stack image
- cross-region restore after replication
- self-hosted restore via `rest-server`

Synthetic fixtures should continue to cover:

- explicit hardlink groups
- symlink-heavy trees
- trees with many small files

Sparse-file verification remains lower priority because it is mainly an
optimization concern for CoCalc, not the main correctness target.

## Restore Optimization Still Worth Considering

The clone-plus-restore optimization is still worth tracking:

- if host B already has `standard-0`,
- and needs `standard-1`,
- it may be beneficial to:
  - start from a btrfs clone/snapshot of `standard-0`,
  - run `rustic restore --delete` into that clone,
  - then finalize the result as cached `standard-1`.

This is not part of the minimum correctness path, but it may be valuable for
large CoCalc image families with modest incremental updates.

## Self-Hosted Direction

This has not been implemented yet, but the target remains:

- do not use the old ad hoc hub-local btrfs-stream HTTP path,
- use the same rustic snapshot model,
- back it with `rest-server`.

That keeps hosted and self-hosted RootFS conceptually aligned.

## Btrfs Cleanup Still Pending

The current plan remains:

- do not preserve the old btrfs delta publish model,
- simplify the remaining btrfs backend aggressively,
- if any btrfs fallback remains, keep it full-stream-only and clearly secondary.

This cleanup has not been finished yet.

## Ordered Next Steps

1. Benchmark same-host RootFS publish concurrency at `1/2/3` and decide
   whether the per-host default should move above `1`.
2. Extend the verification matrix to `conda`, `pnpm`, `pip`, mixed scientific,
   and additional synthetic fixtures.
3. Implement cross-region replication.
4. Implement self-hosted RootFS via `rest-server`.
5. Remove the remaining btrfs delta complexity and UI/storage leftovers.
6. Benchmark the clone-plus-restore optimization and keep it only if it gives
   clear space/time wins.

## Exit Criteria

This RootFS-rustic transition should be considered complete when:

- rustic-backed RootFS publish/create/start/switch are the normal path,
- cross-region restore works,
- self-hosted RootFS uses `rest-server`,
- the verification matrix passes on meaningful real workloads,
- `full` versus `delta` no longer appears in the RootFS product surface,
- the old btrfs delta path is gone.
