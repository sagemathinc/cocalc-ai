# Document Activity / File-Use Project-Host Migration Plan

Status: proposed implementation plan as of 2026-04-12.

This document covers the next redesign step after the earlier `file_use`
removal: moving recent document activity and file-use access history off the
bays/Postgres hot path and onto the project host.

The goal is not just multibay correctness. The goal is to make this feature
cheap enough that scaling to very large numbers of active users becomes a
capacity and cost problem, not a control-plane bottleneck.

## Goals

- remove central Postgres writes from normal file activity
- remove multibay complexity from recent document activity
- keep project-local file activity on the project host
- preserve coarse project/account projections on the bays
- keep course/file-use export working via on-demand fanout
- degrade gracefully when some project hosts are off or deprovisioned

## Explicit Decisions

- access-event retention TTL: 90 days
- global recent-document activity is best effort
- course/file-use export is best effort and may skip unavailable hosts
- browser fanout should silently skip projects whose hosts are unavailable

## Current State

Hot-path activity still lands centrally.

- [activity.ts](/home/user/cocalc-ai/src/packages/database/postgres/stats/activity.ts)
  updates account activity, project `last_edited` / `last_active`, and central
  file access logging.
- [file-access.ts](/home/user/cocalc-ai/src/packages/database/postgres/paths/file-access.ts)
  writes the `file_access_log` table.
- [projects.ts](/home/user/cocalc-ai/src/packages/server/conat/api/projects.ts)
  implements `listRecentDocumentActivity` as central SQL over
  `file_access_log`.
- [file-use-times.ts](/home/user/cocalc-ai/src/packages/server/conat/api/file-use-times.ts)
  reads access times from `file_access_log` and edit times from sync patch
  streams.
- [panel.tsx](/home/user/cocalc-ai/src/packages/frontend/file-use/panel.tsx)
  treats recent activity as a hub API.
- [client.ts](/home/user/cocalc-ai/src/packages/frontend/frame-editors/generic/client.ts)
  is one of the main write entry points for file activity.

This design has three scaling problems:

1. every active edit/open path can create central writes
2. global recent-activity UI depends on central per-file persistence
3. multibay routing is forced into a feature that should be project-local

## Target Architecture

### Ownership Split

- project host owns file access activity and recent-file summaries
- bay owns project/account coarse projections only
- browser reads project-local activity directly from the routed project
  connection
- global activity is assembled in the browser from recent projects plus direct
  per-project reads

### Data Stored On The Project Host

Use two project-local stores:

1. `recent-document-activity`
- purpose: fast UI reads for recent-file lists
- shape: keyed by relative path
- value:
  - `path`
  - `last_accessed`
  - `recent_account_ids`
  - optional last action metadata if useful later

2. `file-access-events`
- purpose: access-time history for rare export and file-use inspection
- shape: append-only event stream
- value:
  - `time`
  - `account_id`
  - `path`
  - `action`
- retention: 90 day TTL

Edit times should remain where they already belong: sync patch streams. There
is no reason to duplicate edit history into a second local store.

### Data Kept On The Bay

Keep only coarse summary state:

- `projects.last_edited`
- `projects.last_active`
- `account_project_index.last_activity_at`
- `account_project_index.sort_key`

The bay should not store per-file recent-activity rows on the hot path.

## Conat Surface

Add a direct project service, analogous to `storage-info`.

Suggested files:

- `src/packages/conat/project/document-activity.ts`
- `src/packages/project-host/document-activity-service.ts`

Suggested subject:

- `project.*.document-activity.-`

Suggested methods:

- `markFile({ path, action })`
- `listRecent({ limit?, max_age_s? })`
- `getFileUseTimes({ path, target_account_id?, limit?, access_times?, edit_times? })`

This should be project-scoped, not host-scoped, so it naturally reuses the
existing routed browser-to-project-host path and authorization model.

## Browser Behavior

### File Open / Edit / Touch

Replace central file access logging with direct project-host writes.

Flow:

1. browser/editor calls `projectApi.documentActivity.markFile(...)`
2. project host throttles locally by `(account_id, path, action)`
3. project host updates `recent-document-activity`
4. project host appends to `file-access-events` when the throttled event is new
5. project host continues reporting coarse project touch state back to the
   owning bay

