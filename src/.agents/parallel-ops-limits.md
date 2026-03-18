# Parallel Ops Limits

Goal: make CoCalc Launchpad long-running operation concurrency limits visible,
auditable, and dynamically adjustable, while replacing the most dangerous
global caps with policies that match the actual topology of project hosts.

This is both a scale-hardening project and an operational safety project.
Today several critical workers use hidden process-local constants such as
`MAX_PARALLEL = 1` or `10`, and there is no single place to answer:

- what worker kinds exist
- what their current limits are
- how full they are right now
- whether the limit is global, per-provider, per-project-host, or per-worker
- whether changing the limit requires a restart

The immediate pressure comes from at least two known issues:

- `project-move` concurrency is globally pinned to `1`
- backup throughput is limited by a hub-side cap that is effectively global per
  `conat-api` process, even though backup work is actually executed on project
  hosts

## Acceptance Scenarios

1. An admin can query one API and get the effective concurrency policy and
   current fullness for all important Launchpad worker kinds.
2. An admin can change the hub-side `project-move` limit at runtime without
   restarting the hub.
3. An admin can change the hub-side backup admission limit at runtime without
   restarting the hub.
4. Backup admission is no longer only a global scalar; there is also a
   per-project-host cap enforced at claim/scheduling time.
5. For host-side backup execution, the system exposes per-host slot usage and
   configured per-host limit.
6. Limit changes are durable across restart.
7. Limit changes are admin-only and leave an audit trail.
8. Reducing a limit does not kill already-running work; it only reduces future
   claims.

## Non-Goals

- Building a polished admin UI in the first iteration.
- Automatically tuning limits.
- Making every low-level library constant dynamically configurable.
- Replacing all queueing logic in one pass.

The first target is the product-facing long-running workers and the cloud VM
work queue that materially affect Launchpad behavior.

## Current Inventory

### Hub-side LRO Workers

- `src/packages/server/projects/move-worker.ts`
  - `project-move`
  - current cap: `MAX_PARALLEL = 1`
- `src/packages/server/projects/restore-worker.ts`
  - `project-restore`
  - current cap: `MAX_PARALLEL = 1`
- `src/packages/server/projects/hard-delete-worker.ts`
  - `project-hard-delete`
  - current cap: `MAX_PARALLEL = 1`
- `src/packages/server/projects/copy-worker.ts`
  - `copy-path-between-projects`
  - current cap: `MAX_PARALLEL = 2`
- `src/packages/server/projects/backup-worker.ts`
  - `project-backup`
  - current cap: env-driven `COCALC_BACKUP_LRO_MAX_PARALLEL`, default `10`
- `src/packages/server/hosts/start-worker.ts`
  - host ops (`host-start`, `host-stop`, `host-delete`, etc.)
  - current cap: `MAX_PARALLEL = 2`

### Host-side Execution Limits

- `src/packages/project-host/file-server.ts`
  - backup execution on one project-host
  - current cap: env-driven `COCALC_PROJECT_HOST_BACKUP_MAX_PARALLEL`,
    default `10`
  - current behavior is per project-host process, with in-memory slot tracking
    and an additional per-project serialization lock

### Cloud Work Queue

- `src/packages/server/cloud/worker.ts`
  - non-LRO VM work queue
  - current caps:
    - `DEFAULT_MAX_CONCURRENCY = 10`
    - `DEFAULT_PER_PROVIDER = 10`

### Shared Claim Path

- `src/packages/server/lro/lro-db.ts`
  - `claimLroOps(...)`
  - today it only knows `kind + limit`
  - it does not understand host-aware admission, provider-aware admission, or
    kind-specific fairness policies

## Core Diagnosis

There are three different classes of concurrency policy mixed together today:

1. Hub-side worker claim concurrency
   - how many LROs one hub cluster may actively run for a given kind
2. Topology-aware admission policy
   - e.g. for backups, how many operations should target the same project host
   - e.g. for moves, how many operations should touch the same source/dest host
3. Host-local execution concurrency
   - e.g. how many backups a specific project-host process may execute at once

Treating all three as one integer is the main architectural problem.

## Proposed Architecture

## 1. Introduce a Worker Limit Registry

Add a shared registry module that describes the known operational workers.

