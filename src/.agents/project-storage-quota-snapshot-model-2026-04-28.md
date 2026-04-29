# Project Storage, Quota, and Snapshot Model

Last updated: April 28, 2026

Status: implemented design note with remaining cleanup

## Executive Summary

We should keep the current authoritative quota definition:

- the enforced project quota is the btrfs simple-quota `getQuota(project_id)`
  value,
- that value includes snapshot-retained data,
- and the product should explain that truthfully instead of trying to hide it.

At the same time, we should replace the current `dust`-based live-usage model
with a `du`-based model because:

- `du` is materially faster and cheaper,
- `dust -s` does not inode-dedupe apparent size,
- the current `dust` metric is both slower and less correct for the top-line
  storage number.

The user-facing storage model should become:

1. `Quota used`
   - authoritative
   - comes from `getQuota(project_id)`
   - includes snapshot-retained data

2. `Live files`
   - fast visible apparent-size metric
   - comes from `du -sx --bytes <quota-scoped live tree>`

3. `Retained snapshot/history data (estimate)`
   - derived
   - `max(0, quota_used - live_visible_quota_scoped_bytes)`
   - not exact per-snapshot accounting

Temporary disposable storage should live in a separately capped, disk-backed
`/tmp`. It is not part of the durable project quota explanation.

## Decision

We should do all of the following:

- switch quota-facing live usage from `dust` to `du`,
- keep the current quota definition, including snapshots,
- explain snapshot-retained usage honestly as an estimate derived from the
  difference between quota and visible live usage,
- fix snapshot deletion so it reliably works from user-facing UI flows,
- make snapshot cleanup easier and more visible,
- surface and tier snapshot and backup limits in the product instead of relying
  on hidden hardcoded caps.

## Why This Decision Is Correct

### 1. The current quota value is real and enforceable

Today the project quota is computed from the direct project subvolume qgroup in:

- [subvolume-quota.ts](/home/user/cocalc-ai/src/packages/file-server/btrfs/subvolume-quota.ts)

That value is the one the backend actually enforces. Keeping it as the product
truth avoids a class of confusing bugs where the UI says one thing and the
filesystem refuses writes based on another metric.

### 2. Snapshot-retained data is large and dynamic

On the dogfood project, the quota-used number dropped from roughly `26.7 GB`
down to around `21.5 GB` over time while the visible live tree stayed mostly
stable. That was not random. It matched rolling snapshot retention:

- older snapshots with high retained-exclusive bytes aged out,
- newer snapshots with low retained-exclusive bytes replaced them,
- the qgroup usage dropped accordingly.

This is exactly the behavior users need to understand:

- deleting live files may not reduce quota immediately,
- quota can drop later as snapshots age out,
- snapshot-retained usage is dynamic even if the snapshot itself is immutable.

### 3. Exact per-snapshot accounting is too expensive for the hot path

We measured:

- `btrfs filesystem du -s <snapshot>` gives meaningful snapshot retention data,
- but scanning all `19` snapshots on the dogfood project took about `152s`.

That is too expensive for:

- the default UI,
- periodic polling,
- request-path quota explanation.

### 4. Per-snapshot qgroup rows are misleading

We also measured that the per-snapshot `btrfs qgroup show` row can be tiny
while the snapshot clearly retains large amounts of data. So the old
`allSnapshotUsage` qgroup-based model is not suitable for customer-facing
storage explanation.

### 5. `du` is better than `dust` for the authoritative live metric

On `/home/user/cocalc-ai`, measured locally:

- `du -sx --bytes .`
  - `elapsed=1.232`
  - `cpu=107%`
- `dust -j -x -T 2 -d 1 -s -o b -P .`
  - `elapsed=1.899`
  - `cpu=178%`
- `dust -x -s -d 0 .`
  - `elapsed=2.805`
  - `cpu=874%`

This is the wrong trade:

- slower,
- more CPU,
- less correct for the top-line metric.