The project host should be authoritative for file activity. The bay should only
see summary effects.

### Global Recent Activity Panel

The browser should assemble the panel itself.

Flow:

1. fetch a recent-project list from the bay
2. take the top `N` projects by `last_activity_at` / `last_edited`
3. call `project.*.document-activity.listRecent(...)` for those projects in
   parallel
4. merge and sort the returned rows in the browser
5. silently skip projects whose hosts are unavailable or deprovisioned

This is intentionally best effort. The panel does not need hard guarantees.

The first implementation should keep this simple and do per-project fanout.
If that is ever measurably too expensive, add a host-batched variant later.

## Course / Export Behavior

This should become on-demand fanout instead of central SQL.

Flow:

1. resolve the relevant project ids for the assignment/handout/export scope
2. call `getFileUseTimes(...)` on those project hosts in parallel
3. for each project:
   - access times come from `file-access-events`
   - edit times come from sync patch streams
4. aggregate the results into the export artifact
5. skip unavailable hosts and report partial results clearly

This is acceptable because course/file-use export is important but rare.

## Migration Sequence

### Phase 1: Add Project-Host Document Activity Service

- add `@cocalc/conat/project/document-activity`
- add `project-host/document-activity-service`
- implement local persistent stores for:
  - recent summary
  - access-event history
- implement local throttling

Acceptance:

- service can record file activity
- service can list recent paths for a single project
- service can return access-time history for a single file

### Phase 2: Cut Single-Project Reads/Writes Over

- switch frontend file touch/write paths from central DB touch/file-access
  logging to the direct project service
- switch single-project file-use inspection paths to the direct project service
- keep existing bay summary projection updates in place

Acceptance:

- opening/editing a file no longer writes `file_access_log`
- single-project file-use views still work
- project `last_edited` and `last_active` still update

### Phase 3: Rebuild Global Recent Activity

- replace hub `listRecentDocumentActivity` usage in the browser
- use recent projects from the bay plus direct per-project reads from hosts
- make host unavailability non-fatal and silent for this panel

Acceptance:

- the recent-activity panel works from bay-0 and bay-1
- unavailable project hosts do not break the panel
- normal usage no longer depends on central per-file SQL

### Phase 4: Move File-Use Export

- replace central `file_access_log` reads in `file-use-times`
- use direct project-host fanout for export
- clearly report partial exports when some hosts are unavailable

Acceptance:

- course export still works
- access times come from project-local data
- edit times still come from patch streams

### Phase 5: Delete Legacy Central Path

- remove central file-access writes from [activity.ts](/home/user/cocalc-ai/src/packages/database/postgres/stats/activity.ts)
- remove [file-access.ts](/home/user/cocalc-ai/src/packages/database/postgres/paths/file-access.ts) from the hot path
- remove or retire hub SQL path in [projects.ts](/home/user/cocalc-ai/src/packages/server/conat/api/projects.ts)
- remove central SQL path in [file-use-times.ts](/home/user/cocalc-ai/src/packages/server/conat/api/file-use-times.ts)
- eventually drop `file_access_log` once no longer needed

Acceptance:

- no normal browser file-activity flow touches central `file_access_log`
- multibay recent activity works without interbay file-access routing
- scale is dominated by project-host capacity, not bay/Postgres churn

## Failure Semantics

This feature should intentionally be best effort in the following cases:

- project host unavailable
- project host deprovisioned
- project moved while the browser is gathering recent activity
- export fanout returns partial results

The browser/UI should degrade quietly for the recent-activity panel. Export
paths should explicitly surface partial-results warnings.

## What Not To Change In This Work

Do not redesign these in the same change set:

- project lifecycle start/stop/restart
- collaborator/auth/account identity
- project/account projections
- billing / quotas / entitlements
- project metadata such as env/rootfs/launcher/course settings

Those are control-plane concerns and should stay bay-owned.

## Success Criteria

This migration is successful when:

- recent document activity works from any bay for any reachable project host
- normal file activity no longer writes central per-file rows
- course/file-use export still works through on-demand host fanout
- unavailable hosts only reduce completeness, not correctness of the rest of
  the system
- scaling this feature mainly means adding project-host capacity, not growing
  bay/Postgres write pressure
