# RootFS Rustic Repo Sharding Plan, 2026-05-25

Status: implementation plan.

Release blocker: `8. RootFS Rustic Repo Sharding Decision`.

## Decision

Shard managed RootFS rustic repositories using the same capacity-based active
shard model as project backups.

Do not hash-shard by release id, content key, image name, or metadata key.
Hash sharding would distribute similar RootFS versions across unrelated repos
and destroy the time/locality behavior that can make rustic dedup extremely
valuable.

RootFS sharding should instead use:

- a small active shard set per region
- sticky repo assignment for a release artifact once written
- same-lineage shard affinity for new versions of an existing RootFS
- capacity-based sealing and replacement
- exact repo metadata stored with each artifact so restore and replication never
  guess

This is intentionally very similar to project backup sharding.

## Why This Matches Project Backups

Project backups already proved the important storage fact: one large rustic repo
becomes slow because rustic reads repo-global metadata. The fix was not
per-object hash sharding. The fix was a coordinated allocator with a small
number of active rustic repos per region.

RootFS images have the same repo-global metadata problem, and the consequences
are potentially worse:

- a successful service can easily reach 10K or 100K RootFS releases
- RootFS snapshots can be much larger than project backups
- common base images and iterative rebuilds create major dedup opportunities
- metadata operations on one giant repo would slow every publish, pull, restore,
  scan, and cleanup operation

The project backup model gives us the right balance:

- enough sharding to bound rustic metadata cost
- not so much sharding that dedup is destroyed
- explicit DB assignment so placement can be smarter than a hash
- operationally simple active/sealed repo lifecycle

## Key Difference From Project Backups

Projects are naturally local to an owning bay and, at runtime, a host region.

RootFS releases are naturally global catalog objects. A RootFS artifact may be
created in one region, then replicated into another region when a project in
that region needs it.

Therefore shard assignment must be per stored artifact location, not just per
global release:

- the primary artifact is assigned to a shard in its source region
- each regional replica is assigned to a shard in the destination region
- the global release points at these exact artifact locations
- restore uses the artifact's stored shard, not a fresh allocator decision

This keeps RootFS global at the catalog/API level while keeping rustic repos
regional and bounded.

## Proposed Constants

Initial values should mirror project backups unless testing proves otherwise:

- `ROOTFS_RUSTIC_ACTIVE_SHARDS_PER_REGION = 4`
- `ROOTFS_RUSTIC_RELEASES_PER_SHARD = 1000`

The capacity constant is deliberately higher than the project backup cap because
a RootFS release normally contributes one rustic snapshot, while a project can
retain many snapshots.

The cap is a policy knob, not a schema contract. If benchmarks show 500 or 2000
is better, change the constant before public release.

## Repo Layout

Use R2 bucket infrastructure exactly as project backups do. The critical change
is one rustic repo root per shard.

Example roots:

- `rustic/rootfs-images/wnam/shard-000001-<repo_id>`
- `rustic/rootfs-images/wnam/shard-000002-<repo_id>`
- `rustic/rootfs-images/europe/shard-000001-<repo_id>`

Including the repo id in the root is intentional. It prevents accidental object
store root reuse if a database is rebuilt, restored, or copied.

The old single repo root `rootfs-images` should stop being used for new managed
RootFS artifacts. CoCalc-ai is not released yet, so a clean break is acceptable.
If a short-lived dogfood compatibility path is cheap, it can exist only as a
temporary read path.

## Data Model

Add a RootFS equivalent of `project_backup_repos`.

### `rootfs_rustic_repos`