In addition, `dust -s` disables inode deduplication for apparent size, so it
can materially overcount hardlinked content. On the full dogfood project, the
measured distortion was multiple gigabytes, mainly in the environment tree.

## Model Diagram

```mermaid
flowchart LR
    Q["Project quota used<br/>`getQuota(project_id)`<br/>includes snapshots"] --> UI["Storage UI"]
    L["Live quota-scoped tree<br/>`du -sx --bytes <home>`"] --> UI
    S["Rolling snapshots<br/>retain deleted and shared extents"] --> Q
    E["Environment bucket<br/>visible split inside home"] --> UI
    R["Retained snapshot/history data estimate<br/>`max(0, quota_used - live_home_visible)`"] --> UI
    Q --> R
    L --> R
    T["Temporary storage<br/>disk-backed `/tmp`<br/>separate cap, disposable"] --> UI
```

## Important Semantics

### Quota

`Quota used` should remain:

- the current project-home qgroup usage,
- not a synthetic value,
- not a live-files-only approximation.

### Live files

`Live files` should be:

- a fast, deduped apparent-size metric of the quota-scoped live tree,
- computed with `du -sx --bytes`,
- not based on `dust`.

### Retained snapshot/history data

This should be shown as an estimate, not an exact per-snapshot number.

Definition:

- `retained_estimate_bytes = max(0, quota_used_bytes - live_home_visible_bytes)`

This is useful because it answers the practical customer question:

- “Why is my quota usage larger than the files I can see right now?”

But it should not be labeled as exact `Snapshot usage`, because the value is:

- derived,
- affected by sharing semantics,
- and not attributable cheaply to individual snapshots.

### Temporary Storage: Replace `/scratch` With `/tmp`

We should remove `/scratch` as a product concept.

Rationale:

- it has not been useful during serious dogfooding,
- it is easy to misunderstand as durable storage even though it is not,
- it disappears on host loss, migration, archive, and similar lifecycle
  events,
- it has no backups and no snapshots,
- `/tmp` already exists and is the standard place users expect temporary data,
- and it complicates the storage/quota model for no product benefit.

The right model is:

- keep durable project storage in the project home,
- keep temporary disposable storage in `/tmp`,
- and do not expose a second user-facing temporary filesystem.

Current implementation direction:

- stop mounting a default tmpfs `/tmp`,
- mount the current ephemeral temp volume at `/tmp`,
- remove `/scratch` from user-facing UI, docs, and quota explanations,
- and do not keep a hidden `/scratch` compatibility alias around longer than
  necessary while we are still pre-production.

Capacity policy:

- `/tmp` should have its own cap, not mirror full project disk quota,
- a good first rule is:
  - `tmp_cap_bytes = min(10 GB, project_disk_quota_bytes)`

This keeps temporary storage useful for builds and package work while bounding
abuse and avoiding the current “half the memory limit goes to tmpfs” default.

## Current Hidden Limits

We already have hidden hardcoded limits and caps in multiple places:

- frontend snapshot schedule editor max per bucket:
  - [edit-schedule.tsx](/home/user/cocalc-ai/src/packages/frontend/project/snapshots/edit-schedule.tsx)
  - `MAX = 50`
- hub snapshot creation hard cap:
  - [project-snapshots.ts](/home/user/cocalc-ai/src/packages/server/conat/api/project-snapshots.ts)
  - `MAX_SNAPSHOTS_PER_PROJECT = 250`
- project-host scheduled maintenance limit default:
  - [file-server.ts](/home/user/cocalc-ai/src/packages/project-host/file-server.ts)
  - `runScheduledSnapshotMaintenance(... limit = 250 )`

This is already a policy layer. It is just not surfaced, coherent, or tied to
membership.

## Product Positioning

The product should say, in plain language:

- project quota includes snapshot-retained data,
- snapshots help protect work but can also keep deleted data alive,
- older automatic snapshots age out automatically,
- deleting unneeded snapshots is one way to reduce quota usage,
- and there are plan-based limits on how many snapshots and backups a project
  can retain.

This is a better model than pretending snapshots do not count while relying on
hidden backend safety behavior.

