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

### Account Deletion Transfers Shared Projects

When an account is deleted, projects owned by that account need explicit
ownership-transfer semantics. We must not create indefinitely ownerless projects,
because somebody has to be responsible for storage and quota.

Policy:

- If the deleting account owns a project with no other collaborators, hard-delete
  the project as part of account deletion.
- If the deleting account owns a project with one or more remaining
  collaborators, automatically transfer ownership to a remaining collaborator.
- Choose the new owner as the remaining collaborator with the most unused global
  storage quota.
- If storage/quota data cannot be computed, fall back to a deterministic order:
  oldest collaborator first, then account id.
- If the project exceeds the new owner's quota, still transfer it. The new owner
  is then over quota and can resolve that by deleting the project, upgrading, or
  reducing storage.
- Notify the new owner that ownership and storage responsibility were
  transferred to them because the previous owner account was deleted.

Rationale:

- User A deleting their account should not unexpectedly destroy documents that
  collaborator B helped create in project P.
- Keeping P forever after A is deleted creates an impossible-to-delete and
  impossible-to-bill orphan.
- Blocking inactive-account deletion on user response is not viable because
  account deletion can happen automatically when inactive accounts stop paying.
- Transferring ownership keeps the project available while preserving a single
  responsible storage/quota account.

Implementation requirements:

- Add a backend-only `transferProjectOwnership` operation.
- Update `projects.users` atomically so the old owner is removed and the chosen
  collaborator has `group: "owner"`.
- Update ownership-derived attribution such as `usage_account_id` when it is
  unset or points at the deleted account.
- If `runtime_sponsor_account_id` points at the deleted account, move runtime
  sponsorship to the new owner.
- Emit project outbox/projection invalidations for all affected accounts.
- Write an audit/central-log event and send a notification to the new owner.
- The operation must run on the authoritative owning bay.

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

### Destructive Storage-History Actions Are Owner-Controlled

Project owners need to be able to invite collaborators without trusting them
with irreversible recovery-data destruction. Normal file deletion is part of
collaboration and is recoverable through snapshots/backups, but deleting the
recovery mechanisms themselves is a different trust boundary.

Default policy:

- Collaborators can edit and delete ordinary files.
- Collaborators cannot delete snapshots.
- Collaborators cannot delete backups.
- Collaborators cannot archive the project.
- Collaborators cannot move the project to a different host, because moving
  removes snapshots.
- Project owners and admins can perform these actions.

Add one owner-controlled project setting:

- `allow_collaborator_destructive_storage_actions`
- Default: `false`.
- User-facing wording should be direct, e.g.
  "Allow collaborators to delete snapshots/backups and move or archive this
  project."

This should not be split into several granular permissions initially. The common
trust question is whether collaborators may destroy or invalidate recovery data.

### Manual Snapshots Cannot Crowd Out Rolling Snapshots

Snapshot creation also needs a trust/availability guardrail. Even if a
collaborator is allowed to create manual named snapshots, they must not be able
to fill every snapshot slot and thereby prevent automatic rolling recovery
snapshots from being created.

Policy:

- Let the project snapshot cap be `n`.
- Reserve `k` slots for automatic rolling snapshots.
- Allow at most `n-k` manual/user-created/named snapshots.
- If `n <= k`, manual snapshots are disabled.
- Automatic rolling snapshots may rotate automatic rolling snapshots, but should
  not evict manual named snapshots except through explicit admin repair tooling.
- Manual snapshot creation should fail with a clear structured denial when the
  manual snapshot cap is reached.

User-facing message:

- "Manual snapshot limit reached. Delete a named snapshot or ask the owner to
  increase the snapshot limit."

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

The old filtered-list bulk delete/undelete flow should not be reused for
irreversible delete. It is too implicit: users can change filters/searches and
accidentally act on many projects they did not explicitly select.

Replace it with explicit checkbox selection in the projects table:

- Add a checkbox column on the left.
- Show bulk-action buttons only when at least one project is checked.
- Replace the current `+` drawer affordance with a `Details` button, since it
  opens a drawer rather than expanding the row.
- Selection should be pruned when rows disappear due to filtering or data
  refresh.
- Bulk actions must report per-project failures instead of one vague global
  error.

Initial safe bulk actions:

- Stop selected projects.
- Hide selected projects.
- Unhide selected projects.
- Remove myself from selected projects where the current user is not the owner.

Do not include bulk start or restart initially. They are too entangled with
runtime sponsor slots, automatic-start policy, LRO admission failures, and mixed
project states. The useful and predictable bulk cases are stopping resource use
and cleaning up/hiding projects after being added to many projects.

Bulk destructive cleanup should be exposed as a separate dangerous flow, with a
label such as "Leave or delete selected projects", not just "Delete".

Bulk cleanup semantics should match account-deletion project cleanup, except the
account itself remains:

- If the current user owns a selected project with no other collaborators,
  hard-delete it.
- If the current user owns a selected project with remaining collaborators,
  transfer ownership to a remaining collaborator using the same ownership
  transfer policy as account deletion, then remove the current user from the
  project.
- If the current user does not own a selected project, remove the current user
  as a collaborator.
- If an individual project cannot be processed, continue with the rest and show
  a per-project result.

The confirmation modal should preview counts before confirmation:

- projects that will be permanently deleted;
- projects that will be transferred to another collaborator;
- projects the user will leave;
- projects that will be skipped or cannot be changed.

The transfer case is the surprising one, so the modal should list transferred
projects and explain that storage responsibility moves to another collaborator.
The flow requires fresh auth and typed confirmation. Hard-delete admission rate
limits still apply to projects that are actually deleted.

NOTE: I think this is only implemented in courses, where I think this is a button to delete all the student projects, which instructors use to clean up old courses. It's important, since deleting old data is sometimes needed for legal reasons.

### Destructive Storage-History Controls

The project settings UI should expose an owner-only switch near other project
trust/lifecycle controls:

- Label: "Collaborators may manage storage history"
- Default off.
- Description: "When enabled, collaborators can delete snapshots and backups,
  archive the project, and move it to another host. When disabled, collaborators
  can still edit files, but only owners can remove recovery data or perform
  lifecycle actions that remove snapshots."

When the switch is off, collaborator UI should hide or disable:

- file-manager delete actions when the selected item resolves to a snapshot or
  backup;
- archive project controls;
- move project controls.

The file manager does not necessarily render separate snapshot/backup delete
buttons. It uses the normal delete action, detects that the target is a snapshot
or backup, and routes to a special snapshot/backup delete API. Security must be
enforced in those special APIs. Frontend checks are only for clearer UX.

If denied, the file manager should show a direct message:

- "Only the project owner can delete snapshots/backups unless the owner enables
  collaborator storage-history management."

Backend authorization must enforce the policy even if the frontend is wrong or
stale.

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
- Define account-deletion ownership transfer:
  - hard-delete owned projects with no other collaborators;
  - transfer owned projects with remaining collaborators to the collaborator
    with the most unused global storage quota;
  - notify the new owner;
  - do not block transfer if the project puts the new owner over quota.
- Add backend-only `transferProjectOwnership` with multibay-safe routing and
  projection invalidation.
- Add tests:
  - owner can enqueue hard delete;
  - collaborator cannot;
  - admin cannot use normal user path unless using explicit admin path;
  - account deletion hard-deletes owner-only projects;
  - account deletion transfers shared projects to the collaborator with the most
    unused storage quota;
  - transfer falls back deterministically when quota data is unavailable;
  - transfer updates storage and runtime sponsorship attribution from the deleted
    account to the new owner;
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

### Phase 5: Add Owner-Controlled Storage-History Destruction

- Add `allow_collaborator_destructive_storage_actions` to the project schema and
  projection/read paths needed by frontend settings.
