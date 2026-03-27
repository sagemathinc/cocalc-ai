# RootFS Rustic Migration Plan

This document is the concrete plan for switching managed RootFS image storage
from btrfs send streams in R2 to rustic repositories.

It reflects the decisions made on March 26, 2026:

- rustic should become the primary RootFS storage/distribution backend,
- one rustic repo per region is the right hosted model,
- self-hosted deployments should use rest-server for RootFS storage,
- encryption is not a product requirement for RootFS images,
- the current btrfs-stream backend does not need a careful migration path,
- the btrfs delta model should be removed rather than preserved,
- `full` versus `delta` should disappear from the product UI,
- the remaining btrfs backend should stay available only as a simplified
  comparison / fallback backend, ideally full-stream only.

This is a no-code implementation plan, not a status report.

## Executive Summary

The product model does not need to change:

- users still browse catalog entries,
- projects still bind to immutable managed releases,
- publish / switch / rollback / course / admin lifecycle all remain the same.

The internal storage model changes:

- each managed RootFS release becomes a rustic snapshot,
- snapshots live in one repo per region,
- hosts restore snapshots into their local RootFS cache,
- cross-region distribution is done by copying or re-materializing snapshots
  between regional repos,
- self-hosted systems use the same rustic snapshot model, but backed by the
  existing rest-server-based repository setup already used for project backups.

The shortest safe implementation is:

1. add a backend field to managed RootFS releases,
2. implement rustic publish,
3. implement rustic restore/cache,
4. switch new publishes to rustic,
5. keep btrfs-stream support only as a legacy/fallback backend,
6. delete the btrfs delta path.

## Decisions

### Primary decisions

1. Rustic is the primary managed RootFS backend.

2. Hosted deployment uses one rustic repo per region.

3. Self-hosted deployment uses rest-server instead of the current ad hoc
   hub-local HTTP stream path.

4. The product should stop talking about `full` and `delta`.

5. The btrfs delta implementation should be removed, not carried forward.

6. Encryption/key-management is not a RootFS product requirement.
   Rustic may still encrypt internally, but we will treat that as an
   implementation detail with shared site-level credentials, not as a user
   security boundary.

### Consequences

- Storage lineage is no longer modeled as parent/child release chains.
- Dedup/compression move into the regional rustic repo.
- Release GC becomes snapshot forget/prune, not stream-parent reasoning.
- The UI becomes simpler because storage format is no longer exposed as
  `full` versus `delta`.

## Current Code Areas

These are the main code paths that currently assume btrfs-stream artifacts:

- publish orchestration:
  - [rootfs-publish-worker.ts](/home/wstein/build/cocalc-lite2/src/packages/server/projects/rootfs-publish-worker.ts)
- project-host publish / upload:
  - [file-server.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/file-server.ts)
- release registry / artifact records / GC:
  - [releases.ts](/home/wstein/build/cocalc-lite2/src/packages/server/rootfs/releases.ts)
- host restore/cache:
  - [rootfs-cache.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/rootfs-cache.ts)
- shared RootFS types:
  - [rootfs-images.ts](/home/wstein/build/cocalc-lite2/src/packages/util/rootfs-images.ts)
- rustic wrapper already used elsewhere:
  - [rustic.ts](/home/wstein/build/cocalc-lite2/src/packages/backend/sandbox/rustic.ts)
- host software upgrade / bundle layout:
  - [upgrade.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/upgrade.ts)

## Target Architecture

### Product model

Keep all of this:

- `rootfs_images` as catalog/product entries,
- `rootfs_releases` as immutable managed releases,
- `project_rootfs_states` for `current` and `previous`,
- lifecycle actions: hide / block / delete,
- event log,
- version/family/channel metadata,
- current UI/CLI workflows.

### Storage model

For managed releases:

- each release maps to one rustic snapshot,
- that snapshot lives in exactly one regional repo initially,
- other regions can replicate it later,
- host-local cache still stores a restored readonly lowerdir / subvolume.

For self-hosted:

- use the same release/snapshot model,
- use a configured rest-server repo instead of hosted R2 region repos.

### Btrfs role after the switch

Btrfs is still important locally:

- overlay lowerdirs,
- local readonly cache,
- local snapshots,
- rollback retention,
- project filesystem behavior.

Btrfs is no longer the primary network artifact format for managed RootFS
distribution.

## Data Model Changes

### `rootfs_releases`

Add explicit storage-backend fields.

Likely fields:

- `storage_backend`: `rustic` or `btrfs_stream`
- `storage_region`: region name for the primary repo
- `rustic_snapshot_id`
- `rustic_repo_name` or `rustic_repo_selector`
- `storage_bytes` or `packed_bytes`
- keep `content_key` as the immutable release identity

Fields to de-emphasize or eventually remove from active use:

- `parent_release_id`
- `artifact_kind`
- `parent_content_key`

For the rustic backend these should not drive behavior.

### `rootfs_release_artifacts`

This should become "where this release is stored" rather than "which btrfs
stream artifact exists".

For rustic, one row should represent one region-local snapshot materialization
record, e.g.:

- release id
- region
- backend = `rustic`
- repo selector
- snapshot id
- packed bytes
- created / updated

The old stream-specific naming can remain temporarily, but the semantics should
shift.

### UI / shared types

In [rootfs-images.ts](/home/wstein/build/cocalc-lite2/src/packages/util/rootfs-images.ts):

- stop surfacing `full` / `delta` as user-facing state,
- add optional backend/region metadata for admin/debug use only,
- keep version/family/channel as the user-facing upgrade story.

## Hosted Repo Layout

Use one rustic repo per region.

Example conceptual layout:

- `us-west1` repo
- `europe-west10` repo
- etc.

Each repo contains snapshots for many managed RootFS releases.

Snapshot metadata should include:

- release id
- image id
- content key
- version / family / channel when available
- source project id for user-published images

This gives:

- good dedup across related images in the same region,
- straightforward region-local restore,
- simple per-region pruning.

## Self-Hosted Layout

Do not reuse the current hub-local HTTP btrfs-stream copy mechanism.

Instead:

- self-hosted RootFS storage should use rustic repos exposed through
  rest-server,
- this should reuse the same configuration style and operational model we
  already use for project backups,
- a self-hosted site should be able to point RootFS at:
  - a local filesystem repo, or
  - a rest-server-backed repo, or
  - another rustic-supported backend if desired.

This keeps the hosted and self-hosted designs conceptually aligned.

## Publish Path

### Desired behavior

Publishing a RootFS should:

1. capture the current visible `/` tree,
2. back it up into the regional rustic repo,
3. register an immutable managed release,
4. update or create the catalog entry,
5. preserve the current product semantics around visibility and ownership.

### Implementation shape

In [file-server.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/file-server.ts):

- replace btrfs send / sha256 / multipart upload with:
  - materialize visible RootFS tree
  - run rustic backup into the configured regional repo
  - return snapshot id plus backup summary

In [rootfs-publish-worker.ts](/home/wstein/build/cocalc-lite2/src/packages/server/projects/rootfs-publish-worker.ts):

- consume rustic publish results instead of stream upload metadata,
- create the release row with `storage_backend = rustic`,
- stop thinking in terms of `full` versus `delta`.

### Snapshot metadata

Every publish should store enough metadata in the snapshot to recover and audit:

- release id
- content key
- image id
- label
- owner account id
- region

## Restore / Cache Path

### Desired behavior

On a cache miss:

1. resolve the managed release,
2. locate or replicate the rustic snapshot for the current host region,
3. restore into a temp directory/subvolume,
4. convert that into the readonly host cache entry,
5. mount it as a lowerdir for projects.

### Implementation shape

In [rootfs-cache.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/rootfs-cache.ts):

- replace receive/apply-stream logic with restore/materialize logic,
- continue to use local cache directories keyed by release identity,
- keep local btrfs snapshots/subvolumes for fast reuse once restored.

The user-visible behavior should not change.

### Restore optimization: clone previous release before restore

For large image families with small incremental updates, the restore path should
eventually support a btrfs-assisted optimization on the destination host.

Example:

- host B already has `standard-0` materialized locally,
- `standard-1` is a new release in the same family,
- `standard-1` differs by only a small amount,
- instead of restoring `standard-1` into an empty destination, host B starts
  from a btrfs clone/snapshot of `standard-0`,
- then runs `rustic restore --delete` into that clone,
- then finalizes the result as the cached readonly `standard-1`.

Potential benefits:

- much lower temporary local disk usage before BEES dedup catches up,
- less redundant write amplification on the destination host,
- a particularly good fit for CoCalc image families where large software stacks
  change modestly over time, such as monthly Colab-style updates.

This is an optimization, not part of the minimum migration slice.

The recommended order is:

1. ship the correct empty-destination rustic restore path first,
2. verify correctness and performance,
3. then benchmark clone-plus-restore on representative workloads,
4. enable it only if the space and restore-time tradeoffs are clearly better.

