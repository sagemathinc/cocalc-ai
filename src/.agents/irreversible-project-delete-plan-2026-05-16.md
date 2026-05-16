# Irreversible Project Delete Plan

Date: 2026-05-16

## Problem

Project delete currently behaves like an easily reversible visibility state:
`projects.deleted=true` hides the project and can be toggled back with
`deleted=false`. That is inconsistent with enforcing a maximum number of
not-deleted projects, because a user can cycle an unbounded number of projects
into "deleted" while the data and metadata remain stored and restorable.

The current model also creates trust and policy problems:

- A collaborator can potentially delete a project they do not own.
- Instructors need student projects to remain controlled by the instructor, not
  irrevocably destroyable by students.
- Project deletion sounds serious in the UI, but the current implementation is
  only a reversible flag.
- Existing hard delete exists, but normal frontend deletion does not use it.

## Current Code Status

Soft delete path:

- `src/packages/frontend/projects/actions.ts`
  - `delete_project` and `toggle_delete_project` call
    `hub.projects.setProjectDeleted`.
- `src/packages/frontend/project/settings/hide-delete-box.tsx`
  - UI describes delete as undoable for a few days.
- `src/packages/frontend/projects/projects-actions-menu.tsx`
  - Project-list row action calls `toggle_delete_project`.
- `src/packages/frontend/projects/projects-operations.tsx`
  - Bulk delete/undelete calls `toggle_delete_project`.
- `src/packages/server/projects/delete.ts`
  - Stops the project best-effort.
  - Sets `projects.deleted`.
  - Emits `project.deleted` / `project.summary_changed`.
  - Releases/restores backup repo assignment.
- `src/packages/server/membership/project-usage.ts`
  - Project count excludes `p.deleted IS NOT NULL`, so soft-deleted projects do
    not count toward project limits.

Hard delete foundation:

- `src/packages/conat/hub/api/projects.ts`
  - Defines `hardDeleteProject`.
- `src/packages/server/conat/api/projects.ts`
  - Requires dangerous/fresh auth.
  - Checks hard-delete permission.
  - Creates a `project-hard-delete` LRO.
- `src/packages/server/projects/hard-delete.ts`
  - Stops project on host best-effort.
  - Deletes project data on host best-effort.
  - Purges or schedules backup snapshot removal.
  - Inserts audit metadata into `deleted_projects`.
  - Deletes the project row and some project-scoped metadata.
- `src/packages/server/projects/hard-delete-worker.ts`
  - Processes `project-hard-delete` LROs.
  - Also processes due backup purge jobs.
- `src/packages/server/lro/worker-registry.ts`
  - Registers `project-hard-delete` as a global worker, currently with default
    effective limit 1.
- `src/packages/cli/src/bin/commands/project/basic.ts`
  - Supports `cocalc project delete --hard`.
  - Requires typing the `project_id` unless `--yes`.

## Policy Decisions

### Delete Is Owner-Only

Only the project owner may delete a project.

Admins can perform deletion only through explicit admin/support tooling, not the
normal user-facing collaborator path.

Rationale:

- Collaborators can remove themselves if they no longer want access.
- Collaborators should not be able to irrevocably destroy shared work.
- Instructors must be able to preserve student project evidence.
- Owners are the only normal users with legitimate authority to destroy the
  entire project.

### Delete Is Immediately Irreversible

Once delete is accepted:

- The project is no longer user-restorable.
- The project is no longer openable/startable.
- The project no longer appears as a normal deleted project that can be toggled
  back.
- Any recovery is support/admin-only from low-level infrastructure, not a user
  product feature.

Actual cleanup may remain asynchronous, but user-visible reversibility ends
immediately.

### Rustic Backup Purge Is Delayed

Rustic snapshot deletion and underlying blob cleanup cannot be treated as
instant storage removal while lock-free writes may still be happening.

Policy:

- Delete snapshots from Rustic metadata as part of the hard-delete workflow or
  scheduled shortly after.
- Do not rely on immediate blob purge for quota/security semantics.
- Deleted backup blob cost is acceptable because storage is cheap and deduped.
- Rate limits still protect against unbounded metadata/project churn.