Columns:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- `region TEXT NOT NULL`
- `bucket_id UUID NOT NULL`
- `root TEXT NOT NULL`
- `secret TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'active'`
- `created TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Constraints and indexes:

- `UNIQUE(bucket_id, root)`
- index on `(region, status)`
- index on `(bucket_id)`
- status check for `active`, `sealed`, `draining`, `disabled`

Use the same status meanings as project backups:

- `active`: eligible for new artifact assignments
- `sealed`: valid for existing artifacts, not eligible for new assignments
- `draining`: operator-only exceptional state
- `disabled`: unavailable for assignment

### Artifact Storage Columns

Every rustic RootFS artifact row must store the exact repo assignment.

Update the primary release artifact path and replica artifact model so restore
can resolve the repo without recomputing placement.

Required fields:

- `repo_id`
- `bucket_id`
- `region`
- `artifact_path`
- `snapshot_id`

Recommended representation:

- add `rootfs_releases.repo_id UUID NULL`
- add `rootfs_release_artifacts.repo_id UUID NULL`
- encode new artifact paths as `rustic/v2/<repo_id>/<snapshot_id>`

The DB `repo_id` is the authority. The versioned artifact path is useful for
debugging, API compatibility, and defensive decoding.

Do not rely on `region + backend` to reconstruct a RootFS repo. That is exactly
what is wrong with the current single-repo design.

## Assignment Policy

### Invariant 1: Existing Artifact Assignment Is Sticky

If an artifact already has `repo_id`, always use that repo for restore, scan,
delete, and metadata inspection.

Do not migrate same-region RootFS artifacts during ordinary operation.

### Invariant 2: Four Active Shards Per Region

Before assigning a new RootFS artifact in a region, ensure up to four active
repos exist for that region.

This should be implemented with the same transaction/advisory-lock pattern as
project backup repo assignment so concurrent publishers do not create too many
repos or overfill one repo.

### Invariant 3: Same-Lineage Affinity First

When creating a new version of an existing RootFS, prefer the same shard as the
previous version in the same region if that repo is still active and below cap.

This is the biggest RootFS-specific win. If a 30GB image changes by 100MB, using
the same repo may mean storing and transferring roughly 100MB more instead of
another full 30GB of unique data.

The affinity lookup should be best-effort and ordered:

1. `parent_release_id` in the same region.
2. The currently selected catalog image/release being replaced, if known.
3. Same managed image family/channel/arch metadata, if present and unambiguous.
4. Recent release with the same normalized source/runtime image metadata.
5. Fall back to normal active-shard selection.

If the preferred repo is sealed, disabled, missing, in a different region, or at
capacity, fall back. Correctness is more important than affinity.

### Invariant 4: Fill Active Shards Uniformly

If no usable lineage repo exists, assign to the active repo with the fewest
assigned RootFS artifacts in that region.

Tie-breakers should match project backups:

- fewest assignments
- oldest repo creation time
- repo id

### Invariant 5: Seal At Capacity

When a repo reaches `ROOTFS_RUSTIC_RELEASES_PER_SHARD`, mark it `sealed`.

If sealing reduces the active repo count below four, create a replacement active
repo in the same allocation flow.

### Invariant 6: Replicas Are Region-Local Assignments

When replicating a RootFS release to another region:

- choose a shard in the destination region
- prefer the same lineage in that destination region if it exists
- otherwise use least-filled active shard in that destination region
- store the replica's exact `repo_id`

Do not try to preserve the source region's shard id or root name across regions.
The catalog release is global; the rustic repo is regional storage.

## Authority And Multibay Notes

RootFS catalog state is global-ish. Repo assignment must therefore be performed
by the authoritative bay for RootFS catalog writes, not opportunistically by a
random local bay.

Implementation should follow these rules:

- the bay that creates/publishes the RootFS release asks the RootFS authority to
  allocate the artifact repo
- a bay that needs a regional replica asks the RootFS authority to allocate the
  destination repo assignment
- project-hosts receive explicit repo config and never allocate RootFS repos
- restore paths trust the stored artifact location and only route to a fallback
  replica when the preferred region lacks an artifact

This keeps Launchpad as the one-bay special case of the same architecture.

## Code Areas To Update

### Server RootFS Release Logic

Main files:

- `src/packages/server/rootfs/releases.ts`
- `src/packages/server/rootfs/catalog.ts`
- `src/packages/util/rootfs-images.ts`

Required changes:

- add schema bootstrap for `rootfs_rustic_repos`
- add allocator helpers modeled on project backup sharding
- replace `ROOTFS_RUSTIC_REPO_ROOT = "rootfs-images"` for new artifacts
- make `issueRootfsReleaseArtifactUpload` allocate or reserve a sharded repo
- include `repo_id`, repo root, bucket, and selector in upload targets
- persist `repo_id` when recording uploaded artifacts
- make `buildRootfsRusticRepoConfigForRelease` load repo by artifact `repo_id`
- make `buildRootfsRusticRepoConfigForReplica` load repo by replica `repo_id`
- make delete/GC call `rustic forget` against the artifact's exact repo
- update artifact path encoding/decoding to support `rustic/v2/<repo_id>/<snapshot_id>`

### Project Host RootFS Restore/Publish

Main files:

- `src/packages/project-host/rootfs-rustic.ts`
- `src/packages/project-host/storage-reservations.ts`
- `src/packages/project-host/hub/system.ts`

Required changes:

- accept and cache multiple RootFS repo profiles by repo selector/digest
- do not assume every RootFS profile is under one logical `rootfs-images` repo
- ensure host-side restore uses the repo profile provided by the access object

The existing digest-named profile cache should mostly survive; the important
part is that the profile content now names the sharded root.

### R2 Usage Audit And Cleanup

Main file:

- `src/packages/server/cloud/cloudflare-r2-usage.ts`

Required changes:

- classify sharded RootFS roots as RootFS rustic repos
- stop assuming only `rustic/rootfs-images` or `rootfs-images/`
- include repo id/root/status in audit output when DB metadata is available
- report unknown RootFS-looking rustic roots as orphans or legacy roots
- update cleanup safety checks so sharded RootFS repos are protected by default

### CoCalc CLI

There is already CLI/admin functionality for auditing space usage and cleanup.
That must be updated so operators can see and manage sharded RootFS repos.

Required CLI outcomes:

- list RootFS rustic shards by region
- show status, assigned artifact count, cap, available slots, bucket, root, and
  approximate bytes
- include RootFS shards in R2 storage audits
- make cleanup/GC target the correct shard repo for every release artifact
- warn loudly about legacy single-root RootFS repos if any remain

This is important because once RootFS is sharded, object-store usage cannot be
understood by looking for one `rootfs-images` prefix.

### Management API And UI Scalability

Sharding is an explicit acknowledgement that RootFS can grow to 10K or 100K+
entries. The management API and UI must not assume that all RootFS entries can
be loaded, merged, filtered, rendered, or enriched in one request.

Current high-risk surfaces:

- `src/packages/frontend/admin/rootfs.tsx`
- `src/packages/frontend/rootfs/manifest.ts`
- `src/packages/frontend/rootfs/catalog-ui.tsx`
- `src/packages/frontend/hosts/hooks/use-host-rootfs-images.ts`
- `src/packages/server/rootfs/catalog.ts`
- `src/packages/server/conat/api/system.ts`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/conat/hub/api/system.ts`
- `src/packages/conat/hub/api/hosts.ts`