This optimization should be tracked explicitly because it is likely valuable on
cocalc.com, where many image families are large and evolve incrementally.

## Parallelism Tuning

Do not treat the current RootFS worker parallelism settings as final product
numbers.

Right now, a value like `1` is a conservative bootstrap default. It is useful
while stabilizing the architecture, but it is not necessarily the right steady
state for cocalc.com or for self-hosted deployments.

We should explicitly benchmark and tune at least:

- RootFS publish parallelism,
- RootFS restore/cache parallelism,
- RootFS GC / prune parallelism.

The tuning criteria should include:

- host disk throughput and IOPS,
- available CPU and RAM,
- object storage or rest-server bandwidth,
- the fact that one wedged operation must not block all later work,
- differences between small self-hosted nodes and large hosted regions.

The final design should support configurable limits per deployment or host
class, rather than baking in one universal global number.

### Initial measurement: hosted dev testbed

The first explicit publish sweep on March 27, 2026 used two known-good
workloads on the two-host dev testbed:

- `apt-jupyter-hardlinks` on `rootfs-test-2`
- `project-1b-hardlinks` on `rootfs-test-1`

Measured result:

- global limit `1`: `44.23s` total wall clock
- global limit `2`: `21.36s` total wall clock

Both runs succeeded without errors. So the first concrete recommendation is:

- do not leave hosted dev at `1`
- use `2` as the initial hosted default while continuing to measure larger
  workload sets

This is still not a universal final number. It is just the first
evidence-based step beyond the bootstrap setting.

## Cross-Region Replication

Start with lazy replication.

Policy:

- publish into the source host's regional repo,
- when another region first needs that release:
  - if a regional replica exists, use it,
  - otherwise create one on demand.

The initial implementation can be pragmatic:

- restore from source repo,
- back up into destination repo,
- register the destination-region artifact row.

If rustic-native repo-to-repo copy becomes compelling later, we can add it.

## GC and Deletion

### What stays the same

- hide / block / delete semantics,
- `project_rootfs_states` retention,
- host-local cache GC,
- event log,
- admin delete-blocker visibility.

### What changes

Central release GC becomes:

1. forget the rustic snapshot in each region where it exists,
2. run repo prune in the background,
3. keep host-local cache eviction separate from central repo prune.

This is much simpler than stream-parent GC.

## UI / CLI Changes

### Remove from UI

- `full`
- `delta`
- parent/child release storage concepts

These are storage details and should not be part of the RootFS product story.

### Keep in UI

- label
- description
- version / family / channel
- publisher / official / collaborator state
- size
- publication date
- scan metadata
- upgrade / rollback workflow

### Publish progress UX

RootFS publish/save should reuse the same kind of rustic progress reporting that
project backups already expose.

Specifically:

- parse rustic progress output into structured progress events,
- surface bytes processed, total bytes when known, transfer speed, and ETA,
- show phase-level progress in the RootFS save/publish modal and operation
  timeline,
- avoid a "blind spinner" save experience when the host is backing up a large
  image.

This is an important product requirement because RootFS image creation is
long-running and users benefit from the same reassurance we already provide for
project backups.

### Admin/debug only

If needed, admin views can show:

- storage backend
- primary region
- snapshot id

but not as normal end-user information.

## Btrfs Backend After The Switch

Keep a simplified btrfs-stream backend only for:

- comparison benchmarking,
- fallback experimentation,
- emergency recovery if we ever need it.

Simplify it aggressively:

- no delta streams,
- no parent-chain logic,
- no storage-lineage UI.

If we keep it at all, it should be a full-stream-only backend.

## Implementation Phases

### Phase 0: prerequisites

- confirm patched rustic is in host tools bundles
- define regional repo configuration
- define self-hosted rest-server configuration path
- write this design into code comments and tickets

### Phase 1: schema and type changes

- add backend/region/snapshot fields
- de-emphasize artifact_kind / parent-based logic
- keep schema simple; no compatibility gymnastics needed

### Phase 2: rustic publish

- implement rustic-based RootFS publish on project-host
- register release rows from snapshot metadata
- leave existing restore path untouched until publish works

### Phase 3: rustic restore/cache

- implement rustic restore into host cache
- start projects from rustic-backed managed releases
- rerun publish/create/start smoke tests

### Phase 4: regional replication and GC

- replicate on first cross-region demand
- implement forget/prune-based GC
- keep host cache eviction as a separate loop

### Phase 5: self-hosted rest-server support