## Current Regression To Fix

Snapshot deletion is currently broken or fragile in at least one user-facing
path.

Observed behavior:

- deleting snapshot paths from the UI can fail with:
  - `EIO: Read-only file system (os error 30)`
  - errors from `privileged-rm-helper`

The likely issue is that deleting a path under `~/.snapshots/...` is going
through the generic file-removal path against a readonly snapshot subvolume
instead of the dedicated snapshot delete path:

- [subvolume-snapshots.ts](/home/user/cocalc-ai/src/packages/file-server/btrfs/subvolume-snapshots.ts)

This matters to the product decision because if snapshots count against quota,
then deleting snapshots must be a reliable and obvious way to reduce retained
quota usage.

So “fix snapshot deletion” is part of the storage rollout, not optional polish.

## Implementation Status

### Completed

The main storage and temp-model rollout described above is now implemented:

1. Quota-facing live usage uses `du`, not `dust`.
   - project storage overview and history now use a `du`-based live-files
     metric
   - retained snapshot/history data is derived as `max(0, quota_used - live)`

2. The storage UI, CLI, and history model now use the same semantics.
   - `Quota used`
   - `Live files`
   - `Retained snapshot/history data`

3. Snapshot deletion was fixed.
   - snapshot-root deletes now route through snapshot deletion APIs instead of
     generic recursive rm behavior on readonly subvolumes

4. Snapshot and backup count limits are explicit policy now.
   - owner effective limits are resolved centrally
   - host-side backup enforcement fetches those limits from the hub

5. Total account storage now follows the frozen per-project quota model.

6. The product temp model has moved from `/scratch` to `/tmp`.
   - `/tmp` is now backed by the ephemeral disk volume, not default tmpfs
   - `/tmp` has its own cap:
     - `min(10 GB, project disk quota)`
   - the durable quota explanation no longer depends on a visible `Scratch`
     bucket
   - the old `/scratch` alias has been removed from runtime mounts and sandbox
     path resolution

### Remaining Cleanup

The work that remains is narrower and mostly about cleanup:

1. Audit stale copy and UI text.

Known example:

- [components.tsx](/home/user/cocalc-ai/src/packages/frontend/project/info/components.tsx)
  still described `/tmp` as in-memory before this note was updated

We should keep removing any remaining text that implies:

- `/tmp` is tmpfs-backed by default
- `/scratch` is a supported user-facing place to work

2. Keep `/tmp` out of the durable quota story.

The temp volume is intentionally separate. Future changes must not:

- fold `/tmp` bytes into retained snapshot/history data
- reintroduce a visible `Scratch` bucket
- imply that `/tmp` is durable or snapshotted

3. Keep exact snapshot diagnostics off the hot path.

If we need deep support tooling later, keep it as an explicit diagnostic action
using `btrfs filesystem du`, not the default storage UI.

## Risks

1. Directory bucket attribution is still not mathematically perfect when
   hardlinks cross directories.
   - acceptable for cleanup UX
   - not acceptable as the top-line quota metric

2. Users may still read `retained snapshot/history data` as exact snapshot
   usage if copy is sloppy.
   - solve with precise labeling

3. Temporary `/tmp` semantics are separate from the durable project quota
   explanation.
   - we must not silently mix ephemeral temp bytes into the retained-estimate
     story

4. Snapshot/backup limits need one canonical owner-based source of truth.
   - otherwise the hub, UI, and project-host will drift

## Recommended Order

1. Audit and fix the remaining `/tmp` and snapshot-retention copy in the UI and
   CLI.
2. Leave exact snapshot forensics as an explicit advanced diagnostic only.

## Bottom Line

The correct product posture is now:

- quota is real and includes snapshots,
- live usage is computed with `du`, not `dust`,
- retained snapshot/history data is shown as a fast derived estimate,
- temporary disposable storage lives in disk-backed `/tmp`, not a separate
  user-facing `/scratch`,
- and snapshot/backup count limits are explicit plan features rather than
  hidden hardcoded guardrails.