### Delete Rate Limits Are Required

A single account must not be able to swamp the delete worker or force unbounded
database/host/backup cleanup work.

Rate limits should apply before the LRO is created.

Initial limits should be conservative and configurable:

- Per-account queued/running hard deletes.
- Per-account hard deletes per rolling time window.
- Global queued/running hard deletes.
- Optional per-bay and per-host caps, since host cleanup load is local.

The worker global concurrency limit of 1 is safe but not scalable. The scalable
shape is:

- Admission limits prevent abuse at enqueue time.
- Worker parallelism is configurable globally.
- Work is sharded by bay/host where possible.
- Expensive cleanup stages have their own bounded concurrency.

## Target Behavior

### Project Settings Delete

The project settings danger zone should show a single "Delete Project" action
only to the owner.

For non-owners:

- Do not show delete.
- Show collaborator-appropriate actions, such as "Remove myself" where relevant.

Delete flow:

1. User clicks "Delete Project".
2. Fresh auth is required.
3. Modal clearly states:
   - deletion is permanent and cannot be undone;
   - files, collaborators, invites, shares, project-scoped secrets/API keys, and
     project metadata will be removed;
   - backup cleanup is asynchronous;
   - the project cannot be opened or started after deletion begins.
4. User must type the exact project title or project id.
5. User confirms.
6. Frontend calls `hardDeleteProject` with backup purge scheduled according to
   backend policy.
7. UI shows LRO progress.
8. On queued/running success, remove/close the project tab and return to the
   projects list.

### Project List Delete

Single-project row delete should use the same hard-delete modal.

Bulk delete should not hard-delete multiple projects in the same old reversible
bulk flow. Initial implementation should either:

- remove bulk project delete, or
- require an explicit owner-only hard-delete bulk dialog with a count, exact
  typed confirmation, and rate-limit-aware enqueueing.

Recommendation for first implementation: remove/disable bulk hard delete until
single-project delete is polished.

### CLI Delete

Change CLI semantics so normal `cocalc project delete` means irreversible hard
delete, or make `--hard` mandatory but deprecate soft delete explicitly.

Recommended cocalc-ai behavior:

- `cocalc project delete --project <id>` performs irreversible delete.
- It requires project-id typed confirmation unless `--yes`.
- It requires fresh auth or local/dev fresh-auth bypass.
- It prints LRO id and supports `--wait`.
- Remove or hide `project undelete` from normal help.

For compatibility during transition, if soft delete is retained at all, it
should be admin/debug-only and clearly named `project soft-delete`.

## Backend Implementation Plan

### Phase 1: Tighten Authorization

- Change hard-delete permission from owner-or-admin to owner-only for normal API.
- Add a separate admin-only internal API or CLI flag for support/admin deletion.
- Ensure course student projects are owned by the intended instructor/course
  owner account, not by students, for delete authorization purposes.
- Add tests:
  - owner can enqueue hard delete;
  - collaborator cannot;
  - admin cannot use normal user path unless using explicit admin path;
  - deleted/missing project returns stable errors.

### Phase 2: Add Hard-Delete Admission Limits

Implement a small admission function before `createLro`:

- Count queued/running `project-hard-delete` LROs for the account.
- Count recent completed hard deletes for the account over a rolling window.
- Count global queued/running hard deletes.
- Optionally count host-local queued/running deletes once host_id is known.

Suggested initial defaults:

- Per-account queued/running: 2.
- Per-account per hour: 10.
- Global queued/running: configurable, default 100.
- Worker parallelism: configurable, default min(available bays/hosts, 10), not
  hardcoded 1.

Return structured denial codes so frontend/CLI can display clear messages:

- `project_delete_rate_limited_account_inflight`
- `project_delete_rate_limited_account_recent`
- `project_delete_rate_limited_global_inflight`
- `project_delete_not_owner`

### Phase 3: Make Hard Delete Multibay-Correct

Current `hardDeleteProject` API creates a local LRO and calls local hard-delete
code. That is not sufficient for Rocket.

Target:

- Home bay receives user request.
- Resolve `project.owning_bay_id`.
- Authorization and LRO creation happen in the authoritative owning bay, or the
  home bay creates a routed/owned LRO that is executed on the owning bay.
