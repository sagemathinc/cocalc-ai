# RootFS Rustic Status And Next Steps

This document is the current status of the RootFS-to-rustic work, not just the
original migration plan.

Last refreshed: March 28, 2026

## Executive Summary

Managed RootFS is now substantially on the rustic design:

- new managed RootFS publishes store as rustic snapshots,
- managed releases use the rustic `snapshot_id` as their immutable identity,
- project-hosts publish directly from the merged overlay view,
- managed images restore from rustic-backed cache entries and work cross-host,
- cross-region replica registration and region-local release resolution now
  work,
- self-hosted `rest-server` publish/restore has now passed a live two-host
  Multipass smoke,
- btrfs quota mutations are now decoupled through a durable sqlite-backed queue,
- RootFS publish temp snapshots/clones skip quota bookkeeping entirely,
- initial exact-manifest verification passed on real workloads,
- RootFS publish now has:
  - a high global cap, and
  - a separate per-host cap.
- same-host publish scaling data now exists on both a small host and a larger
  16-vCPU host.

The biggest remaining work is no longer "basic migration". It is:

- broader verification,
- admin/catalog polish,
- cleanup/removal of the remaining btrfs-delta assumptions and UI leftovers.

## Status

### Implemented

- Rustic is the primary managed RootFS storage backend.
- Managed releases are identified by rustic `snapshot_id`.
- RootFS publish no longer computes `hash_tree` on the critical path.
- Project-host publish goes directly from the merged overlay view to rustic.
- Managed RootFS restore/cache works from rustic-backed releases.
- Cross-host publish/create/start smoke tests succeeded.
- Cross-region replica registration and region-local release resolution work.
- A live Europe-host replication smoke has passed, including restore from the
  replicated Europe snapshot.
- Self-hosted `rest-server` publish/create/start smoke has now succeeded on two
  local self-hosted Multipass VMs.
- Manifest-based verification tooling exists and is integrated.
- Initial exact-manifest cross-host verification passed.
- RootFS publish exposes a real global concurrency cap.
- RootFS publish also has a separate per-host admission cap.
- A single debug env cap can force all parallel-op limits down during bug
  hunting.
- Btrfs quota work now goes through a durable sqlite-backed serialized queue.
- Snapshot creation no longer blocks on quota completion.
- Runtime posture surfaces quota queue backlog/failures for observability.
- RootFS publish staging snapshots/clones now bypass quota entirely.

### Partially Implemented

- The data model already supports rustic-backed managed releases, but there is
  still cleanup to do around legacy btrfs-stream-oriented fields and logic.
- The RootFS UI behavior is working, but some storage-era concepts and
  codepaths still need simplification/removal.
- A simplified btrfs fallback still exists and has not yet been pruned down to
  the final intended scope.
- Automatic host-triggered cross-region replication still needs a clean live
  smoke once the dev hub route is healthy again. The direct host/data-path
  smoke has passed.

### Not Implemented Yet

- Full verification matrix for `conda`, `pnpm`, `pip`, mixed scientific images,
  and additional cross-region workload coverage.
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

Self-hosted restores are now also working through the launchpad local
`rest-server` path.

The first live self-hosted smoke exposed one real bug:

- the privileged `cocalc-runtime-storage rootfs-rustic-backup` wrapper did not
  lazily initialize a `rest:` rustic repository on first use

After fixing that wrapper to do the same `repoinfo`/`init` bootstrap dance that
other rustic paths already use, the live self-hosted rerun succeeded.

Recorded run:

- [rootfs-rustic-self-host-verification-2026-03-28.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-self-host-verification-2026-03-28.md)

### Cross-Region Replication Path

Current hosted cross-region behavior:

1. resolve the nearest available rustic snapshot for the requesting host,
2. if the host must pull from another region and no local-region replica exists,
   include a local-region `regional_replication_target`,
3. after restore on the destination host, back up the restored tree into the
   target region using the same rustic machinery,
4. register that replica in `rootfs_release_artifacts`,
5. future release resolution prefers the same-region replica.

This is intentionally implemented using the existing restore + backup paths,
not direct repo-to-repo copying.

The first live Europe smoke passed with:

- source region: `wnam`
- target region: `weur`
- source snapshot:
  `e6ef9499a6bfd36d1e1fc514f5b7cf7839a2d8a2444794ba89a19da7715cc82a`
- replica snapshot:
  `0afd68dda206040fcd12de4c4d264a46357b961d329037b4db3ee70ed3a9635c`
- post-registration Europe resolution switched to the `weur` snapshot
- restore from the `weur` replica also passed
- hardlink topology remained intact with `3` hardlink groups on both restores

Recorded run:

- [rootfs-rustic-cross-region-replication-2026-03-28.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-cross-region-replication-2026-03-28.md)

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

### Quota Model Now