Suggested file:

- `src/packages/server/lro/worker-registry.ts`

Each entry should define:

- `kind`
- `category`
  - `lro`
  - `cloud-work`
  - `host-local`
- `scope_model`
  - `global`
  - `per-provider`
  - `per-project-host`
  - `per-move-host-pair`
- `default_global_limit`
- `default_per_host_limit`
- `default_per_provider_limit`
- `min_limit`
- `max_limit`
- `supports_dynamic_limit`
- `supports_host_breakdown`
- `status_provider`
- `config_provider`

This registry becomes the source of truth for:

- what workers exist
- which ones can be changed live
- which metrics should be shown
- which scopes apply to each worker kind

This avoids hidden constants scattered across worker files.

## 2. Add Durable Limit Storage

Do not use process-local constants or env vars as the runtime source of truth
for hub workers.

Add a Postgres-backed table, e.g.:

- `lro_worker_limits`

Suggested fields:

- `worker_kind TEXT NOT NULL`
- `scope_type TEXT NOT NULL`
  - `global`
  - `provider`
  - `project_host`
  - `move_host`
- `scope_id TEXT`
- `limit_value INTEGER NOT NULL`
- `enabled BOOLEAN NOT NULL DEFAULT TRUE`
- `updated_at TIMESTAMPTZ NOT NULL`
- `updated_by UUID`
- `note TEXT`
- unique key on `(worker_kind, scope_type, scope_id)`

Rationale:

- this is more structured than overloading `server_settings`
- it naturally supports future per-host/per-provider overrides
- it gives a clean audit trail

`server_settings` can still be used later for UI defaults, but the operational
runtime source should be a dedicated table.

## 3. Add Read-Only Status API First

Add an admin-only status API before changing runtime behavior.

Suggested hub API additions:

- `system.getParallelOpsStatus()`
- `system.getParallelOpsConfig()`

Files:

- `src/packages/conat/hub/api/system.ts`
- `src/packages/server/conat/api/system.ts`

Return shape per worker kind:

- `worker_kind`
- `category`
- `scope_model`
- `default_limit`
- `configured_limit`
- `effective_limit`
- `config_source`
  - `default`
  - `db-override`
  - `env-legacy`
- `queued_count`
- `running_count`
- `stale_running_count`
- `oldest_queued_ms`
- `workers_alive`
- `owners`
  - counts by `owner_id`
- `breakdown`
  - per provider, host, or host-pair when relevant

For hub-side LRO workers, most of this can be computed from
`long_running_operations`.

For host-local execution, the first iteration should report:

- configured host-local limit
- in-flight slot count
- queued waiter count
- per-project lock count

This requires a project-host API extension, likely via:

- `src/packages/project-host/hub/system.ts`

The hub status API can fan out to active hosts and fold those results into the
global response.

## 4. Add Admin-Only Mutation API

After read-only status is in place, add:

- `system.setParallelOpsLimit(...)`
- `system.clearParallelOpsLimit(...)`

Suggested request shape:

- `worker_kind`
- `scope_type`
- `scope_id`
- `limit_value`
- `note`

Rules:

- admin-only
- validate against registry min/max
- persist in `lro_worker_limits`
- do not kill running work
- changes apply only to future claims or future host-local slot acquisition

## 5. Refresh Limits Dynamically in Workers

Hub workers must stop using immutable module-level constants for operational
limits.

Instead:

- keep immutable defaults in the worker registry
- add a shared `getEffectiveParallelOpsConfig(worker_kind)` helper
- poll or subscribe to config refresh every few seconds
- use the effective limit on each claim tick

Suggested shared helpers:

- `src/packages/server/lro/worker-config.ts`
- `src/packages/server/lro/worker-status.ts`

For the first pass, simple periodic refresh is enough.

Change behavior from:

- `const MAX_PARALLEL = 1`

to:

- `let effectiveLimit = defaults.globalLimit`
- refresh on timer
- read `effectiveLimit` inside each tick

Lowering the limit should:

- stop new claims once `inFlight >= effectiveLimit`
- allow already running operations to finish

## 6. Make Backup Admission Host-Aware

This is the most important architectural fix after observability.

Current state:

- hub backup worker uses a global cap
- host-side file-server uses a per-host cap
- the hub does not know which hosts are already saturated when it claims work

That means fresh backup LROs can still pile onto one host while other hosts are
idle.

Target model:

- `global_backup_limit`
  - safety cap for the whole hub cluster
- `per_project_host_backup_limit`
  - fairness and resource protection at the host level

Implementation direction:

- add a host-aware claim path for `project-backup`
- at claim time, join running/queued backup ops to `projects.host_id`
- only claim work for hosts whose active count is below the effective host cap

This logic must be DB-backed. It cannot be process-local, because multiple
`conat-api` processes may run simultaneously.

Likely implementation options:

1. extend `claimLroOps(...)` with a specialized policy hook
2. add `claimBackupLroOps(...)` beside the generic claim function

I would prefer a specialized helper first, because move/backup policies are not
generic enough to justify over-generalizing the base function too early.

## 7. Make Move Admission Smarter Than a Global Scalar

`project-move` should not stay pinned to `1`, but it also should not simply
become `10` globally.

Moves contend on:

- source host I/O
- destination host I/O
- backup bandwidth
- restore bandwidth

Target model:

- configurable global move cap
- configurable per-source-host move cap
- configurable per-destination-host move cap
- optional rule forbidding two moves that involve the same host at once

The first safe improvement is:

- global cap > 1
- per-source-host cap = 1
- per-destination-host cap = 1

This gives real parallelism across many hosts without letting one host get
thrashed by overlapping moves.

This likely needs a dedicated claim helper:

- `claimMoveLroOps(...)`

## 8. Expose Worker Fullness, Not Just Limits

The key operational question is not just "what is the limit", but "how close
to full are we right now?"

Status should include:

- `in_flight / effective_limit`
- `queued_count`
- `oldest_queued_ms`
- `stale_running_count`
- `lease_reclaimable_count`
- `blocked_by_scope`
  - e.g. host-specific saturation for backups or moves

Example:

- `project-backup`
  - global: `7/40`
  - host `host-a`: `10/10`
  - host `host-b`: `1/10`
  - queued blocked by host saturation: `12`

That is the level of visibility needed for operations.

## 9. Preserve Backward Compatibility During Rollout

For the initial rollout:

- if there is no DB override, keep current default behavior
- existing env vars still seed defaults where relevant
- mark env vars as legacy operational defaults, not the runtime control plane

This allows incremental migration:

- first add status
- then add mutable hub-side limits
- then add smarter claim policies
- then add host-local dynamic controls

## Phased Implementation Plan

## Phase 0: Inventory and Documentation

Goal: create a hardcoded inventory of relevant workers and current defaults.

Deliverables:

- `worker-registry.ts`
- unit tests for registry completeness
- this implementation doc

Acceptance:

- one place to list current operational worker kinds and defaults

## Phase 1: Read-Only Status API

Goal: expose current limits and fullness without changing runtime behavior.

Deliverables:

- `system.getParallelOpsStatus()`
- DB aggregations over `long_running_operations`
- status fanout for project-host backup slots

Acceptance:

- admin can query one API and see all worker kinds, limits, and fullness

## Phase 2: Dynamic Hub-Side Limits

Goal: allow live runtime changes for hub workers.

Deliverables:

- `lro_worker_limits` table
- `system.setParallelOpsLimit(...)`
- `system.clearParallelOpsLimit(...)`
- periodic config refresh in hub workers

Initial worker scope:

- `project-move`
- `project-backup`
- `project-restore`
- `copy-path-between-projects`
- `project-hard-delete`
- host ops
- cloud VM work queue

Acceptance:

- changing `project-move` or hub-side backup limit takes effect without restart

## Phase 3: Host-Aware Backup Admission

Goal: replace purely global backup admission with global + per-host policy.

Deliverables:

- host-aware backup claim helper
- per-host backup limit config
- status showing blocked-by-host saturation

Acceptance:

- one busy project host cannot consume all backup admission slots

## Phase 4: Host-Local Dynamic Backup Limits

Goal: make project-host backup slot caps observable and adjustable live.

Deliverables:

- host-side status API
- host-side runtime config refresh or control push
- hub fanout aggregation

Acceptance:

- admin can see and adjust per-project-host backup slots without restarting the
  host