Specific risks:

- the admin RootFS page currently requests the whole admin catalog
- visible catalog loading returns full arrays and then filters client-side
- select/dropdown UIs can become unusable with thousands of options
- host RootFS cache pages may list all cached images on one host
- scan host selection may probe or enrich too many entries
- storage locations, recent events, scan summaries, and lifecycle data make each
  row heavier over time

Required API shape:

- add paged RootFS catalog queries with `limit`, `cursor`, `query`, and
  structured filters
- support sorting by updated time, created time, label, family, visibility,
  official status, scan status, storage status, owner, and usage count
- split summary list rows from heavy detail records
- provide detail fetch by `image_id` or `release_id`
- provide typeahead/search endpoints for project/course image selection
- keep the existing small public catalog path only for curated visible choices,
  not for every historical/user/private RootFS release

Required UI behavior:

- admin page uses server-side paging, server-side search, and server-side
  filters
- admin table renders summary rows and lazy-loads lifecycle, events, scan
  report, storage locations, and delete blockers on expansion/details
- project/course RootFS selectors use search/typeahead and show curated latest
  official images by default
- host RootFS cache page supports pagination/filtering by image, release,
  cached/pulled status, size, and last used
- no RootFS page renders tens of thousands of rows or options in memory

Membership limits help control per-user creation and total storage usage, but
they do not remove the need for scalable catalog/search surfaces. Successful
global usage can still create a large aggregate catalog.

## Implementation Phases

### Phase 1: Schema And Allocator

- add `rootfs_rustic_repos`
- add `repo_id` columns to primary and replica artifact storage
- add active/sealed status constants
- add `ensureRootfsRusticRepoSchema`
- add `selectRootfsRusticRepoForArtifact`
- add unit tests for active shard creation, capacity sealing, least-filled
  assignment, and concurrent allocation safety

### Phase 2: Publish Path

- change RootFS publish upload target creation to allocate a sharded repo
- pass `repo_id` and sharded repo config to project-host
- persist repo assignment when upload completes
- add same-lineage affinity using `parent_release_id` first
- add tests that a second version of a RootFS uses the prior version's shard
  when possible

### Phase 3: Restore, Scan, And GC