Normal project quota bookkeeping is now explicitly asynchronous:

- create qgroup
- assign snapshot qgroup
- set qgroup limit

These mutations are now:

- written to the project-host sqlite database,
- processed by a durable serialized host-local worker,
- executed with `btrfs quota rescan -W` barriers,
- retried when safe,
- and surfaced through runtime posture logging.

That means:

- snapshot creation no longer blocks on quota completion,
- crash recovery replays only the small pending queue,
- and quota remains an eventual-consistency guardrail rather than a correctness
  blocker.

RootFS publish uses an even simpler path:

- the temporary publish snapshot and its writable clone do not participate in
  quota bookkeeping at all
- so the quota queue protects normal project snapshotting while staying out of
  the RootFS publish hot path

## Parallelism

### Current Settings

Current RootFS publish admission model:

- global RootFS publish cap: `250`
- per-host RootFS publish cap:
  `min(max(1, floor(ncpus / 2)), 32)`
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

### Historical Small-Host Result

The first same-host sweep on `rootfs-test-2` exposed the qgroup contention bug
that originally blocked higher RootFS publish concurrency:

- `ERROR: quota rescan failed: Operation now in progress`

That result was important because it revealed a real project-snapshot quota
robustness problem.

However, it is no longer the current RootFS publish limit because:

- normal quota work is now queued asynchronously, and
- RootFS publish staging snapshots/clones now skip quota entirely.

So the earlier small-host publish numbers should now be read as historical bug
discovery data, not as the current rustic publish ceiling.

Historical data:

- [rootfs-rustic-same-host-publish-sweep-2026-03-27.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-2026-03-27.md)
- [rootfs-rustic-same-host-publish-sweep-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-2026-03-27.json)

### Same-Host Sweeps On bench

We now have direct same-host RootFS publish scaling data on `bench`, a
16-vCPU / 64-GB host, with progressively larger same-host publish backlogs.

8 queued publishes:

- per-host `1`: `181.73s` wall
- per-host `2`: `46.35s` wall
- per-host `3`: `34.29s` wall
- per-host `4`: `20.24s` wall
- per-host `6`: `18.19s` wall
- per-host `8`: `18.18s` wall

16 queued publishes:

- per-host `4`: `87.01s` wall
- per-host `8`: `30.37s` wall
- per-host `12`: `34.40s` wall
- per-host `16`: `22.31s` wall

32 queued publishes:

- per-host `16`: `50.88s` wall
- per-host `24`: `62.72s` wall
- per-host `32`: `38.61s` wall

What this proves:

- `bench` stayed clean all the way up to `32` concurrent publishes
- there was no repeat of the old qgroup failure
- for raw throughput under heavy backlog, `32` was best in the current stress
  run
- for a more conservative balance between throughput and per-op runtime, `16`
  looks like the better starting point on this host class

One important caveat:

- the current RootFS publish worker refills capacity on a `5s` tick
- that means runs with backlog larger than the cap are partly measuring host
  capacity and partly measuring worker refill cadence
- this is why some intermediate caps, such as `12` or `24`, look worse than
  lower or higher caps

Detailed results:

- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28.md)
- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-8-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-8-projects.json)
- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-16-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-16-projects.json)
- [rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-32-projects.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-bench-2026-03-28-32-projects.json)

### What We Still Do Not Have

We still do **not** have:

- a final per-host default chosen for each host class
- end-to-end user-visible latency analysis under sustained queue depth
- cross-region throughput measurements
- measurements that separate CPU, disk, and network saturation directly

### Next Parallelism Question

The next concrete tuning tasks are:

- decide whether the first larger-host default should be `16`, `24`, or `32`
  for this host class
- benchmark on an even larger backlog if we want to force a harder limit than
  `32`
- consider making RootFS publish refill capacity immediately on completion,
  instead of only on the worker tick

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
- more cross-region workloads beyond the first Europe smoke
- self-hosted restore via `rest-server` in the ongoing regression mix

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

This is now implemented and has passed a first live smoke. The direction
remains:

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

1. Extend the verification matrix to `conda`, `pnpm`, `pip`, mixed scientific,
   and additional synthetic fixtures.
2. Keep hosted cross-region replication in the live regression mix once the dev
   hub route is healthy again.
3. Remove the remaining btrfs delta complexity and UI/storage leftovers.
4. Benchmark the clone-plus-restore optimization and keep it only if it gives
   clear space/time wins.

## Exit Criteria

This RootFS-rustic transition should be considered complete when:

- rustic-backed RootFS publish/create/start/switch are the normal path,
- cross-region restore works,
- self-hosted RootFS uses `rest-server`,
- the verification matrix passes on meaningful real workloads,
- `full` versus `delta` no longer appears in the RootFS product surface,
- the old btrfs delta path is gone.