- Host cleanup is routed through the project-host/inter-bay layer.
- Account feed/projection invalidation is published back to all affected home
  bays.

Do not assume the local bay/database owns the project.

### Phase 4: Complete Cleanup Coverage

Audit and expand `purgeProjectRows`.

Known missing or suspicious cleanup targets:

- `account_project_index`
- `account_notification_index` rows scoped to the project
- `project_runtime_slots`
- project-scoped SSH key/authorized-key metadata if separate from project row
- project-scoped API keys/secrets
- project/account feed projection rows
- public sharing/listing rows
- LROs and project move/copy rows
- chat/codex/project automation metadata if project-scoped in Postgres
- backup indexes and restore/move bookkeeping

Use `DELETE ... WHERE project_id=$1` for direct project-scoped tables and
document tables intentionally retained for audit.

Add regression tests that fail when the cleanup list misses core projection and
runtime-slot tables.

### Phase 5: Replace Frontend Soft Delete

- Add a reusable `HardDeleteProjectModal`.
- Integrate with `useFreshAuthAction`.
- Require exact project id or exact title.
- Show LRO progress with existing LRO components.
- Remove "undelete project" UI from project settings and project list.
- Update translations/source strings; generated translation files can be
  handled separately according to the translation workflow.
- Ensure non-owner collaborators do not see delete controls.
- Ensure course UI does not offer student-owned destructive delete paths that
  violate instructor evidence preservation.

### Phase 6: Update CLI

- Make CLI delete call `hardDeleteProject` by default.
- Keep typed project-id confirmation.
- Keep `--wait`.
- Ensure local/dev fresh-auth automation works.
- Remove or clearly hide `project undelete`.
- Add tests for:
  - confirmation text;
  - `--yes`;
  - non-owner denial display;
  - rate-limit denial display;
  - LRO wait success/failure.

### Phase 7: Remove or Quarantine Soft Delete

Options:

1. Remove normal `setProjectDeleted` access entirely.
2. Keep it as admin/debug-only with scary naming.
3. Keep it only for internal tests/migrations.

Recommendation:

- Keep backend function temporarily for migration/test compatibility.
- Remove it from normal Conat project API or require admin/dev-only authority.
- Delete frontend undelete and reversible-delete flows.
- Update old copy: no more "deleted projects can be undeleted after a few days."

### Phase 8: Observability

Emit structured events for:

- hard-delete requested;
- hard-delete admitted/denied with reason;
- hard-delete LRO started/succeeded/failed;
- host data cleanup failed;
- backup snapshot purge scheduled/succeeded/failed;
- DB cleanup table failures.

Add operator CLI/report:

- queued/running hard deletes by account;
- recent hard-delete count by account;
- oldest queued hard delete;
- failed hard deletes;
- pending backup purges.

## Open Questions

- Should normal hard delete type-confirm by project title, project id, or both?
  Recommendation: accept either exact project id or exact current title, but
  prefer project id in CLI.
- Should admins be allowed to delete via the normal UI? Recommendation: no;
  expose explicit admin/support tooling to make this auditable.
- What should the default backup snapshot retention be? Recommendation:
  schedule snapshot deletion with a short backend-controlled delay; do not
  expose a normal-user retention choice.
- Should deleted-but-not-yet-cleaned projects count toward project limits?
  Recommendation: once the project row is removed and hard-delete LRO is
  accepted, it does not count, but admission rate limits prevent churn abuse.
  If cleanup fails before removing the row, it should continue to count.

## Acceptance Criteria

- A collaborator cannot delete a project they do not own.
- A project owner can irreversibly delete a project after fresh auth and typed
  confirmation.
- There is no normal user-facing undelete.
- The deleted project is immediately not openable/startable.
- Project limit cannot be bypassed by cycling projects through reversible
  deletion.
- A single account cannot enqueue unbounded delete work.
- Delete worker throughput is configurable and observable.
- Hard delete works when home bay and owning bay differ.
- Core project-scoped projection/runtime-slot rows are removed.
- Frontend and CLI show clear structured errors for not-owner, fresh-auth, and
  rate-limit denials.
