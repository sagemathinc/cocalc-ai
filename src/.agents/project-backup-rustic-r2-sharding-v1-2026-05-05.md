# Project Backup Rustic R2 Sharding V1

Status: proposed implementation plan as of 2026-05-05

This note defines the first full implementation of sharded rustic-backed
project backups for the main CoCalc site.

The immediate goal is to stop using one large shared rustic repo per region for
project backups. We already know that this does not scale:

- every `rustic backup` reads repo-global index metadata
- parent discovery was one issue, and has now been improved with explicit
  `--parent`
- the remaining pain is still repo-global `reading index...`
- current live measurements around `~14,728` index files / `~16,087`
  snapshots are already enough to cause unacceptable latency

This document is intentionally about the main-site R2 backup path. Self-hosted
mode may continue using simpler rustic layouts for much longer.

## Decision Summary

V1 should implement:

- sticky shard assignment per project within a backup region
- `4` active shards per backup region
- uniform fill across active shards
- `500` projects per shard cap
- `10` retained backups per project by default
- clone inheritance:
  if a project is cloned from another project and the source shard is still
  active and under cap, inherit the source shard
- no same-region reassignment during normal operation
- no routine draining or rebalancing in v1

V1 should not implement:

- deterministic hash sharding
- course-aware placement
- routine same-region migrations
- second-line cold archive storage for archived projects

## Why V1 Looks Like This

The design is driven by five facts:

1. Rustic repo metadata cost, not raw upload bandwidth, is the main scaling
   problem.
2. Cross-project dedup is materially useful for CoCalc, especially:
   - class projects
   - copied/template projects
   - many projects with similar dependency trees
3. We already have central coordination and lookup for project backups, so we
   do not need stateless hash placement.
4. Over-sharding is not free:
   - it reduces cross-project dedup
   - it increases total stored data
   - it increases total object churn
5. Under-sharding is also not acceptable because it recreates today's global
   rustic metadata bottleneck.

The point of `4` active shards is to bound the dedup penalty while keeping
concurrency and rustic metadata costs manageable.

## Architecture Constraints

### Multi-Bay Reality

We do **not** have one shared Postgres for all bays.

Each bay has its own Postgres, and that matters for coordination.

However, we do have one seed bay that already acts as the global authority for
selected shared concerns such as authentication and purchases. For sharded
project backups, the seed bay must be the authority for shard allocation.

This means:

- shard assignment authority is centralized at the seed bay
- ordinary backup execution remains regional / host-local
- non-seed bays must ask the seed bay when they need a new shard assignment

### Current Data Model

We already have the right basic primitives:

- `projects.backup_repo_id`
- `project_backup_repos`
- cross-bay RPC paths via the seed bay

This plan builds on those instead of inventing a new distributed system.

## Scope Of This Plan

This plan covers:

- project backup repo sharding
- assignment policy
- seed-bay coordination
- migration from the current large shared repos
- metrics and operational thresholds

This plan does **not** change:

- direct-R2 storage of backup index sqlite sidecars
- project-host local cache behavior
- self-hosted REST/SSH rustic repo layout
- archived-project cold secondary storage

## Bucket / Prefix Layout

For the main site, assume one R2 bucket for project backups is acceptable.

Within that bucket, each rustic shard gets its own root prefix, for example:

- `rustic/project-backups/wnam/shard-000001`
- `rustic/project-backups/wnam/shard-000002`
- `rustic/project-backups/europe/shard-000001`

This plan does not require collapsing the current bucket abstraction on day one.
If implementation is easier using the existing bucket rows, that is fine. The
critical change is the rustic repo root layout and assignment logic, not the
bucket count.

## Shard States

`project_backup_repos.status` should be used with these meanings:

- `active`
  - eligible for new assignments
- `sealed`
  - valid for existing assigned projects
  - not eligible for new assignments
- `draining`
  - exceptional operator-only recovery mode
  - not part of normal v1 operation
- `disabled`
  - no new work and no assignment

V1 should normally use only:

- `active`
- `sealed`

## Assignment Rules

### Invariant 1: Sticky Assignment

Once a project has a `backup_repo_id`, keep it for all future backups in that
region.

Do not change `backup_repo_id` within a region during ordinary operation.

Only cross-region move cutover may assign a new `backup_repo_id`.

### Invariant 2: Four Active Shards Per Region

Each backup region should have up to `4` `active` shard repos available for new
assignment.

If fewer than `4` exist, the allocator creates more before assigning.

### Invariant 3: Uniform Fill

New projects should be assigned to the active shard with the fewest assigned
projects, breaking ties by oldest repo creation time and then repo id.