## Phase 5: Move Topology Policy

Goal: replace global move scalar with topology-aware admission.

Deliverables:

- `claimMoveLroOps(...)`
- global + per-source-host + per-destination-host limits
- move worker status breakdown by host

Acceptance:

- many independent host pairs can move in parallel
- one hot host cannot be involved in multiple conflicting moves

## Phase 6: Use the New Status APIs to Burn Down Real Operational Bugs

Goal: use the new visibility and control APIs to detect and fix as many real
parallel-ops bugs as possible without losing focus on the main architecture
plan.

This phase is intentionally bug-hunt oriented. Once the status APIs exist, they
should immediately start surfacing real broken states, wedged workers, and bad
limits. We should treat that as a core deliverable of this work.

Priority list:

1. Make backup ops fail promptly when their target host is gone, in `error`,
   or otherwise unreachable, instead of continuing to heartbeat forever and
   consuming backup capacity.
2. Detect and clean up duplicate active backup ops for the same project when
   they should have been deduped or canceled.
3. Detect workers that are still heartbeating broken work even though the
   underlying host/project state has already become terminal.
4. Detect queue starvation caused by one class of stuck op occupying too much
   shared capacity.
5. Use the status API to identify limits that are obviously too low or too
   high in practice, then feed those findings back into phases 2-5.

Acceptance:

- the status APIs are actively used to find and fix real production-facing
  Launchpad bugs
- at least the known wedged-backup case is fixed
- the system is better at failing broken work fast instead of silently burning
  capacity

## Testing and Validation

### Unit / Integration

- worker registry tests
- config read/write tests
- status aggregation tests
- claim helper tests for backup/move topology rules
- auth tests for admin-only mutation API

### Live Validation

- local dev hub status call returns meaningful counts
- live change to `project-move` limit affects claim behavior without restart
- live change to hub backup limit affects claim behavior without restart
- per-host backup cap demonstrably prevents one host from monopolizing claims

### Failure / Recovery

- lowering a limit while workers are busy does not kill running work
- restart preserves overrides
- stale worker heartbeats do not permanently consume capacity

## Open Questions

1. Should operational overrides live only in the new limits table, or also be
   mirrored into `server_settings` for admin UI discoverability?
   - Recommendation: only the new table.
   - Reason: `server_settings` is already overloaded.
   - Follow-up: add a dedicated UI on the frontend `/hosts` page for viewing
     and adjusting operational limits and status.
2. Do we want per-account or per-organization fairness later for copy/move?
   - Recommendation: yes.
   - Scope: add per-account fairness after the host-topology protections land.
3. Should host-local dynamic config use polling, changefeed, or explicit push
   from the hub?
   - Recommendation: explicit push is the preferred model if the existing
     persistent hub <-> host Conat connection makes it straightforward.
   - Fallback: polling is acceptable as a first operational implementation.
4. Do we want automatic alerts when queued age exceeds thresholds for key
   worker kinds?
   - Recommendation: yes.

## Benchmarking Requirements

Do not choose backup and restore limits by intuition alone.

We need repeatable benchmarks for:

- project backup throughput with `1`, `2`, `4`, `8`, and `10` concurrent
  backups on one project host
- project restore throughput across the same concurrency values
- file copy and project copy flows with and without warm local metadata/cache
- host-local CPU, memory, disk read, disk write, and network usage during
  those runs

Important concern:

- restore from R2 via `rustic` may be brutally slow when local cache or
  metadata is missing, and that can make a concurrency policy look worse than
  it really is

So benchmarks must separate:

- metadata/cache reconstruction cost
- actual content transfer cost
- hashing/compression CPU cost
- local disk bandwidth cost

This project should therefore produce:

- limit/status APIs
- topology-aware admission policies
- a small benchmark harness for backup/restore/copy performance

We should also expect that tuning `rustic` parameters such as compression and
related settings may materially change the best operational limits.

## Recommendation

Implement this in order:

1. registry
2. read-only status API
3. dynamic hub-side limits
4. host-aware backup admission
5. host-local backup runtime controls
6. move topology-aware limits
7. use the status APIs to burn down real operational bugs

That ordering gives operational visibility early, fixes the worst global caps
next, and avoids trying to redesign every worker at once.