- Add a backend authorization helper, e.g.
  `assertCanPerformDestructiveStorageAction({ project_id, account_id })`.
- Helper behavior:
  - owner: allowed;
  - admin: allowed;
  - collaborator: allowed only when the project setting is true;
  - non-collaborator: denied.
- Apply the helper to:
  - snapshot delete APIs;
  - backup delete APIs;
  - archive project admission;
  - move project admission.
- Add frontend switch in project settings.
- Hide or disable protected controls for collaborators when the switch is off,
  including file-manager delete attempts that resolve to snapshot/backup API
  calls.
- Add manual snapshot reservation:
  - compute total snapshot cap `n`;
  - reserve rolling snapshot slots `k`;
  - enforce manual snapshot count `<= n-k`;
  - return a structured denial when manual snapshot slots are exhausted.
- Add tests for each backend enforcement point.
- Add tests that manual snapshots cannot exhaust slots reserved for automatic
  rolling snapshots.
- Add frontend tests for owner/collaborator visibility where practical.

### Phase 6: Replace Frontend Soft Delete

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

### Phase 7: Update CLI

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

### Phase 8: Remove or Quarantine Soft Delete

USER:  just remove it completely and all code, database fields, etc., cocalc-ai is NOT RELEASED YET, so it's fine to do this.

Options:

1. Remove normal `setProjectDeleted` access entirely.
2. Keep it as admin/debug-only with scary naming.
3. Keep it only for internal tests/migrations.

Recommendation:

- Keep backend function temporarily for migration/test compatibility.
- Remove it from normal Conat project API or require admin/dev-only authority.
- Delete frontend undelete and reversible-delete flows.
- Update old copy: no more "deleted projects can be undeleted after a few days."

### Phase 9: Observability

Emit structured events for:

- hard-delete requested;
- hard-delete admitted/denied with reason;
- hard-delete LRO started/succeeded/failed;
- destructive storage-history action admitted/denied with reason;
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
  prefer project id in CLI.   User: agreed.
- Should admins be allowed to delete via the normal UI? Recommendation: no;
  expose explicit admin/support tooling to make this auditable.   User: I can't think of any reason admin delete would be needed, so we can defer this until later.
- What should the default backup snapshot retention be? Recommendation:
  schedule snapshot deletion with a short backend-controlled delay; do not
  expose a normal-user retention choice.  User: do you mean rustic?  If so -- as short as will work.
- Should deleted-but-not-yet-cleaned projects count toward project limits?
  Recommendation: once the project row is removed and hard-delete LRO is
  accepted, it does not count, but admission rate limits prevent churn abuse.
  If cleanup fails before removing the row, it should continue to count.  User: agreed; it no longer counts.

## Acceptance Criteria

- A collaborator cannot delete a project they do not own.
- A project owner can irreversibly delete a project after fresh auth and typed
  confirmation.
- Deleting an account hard-deletes owner-only projects.
- Deleting an account transfers projects with remaining collaborators to a new
  owner/storage-responsible collaborator.
- There is no normal user-facing undelete.
- Project-list bulk actions use explicit checkbox selection, not filtered-list
  implicit selection.
- Initial bulk actions include stop, hide, unhide, and remove-myself, but not
  start or restart.
- Bulk "leave or delete selected projects" uses the same ownership-transfer and
  hard-delete semantics as account-deletion project cleanup.
- The deleted project is immediately not openable/startable.
- Project limit cannot be bypassed by cycling projects through reversible
  deletion.
- A single account cannot enqueue unbounded delete work.
- Delete worker throughput is configurable and observable.
- Hard delete works when home bay and owning bay differ.
- Collaborator snapshot/backup delete, archive, and move are blocked by default
  unless the owner enables the destructive storage-history setting.
- Manual/named snapshots cannot consume slots reserved for automatic rolling
  snapshots.
- Core project-scoped projection/runtime-slot rows are removed.
- Frontend and CLI show clear structured errors for not-owner, fresh-auth, and
  rate-limit denials.