This is intentionally **not** least-loaded across every shard ever created.
Only `active` shards participate.

### Invariant 4: Seal At Cap

When a shard reaches `500` assigned projects, it becomes `sealed`.

If sealing would reduce the active set below `4`, create a replacement active
shard before or during the same allocation flow.

### Invariant 5: Clone Inheritance

If a project is created by cloning/copying another project and:

- the source project has a `backup_repo_id`
- that repo is still `active`
- that repo is below cap

then assign the new project to the same shard.

This is the one special placement rule in v1 because it is simple and gives
substantial dedup wins.

## Why Not Deterministic Hash Sharding

V1 should not do hash-based shard assignment.

Reasons:

- early growth would spread similar projects across too many repos
- cross-project dedup would be worse than necessary
- course and batch-created projects would lose locality
- shard-count growth would be awkward
- we already have central coordination, so stateless placement is not worth the
  tradeoff

This system is coordination-backed storage assignment, not a distributed
filesystem metadata path. We can afford an explicit allocator.

## Why Course-Aware Placement Waits

There is a `course` field on `projects`, and long term we should likely use it.

However, v1 should not make course affinity part of assignment policy yet.

Reasons:

- it adds policy complexity immediately
- `4` active shards already keeps batch-created cohorts fairly localized
- many important dedup wins come from creation-time proximity alone
- clone inheritance captures a large fraction of the templating use case

Course-aware placement remains a likely v2 optimization.

## Retention Policy

Default active-project backup retention should be reduced to `10`.

This matters because shard capacity is really a proxy for total retained
snapshots in one repo.

Approximate consequences:

- `500` projects/shard
- `10` backups/project
- about `5,000` retained snapshots/shard at steady state

That is a much more defensible starting point than the current effective scale
we already know causes pain.

## Seed-Bay Coordination Model

### Authority

The seed bay is authoritative for:

- creating new shard repos
- determining the active set for a region
- assigning `backup_repo_id` for projects that do not already have one

Non-seed bays are authoritative only for:

- using an already assigned `backup_repo_id`
- executing actual backup/restore operations with the resulting rustic config

### Required Property

Assignment decisions must be globally coordinated per backup region, not per
bay.

Otherwise each bay would independently maintain its own `4` active shards and
the effective shard count would multiply.

### Allocation Flow

When a bay needs a backup repo for a project with no `backup_repo_id`:

1. call the seed-bay backup-assignment API
2. seed bay starts a transaction
3. seed bay takes a transaction-scoped advisory lock for the backup region
4. seed bay loads active repos for the region
5. if active repo count is below `4`, seed bay creates more
6. seed bay selects the target repo:
   - clone inheritance first
   - otherwise active shard with lowest assigned project count
7. if selected repo is already at cap, mark it `sealed` and re-evaluate
8. seed bay writes `projects.backup_repo_id`
9. seed bay returns repo identity and backup config

This is the critical coordination point.

### Caching

Caching is allowed, but only for reads.

Safe cached items:

- active shard lists by region
- resolved backup config for an already assigned repo

Unsafe cached decision:

- inventing a new `backup_repo_id` assignment locally without consulting the
  seed bay

So v1 should:

- permit short TTL caching of repo metadata/config
- require seed-bay round-trip for first assignment of an unassigned project

### Burst Behavior

Creating `1000` projects quickly is a real scenario.

V1 should not attempt clever distributed reservations initially.

Instead, accept serialized region assignment at the seed bay and measure it.

Reasons:

- the assignment transaction is cheap compared to backup execution
- we already need a correct global decision
- premature reservation schemes add risk and complicate correctness

If burst assignment throughput becomes a real bottleneck, follow-up work can add
region-scoped shard allocation blocks or bay-local reservations. That is not
required for v1.

## Schema Changes

V1 can stay close to the existing schema.

### `project_backup_repos`

Existing fields already cover most needs:

- `id`
- `region`
- `bucket_id`
- `root`
- `secret`
- `status`
- `created`
- `updated`

V1 should use `status` values consistently rather than adding a new shard-state
table.

Optional additions if they simplify operations:

- `capacity_projects INTEGER`
  - default `500`
  - explicit per-repo cap, even if globally uniform at first
- `sealed_at TIMESTAMP`
  - mostly operationally useful

Neither is strictly required for first implementation.

### `projects`

No new field is required beyond continuing to use:

- `backup_repo_id`

## Seed-Bay API Changes

Add a seed-bay-owned API specifically for assignment, conceptually:

- `assignProjectBackupRepo(...)`

Inputs:

- `project_id`
- `project_region`
- optional `source_project_id`
- optional `preferred_backup_repo_id` for internal flows if needed

Outputs:

- `backup_repo_id`
- repo metadata needed to construct the rustic config

This should be the only path that creates a new assignment for an unassigned
project.

Existing config-fetch APIs should continue to work when `backup_repo_id` is
already known.

## Allocation Policy Details

### Normal New Project

For a new project with no source project:

- ask seed bay for assignment
- assign to lowest-count active shard under cap

### Clone / Copy

If the new project was cloned from another project:

- try source shard first if:
  - same backup region
  - source repo status is `active`
  - source repo assigned project count is below cap
- otherwise fall back to normal new-project assignment

### Cross-Region Move

Cross-region move should:

- preserve the existing shard while the source region remains authoritative
- allocate a destination-region shard only during cutover
- update `projects.backup_repo_id` only after successful destination backup and
  restore steps

This is already close to how backup-region cutover works conceptually, and
sharding should plug into that flow.

## Migration Strategy

V1 should avoid a mass rebalance.

### Existing Projects

Existing projects keep their current `backup_repo_id`.

If a region currently has one huge shared repo:

- that repo remains valid
- mark it `sealed` once the new allocator is enabled
- do not assign new projects to it

### New Projects

New projects created after the feature flag flips use the new allocator and new
shards.

### Result

This means v1 can stop making the problem worse without immediately moving old
data around.

That is the right rollout strategy.

## Operational Thresholds

Hard cap for v1:

- `500` assigned projects per shard

Soft metrics to monitor:

- p95 backup start latency
- p95 `reading index...` duration
- cold-cache destination restore/backup latency during moves
- shard-level assigned project count
- shard-level retained snapshot count, if cheap to compute

If metrics are still bad after rollout, the next move is lowering cap, not
changing the entire allocator shape.

## Implementation Order

### Phase 1: Control Plane And Schema

1. make `project_backup_repos.status` semantics explicit
2. add seed-bay assignment API
3. update config-fetch path to use existing assigned repo when present
4. route new-assignment requests to seed bay

### Phase 2: Allocator

1. ensure at most `4` active shards per region
2. create active shards lazily
3. implement uniform fill across active shards
4. implement seal-at-cap
5. implement clone inheritance

### Phase 3: Retention

1. reduce default active-project backup retention from `30` to `10`
2. verify host-local limit enforcement remains consistent

### Phase 4: Rollout

1. mark current giant shared repos `sealed`
2. enable sharded allocation for new projects
3. measure live backup and move latency by region

## Test Plan

Required tests:

- seed-bay assignment serializes correctly under concurrency
- non-seed bays never create local assignments on their own
- `4` active shards are maintained per region
- new project assignment distributes uniformly over active shards
- shard seals at `500`
- sealed shards are never chosen for new assignments
- clone inheritance uses source shard when valid
- clone inheritance falls back when source shard is sealed or full
- cross-region move allocates destination shard only at cutover
- existing projects with old `backup_repo_id` keep using it

Required live validations:

- create a burst of many projects in one region and inspect shard spread
- create cloned/template projects and verify locality
- run move tests across regions after cutover
- measure destination backup startup time on fresh hosts against the new shard
  sizes

## Non-Goals For V1

V1 explicitly does not include:

- automatic same-region draining
- operator-friendly same-region rebalancing
- course-aware shard affinity
- adaptive caps based on live rustic timing
- shard reservations / assignment blocks for extreme creation bursts
- cold secondary archive copies for archived projects

## Follow-Up For Later

These are good future additions, but should not block v1.

### Course-Aware Placement

Use `projects.course` to bias projects in the same course toward the same active
shard when that shard still has room.

### Adaptive Sealing

Seal shards based not only on project count but also on measured rustic latency.

### Region-Level Reservations

If seed-bay assignment becomes a throughput bottleneck for burst project
creation, add short-lived per-bay reservations from the seed bay.

### Draining

Implement `draining` only as an exceptional recovery tool for catastrophic repo
failure:

- create fresh backups for assigned live projects into replacement shards
- move project assignments forward
- retain the old repo only as long as operationally needed

This is not normal capacity management.

### Cold Archive Copy For Archived Projects

Later, archived projects may get an uncorrelated second copy in very cheap cold
storage, likely as an encrypted compressed tarball, not another rustic repo.

This is valuable, but separate from sharding and should not delay v1.

## Bottom Line

The right v1 is:

- coordinated by seed bay
- sticky per-project assignment
- `4` active shards per region
- `500` projects per shard
- `10` backups per project
- uniform fill
- clone inheritance
- no routine drain

This is simple enough to implement now, preserves much of the dedup value we
care about, and directly addresses the rustic metadata scaling problem that is
currently dominating backup and move latency.