- wire self-hosted repo settings
- replace the old self-hosted btrfs HTTP artifact path
- smoke test hosted and self-hosted flows separately

### Phase 6: remove btrfs delta complexity

- delete btrfs delta publish/receive code
- delete parent-chain storage assumptions
- keep only simplified full-stream fallback if still wanted

## Smoke Tests Required

After rustic publish exists:

1. publish a new managed image
2. create a project from it on another host
3. restart the project
4. rollback to previous image
5. course-assigned project creation
6. delete/hide/block lifecycle

Rustic-specific validation:

1. restore hardlink-heavy tree correctly
2. repeated small update publishes dedup correctly
3. cross-region first-use replication works
4. self-hosted rest-server publish/restore works

## Verification

Because rustic itself does not have strong enough restore-fidelity coverage for
our use case, RootFS-rustic needs its own explicit verification program before
we treat the migration as complete.

### Verification goals

For a representative set of real workloads, prove that we can:

1. save a RootFS on one host,
2. restore it on another host and in another region,
3. get back exactly the same file contents,
4. preserve hardlink topology correctly,
5. repeat this reliably enough that the result is boring.

### Workload matrix

At minimum verify all of these:

- package-heavy apt/Jupyter image
- conda-heavy image
- pnpm / Node.js image with known hardlink-heavy stores
- Python/pip image
- a mixed scientific stack image with large binary packages

Add a few synthetic fixtures too:

- explicit hardlink groups
- symlink-heavy trees
- a moderately large tree with many small files

Sparse-file coverage can remain lower priority because it is mainly an
optimization concern for CoCalc, not the main semantic correctness target.

### What to compare

For each workload, compute a filesystem manifest before publish and after
restore that includes at least:

- relative path
- file type
- mode
- uid / gid
- size
- symlink target when relevant
- sha256 for every regular file
- hardlink identity group for files with link count greater than one

The key requirement is not just "it runs", but "the manifest matches".

### Hardlink verification

Hardlinks need explicit verification, not just file-content checks.

For every hardlink group, verify:

- the same paths belong to the same group after restore
- link counts are correct
- restored files that should share identity actually share identity

This should be enforced both:

- in the standalone rustic-fidelity tests, and
- in the RootFS publish/restore verification matrix.

### Cross-host and cross-region verification

Every representative workload should be tested in at least these scenarios:

- publish on host A, restore on host B in the same region
- publish in region A, restore in region B after replication
- self-hosted publish/restore through rest-server

This matters because the migration is really about software distribution, not
just local backup/restore.

### Operational verification

For each verified workload, record:

- publish time
- restore time
- packed bytes
- restored local bytes
- whether the manifest matched exactly
- whether hardlink topology matched exactly

This gives us both a correctness record and a performance baseline.

### Exit criterion for verification

The rustic migration should not be considered complete until the verification
matrix passes on a meaningful set of real workloads, with exact manifest
matches and correct hardlink preservation.

### Initial verification status

The first exact-manifest verification pass ran on March 27, 2026 and produced
two clean cross-host workloads:

- `apt-jupyter-hardlinks`
- `project-1b-hardlinks`

For both workloads:

- source project manifest matched source cached restore exactly
- source project manifest matched destination cached restore exactly
- hardlink topology matched exactly

The detailed record is in:

- [rootfs-rustic-verification-2026-03-27.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-verification-2026-03-27.md)
- [rootfs-rustic-verification-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-verification-2026-03-27.json)

This is strong evidence that the current rustic publish/restore path is
correct for the tested workloads, but it is only an initial matrix. The
remaining `conda`, `pnpm`, `pip`, mixed scientific, and cross-region cases
still need to be added before we treat verification as complete.

## Operational Notes

### Rustic password / credentials

Encryption is not a product requirement here.

Therefore:

- use one shared repo credential/password per site or region,
- do not build per-user or per-image key management,
- do not expose encryption concepts in the RootFS product surface.

### Durability

Switching to rustic does not eliminate the separate durability work.

We still need:

- host operation draining,
- cleanup on restart,
- clearer retry/recovery semantics for long host operations.

That remains tracked in
[rootfs.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs.md).

## Exit Criteria

The migration is complete when:

- new RootFS publishes store as rustic snapshots,
- managed RootFS start/create/switch work from rustic-backed releases,
- cross-region restore is working,
- self-hosted RootFS uses rest-server rather than hub-local stream copy,
- the UI no longer mentions `full` versus `delta`,
- the btrfs delta path is gone.