- update access-building functions to load repo config by `repo_id`
- update release and replica restore paths
- update scan paths that resolve artifact locations
- update delete/GC paths to forget snapshots from the exact shard
- test that no restore path reconstructs repo config from only backend/region

### Phase 4: Regional Replication

- make replica creation allocate a destination-region RootFS shard
- store replica `repo_id`
- prefer destination-region lineage if present
- test source-region and destination-region shards are independent

### Phase 5: CLI And Operations

- extend CLI admin/audit commands for sharded RootFS repos
- update Cloudflare R2 usage classification
- add output that groups RootFS shards by region/status
- add orphan/legacy root detection
- document the operator workflow for sealing, disabling, and inspecting a shard

### Phase 6: Management API And UI Scaling

- add paged/searchable RootFS catalog API types
- convert admin RootFS table to server-side pagination/search/filtering
- split list summaries from detail fetches
- convert project/course RootFS selection to typeahead/search with curated
  defaults
- add pagination/filtering to host RootFS cache listings
- verify pages remain responsive with synthetic 50K-entry catalogs

### Phase 7: Dogfood Cutover

- stop writing new artifacts to the old single RootFS repo
- either rebuild the current dogfood RootFS or add a temporary legacy read path
- publish a base RootFS
- publish a small update and verify same-shard placement
- verify rustic dedup by comparing bytes transferred/stored where feasible
- start a project from the new image in the source region
- start a project from the same image in another region and verify replica
  shard assignment
- run scan and GC smoke tests

## Test Plan

Allocator tests:

- creates four active repos per region
- chooses least-filled active repo
- seals full repos and creates replacements
- preserves existing artifact repo assignment
- prefers parent release repo when active and under cap
- falls back when parent repo is sealed, disabled, full, or in another region

Publish tests:

- upload target includes `repo_id` and sharded repo selector
- uploaded artifact persists `repo_id`
- second version of a release family uses the same shard when possible

Restore/access tests:

- release access loads repo config by `repo_id`
- replica access loads repo config by replica `repo_id`
- artifact path `rustic/v2/<repo_id>/<snapshot_id>` decodes correctly
- legacy artifact path handling is either explicitly rejected or covered by a
  temporary compatibility test

Replication tests:

- destination region gets a destination-region shard
- destination lineage affinity works independently from source-region affinity

Audit/CLI tests:

- R2 audit classifies sharded RootFS repos as RootFS
- old single-root RootFS prefixes are reported as legacy
- CLI shard listing reports region/status/count/cap/bytes/root
- cleanup/GC uses the artifact's exact repo, not a region default

Management UI/API tests:

- admin RootFS API returns stable pages and cursors
- admin filters and search are applied server-side
- admin page does not request full heavy detail for list rows
- project/course selectors can search without loading the full catalog
- host RootFS cache page handles thousands of cached images with pagination
- synthetic 50K-entry catalog does not freeze the browser

## Operational Notes

The normal operator lifecycle should be the same as project backup shards:

- active shards receive new artifacts
- full shards become sealed
- sealed shards remain readable and eligible for restore/scan/delete
- disabled shards are not assigned and require explicit operator action
- draining is reserved for exceptional repair/migration work

No routine rebalancing should be part of v1. Rebalancing large RootFS artifacts
is expensive and usually unnecessary. The system should avoid bad placement
when writing new artifacts rather than trying to continuously move old ones.

## Open Decisions

1. Exact capacity cap: start with `1000` RootFS releases per shard unless a quick
   benchmark suggests `500`.
2. Lineage key: `parent_release_id` is clear; catalog family/channel metadata may
   need a small explicit field if current metadata is not stable enough.
3. Legacy support: because CoCalc-ai is not released, prefer rebuilding the one
   serious dogfood RootFS over carrying permanent compatibility code.
4. Authority path: confirm whether RootFS catalog writes are already centralized
   enough or need an explicit inter-bay allocation RPC.
5. Default page size: likely 50-100 rows for admin tables and 20-50 rows for
   selectors, but validate against actual row weight and UX.

## Definition Of Done

- new RootFS publishes go to sharded rustic repos
- new versions of an existing RootFS prefer the same shard when possible
- restores, scans, replicas, and GC use stored repo ids
- R2 audit and CLI cleanup understand sharded RootFS repos
- RootFS admin, project/course selectors, and host cache pages use scalable
  paged/search APIs
- no new code path assumes the repo root is the single global `rootfs-images`
- dogfood RootFS publish, update, regional replicate, project start, scan, and
  GC all work against sharded repos
