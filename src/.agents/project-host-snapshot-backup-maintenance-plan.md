# Project-Host Snapshot And Backup Maintenance Plan

## Problem

Snapshot and backup retention maintenance is currently being driven by the
browser.

That is wrong architecturally, and it is currently broken operationally.

### What happens now

The browser loads a project's configured snapshot/backup schedule and then
actively calls retention RPCs:

- `projects.updateSnapshots`
- `projects.updateBackups`

Those calls happen from project actions in:

- `src/packages/frontend/project_actions.ts`

The relevant browser-owned loops are:

- `initSnapshots`
- `initBackups`
- `pushSnapshotScheduleUpdate`
- `pushBackupScheduleUpdate`
- invalidation subscribers that call those push methods again when
  `snapshots` / `backups` fields are invalidated

On the backend, these RPCs are not passive metadata refresh calls. They run
real retention logic:

- `src/packages/server/conat/api/project-snapshots.ts`
- `src/packages/server/conat/api/project-backups.ts`
- `src/packages/project-host/file-server.ts`
- `src/packages/file-server/btrfs/snapshots.ts`

So merely viewing a project page can trigger:

- rolling snapshot retention
- backup retention
- backup index refresh

and every open browser tab can repeat that work.

### Current failure modes

1. Browser-triggered invalidation loop:
   - browser calls `updateSnapshots` / `updateBackups`
   - backend publishes project detail invalidation
   - browser responds to invalidation by calling the same retention RPC again

2. Excessive maintenance frequency:
   - many project actions instances
   - many tabs
   - repeated schedule reads and retention application

3. Strange backup pruning:
   - `updateBackups` performs real retention via `rustic.update(...)`
   - repeated browser-triggered calls can aggressively prune backups

## Goal

Make snapshot and backup maintenance fully owned by `project-host`.

The browser should:

- read schedules
- edit schedules
- never perform retention maintenance as a side effect of rendering a page

The hub should:

- store canonical schedule config in Postgres
- expose reads/writes of that config

The project-host should:

- periodically apply snapshot retention
- periodically apply backup retention
- do so only for projects it hosts
- do so only for recently active projects

## Scope

This plan is intentionally narrow:

- remove browser-driven retention
- add project-host maintenance loop
- reuse existing retention implementation where possible
- restrict work to active projects using `projects.last_edited`

Not in scope for this change:

- redesigning the schedule UI
- changing the schedule schema
- adding new schedule types
- long-term historical metrics/observability work
- perfecting dormant-project policies beyond the simple `last_edited` cutoff

## Design

### 1. Browser becomes schedule-only

Keep these browser flows:

- read snapshot schedule
- read backup schedule
- save schedule edits to Postgres

Remove browser-owned retention execution:

- stop calling `projects.updateSnapshots` from the browser's periodic loop
- stop calling `projects.updateBackups` from the browser's periodic loop
- stop reacting to `snapshots` / `backups` invalidation by re-running
  retention

Concretely in:

- `src/packages/frontend/project_actions.ts`

Remove or disable:

- `syncSnapshotSchedule`
- `syncBackupSchedule`
- `pushSnapshotScheduleUpdate`
- `pushBackupScheduleUpdate`
- `initSnapshots`
- `initBackups`
- the `subscribeProjectDetailInvalidation(...)` callback branches for
  `snapshots` and `backups`

The schedule edit modals can stay as-is, because they update the canonical
project row through normal project settings writes:

- `src/packages/frontend/project/snapshots/edit-schedule.tsx`
- `src/packages/frontend/project/backups/edit-schedule.tsx`

Those are configuration writes, not retention execution.

### 2. Project-host owns retention maintenance

Add a new maintenance loop under `project-host`, likely near the existing host
maintenance responsibilities in:

- `src/packages/project-host/main.ts`

Recommended new module:

- `src/packages/project-host/snapshot-backup-maintenance.ts`

This loop should:

1. discover which projects are hosted here
2. fetch their configured snapshot/backup schedule from the hub/master
3. skip dormant projects based on `projects.last_edited`
4. apply snapshot retention locally
5. apply backup retention locally
6. avoid overlapping work for the same project

### 3. Restrict maintenance to active projects

This is important because a host may have thousands of dormant projects.

Policy:

- only run snapshot/backup maintenance for projects where
  `projects.last_edited >= now() - X days`

Default:

- `X = 2`

Config knob:

- `COCALC_PROJECT_HOST_MAINTENANCE_ACTIVE_DAYS`

Rationale:

- bounds work to projects that are plausibly in active use
- uses an existing canonical signal (`last_edited`)
- avoids sweeping very large dormant fleets

This policy should be applied by the hub-side schedule listing query, so the
project-host only receives projects it should consider.

## API Shape

### Recommended approach

Add a host-facing bulk schedule API so the host can fetch all relevant
maintenance schedules in one request.

Add to:

- `src/packages/conat/project-host/api.ts`

New status/control service method on the hub side, something like:

- `listHostProjectMaintenanceSchedules`

Suggested request:

```ts
{
  host_id: string;
  active_days?: number;
  limit?: number;
  cursor?: {
    last_edited?: string;
    project_id?: string;
  };
}
```

Suggested response:

```ts
{
  rows: Array<{
    project_id: string;
    last_edited: string | null;
    snapshots: ProjectSnapshotSchedule | null;
    backups: ProjectBackupSchedule | null;
  }>;
  next_cursor?: {
    last_edited: string;
    project_id: string;
  };
}
```

This should be implemented in the hub/master service layer, likely in:

- `src/packages/server/conat/host-status.ts`
  or a nearby host-facing service module if that file is getting too broad

The SQL should:

- select projects assigned to `host_id`
- filter on recent `last_edited`
- optionally exclude deleted projects
- order deterministically

### Why bulk API instead of per-project RPC

Bulk API is better because:

- one hub round-trip per sweep instead of N
- easier to apply the active-project cutoff centrally
- easier to paginate if a host still has many active projects
- easier to instrument and reason about operationally

## Project-Host Loop Behavior

### Sweep cadence

Add a periodic sweep with default:

- every `15 minutes`

Config knob:

- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS`

Rationale:

- shortest snapshot interval is 15 minutes
- backups do not need tighter cadence
- one combined sweep keeps the design simple

### Per-project processing

For each eligible hosted project:

1. If snapshot schedule exists and is not disabled:
   - call existing local retention code:
     - `vol.snapshots.update(counts, { ... })`

2. If backup schedule exists and is not disabled:
   - call existing local retention code:
     - `vol.rustic.update(counts, { limit, index: { project_id } })`
   - refresh backup index cache as today

3. If either schedule is disabled:
   - skip that maintenance type entirely

### Concurrency

Do not sweep all projects fully serially, but also do not allow unbounded
parallelism.

Recommended:

- bounded parallelism, default `4`

Config knob:

- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_PARALLELISM`

Also maintain a per-project in-memory lock so the same project cannot be
processed twice concurrently if:

- a previous sweep is still running
- future manual hooks are added

### Error handling

Per-project failures should:

- be logged
- not abort the whole sweep

Failures should be isolated so one broken project does not block maintenance
for others.

## Existing Code To Reuse

### Snapshot retention logic

Keep using:

- `src/packages/file-server/btrfs/snapshots.ts`
  - `updateRollingSnapshots(...)`
- `src/packages/file-server/btrfs/subvolume-snapshots.ts`

### Backup retention logic

Keep using:

- `src/packages/file-server/btrfs/snapshots.ts`
  - same `updateRollingSnapshots(...)`
- `src/packages/file-server/btrfs/subvolume-rustic.ts`
  - `rustic.update(...)`
- `src/packages/project-host/file-server.ts`
  - current `updateBackups(...)` logic, including backup index sync

The point is not to rewrite retention rules, only to move ownership of running
them from browser to project-host.

## What To Do With Existing RPC Endpoints

### Short term

Keep for compatibility, but remove all normal browser use:

- `projects.updateSnapshots`
- `projects.updateBackups`

That minimizes surface-area breakage during the migration.

**USER: ACTUALLY JUST DELETE THOSE ASAP.**  We will finish this entire project today.

### Medium term

Either:

1. remove them entirely, or
2. repurpose them as explicit manual/admin “run maintenance now” actions

The important rule is:

- they must not be part of normal project page rendering or background browser
  loops

## Suggested Implementation Steps

### Step 1. Stop browser-owned retention

Change:

- `src/packages/frontend/project_actions.ts`

Do:

- remove periodic retention loops
- remove invalidation-triggered retention calls

Keep:

- schedule reads for UI
- schedule write/save flows

Expected outcome:

- log flood stops immediately
- project page no longer triggers maintenance side effects

### Step 2. Add hub bulk schedule listing for hosts

Change:

- `src/packages/conat/project-host/api.ts`
- `src/packages/server/conat/host-status.ts`
  or a nearby host-facing service file

Do:

- add bulk list of active hosted project maintenance schedules
- enforce `host_id`
- filter by recent `last_edited`

### Step 3. Add project-host maintenance loop

Add:

- `src/packages/project-host/snapshot-backup-maintenance.ts`

Wire from:

- `src/packages/project-host/main.ts`

Do:

- periodic sweep
- bounded concurrency
- per-project dedupe lock
- snapshot and backup maintenance application

### Step 4. Add focused tests

Recommended tests:

- frontend:
  - verify project actions no longer call retention RPCs on invalidation

- server:
  - host schedule listing filters by `host_id`
  - host schedule listing filters by `last_edited`

- project-host:
  - sweep skips dormant projects
  - sweep skips disabled schedules
  - sweep invokes snapshot maintenance for eligible projects
  - sweep invokes backup maintenance for eligible projects
  - per-project lock prevents overlap

## Proposed Defaults

- `COCALC_PROJECT_HOST_MAINTENANCE_ACTIVE_DAYS=2`
- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_SWEEP_MS=900000`
- `COCALC_PROJECT_HOST_SNAPSHOT_BACKUP_PARALLELISM=4`

## Acceptance Criteria

This work is correct when all of the following are true:

1. Opening a project page no longer triggers snapshot/backup retention RPCs.
2. Project detail invalidations for `snapshots` / `backups` do not create a
   self-triggering loop.
3. Snapshot/backup retention still happens on actively edited hosted projects
   without browser involvement.
4. Dormant hosted projects older than the active cutoff are skipped.
5. Backups are no longer pruned merely because multiple browsers/tabs are open.
6. One project's maintenance failure does not block maintenance for other
   projects on the same host.

## Recommended Future Follow-Ups

After this lands:

1. Add host metrics / status visibility for maintenance sweeps:
   - last sweep time
   - projects considered
   - projects skipped as dormant
   - errors

2. Consider a manual admin/CLI “run maintenance now” command for one project.

3. Later, consider a more nuanced dormant policy than `last_edited`, if
   needed. For now, `last_edited` is the right simple canonical signal.