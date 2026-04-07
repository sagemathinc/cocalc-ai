# Projects Live Projection Audit

Date: 2026-04-06

Purpose: identify which fields from the legacy browser `projects` realtime
table are actually used in the frontend, which ones only matter on detailed
project/settings views, and which ones appear to be dead legacy payload.

This audit is the next Phase 3 step after removing the collaborator tracker
path in `database/user-query: drop collaborator tracker changefeeds`.

## Context

The remaining browser-critical tracker path is the shared
`pg_changefeed: "projects"` branch in
[methods-impl.ts](/home/wstein/build/cocalc-lite4/src/packages/database/user-query/methods-impl.ts).
It is still referenced by:

- [projects.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/projects.ts)
- [mentions.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/mentions.ts)
- [project-log.ts](/home/wstein/build/cocalc-lite4/src/packages/util/db-schema/project-log.ts)

The browser no longer depends directly on raw base-table SyncTable changefeeds
for the project list itself, but the logical `projects` payload is still much
larger than what the frontend appears to need in live form.

## Evidence

Primary frontend `project_map` entry points:

- [projects/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/store.ts)
- [projects/table.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/table.ts)
- [projects-page.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-page.tsx)
- [conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)

Quick field scan across `src/packages/frontend` found the heaviest `project_map`
consumers to be:

- `host_id`
- `title`
- `state`
- `last_active`
- `last_edited`
- `users`
- `owning_bay_id`

There is also a smaller second tier:

- `settings`
- `env`
- `region`
- `course`
- `run_quota`
- `avatar_image_tiny`
- `color`
- `name`
- `action_request`
- `created`
- `launcher`
- `snapshots`
- `backups`
- `rootfs_image`
- `rootfs_image_id`

## Classification

### Keep In The Live Browser Project Projection

These fields have clear broad `project_map` consumers on project list pages,
project routing, start-state UI, or collaborator/project access UI.

| Field           | Why keep it live now                                 | Example consumers                                                                                                                                                                                                                           |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`    | identity key everywhere                              | [projects/table.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/table.ts)                                                                                                                                                |
| `title`         | project list, drawer, nav, selectors                 | [projects/project-title.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-title.tsx), [projects-table.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-table.tsx)                     |
| `description`   | project list rows and settings summary               | [project-row.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-row.tsx), [project/settings/body.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/body.tsx)                             |
| `users`         | collaborator avatars, permissions, mentionable users | [projects/project-users.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-users.tsx), [mentionable-users.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/editors/markdown-input/mentionable-users.tsx) |
| `deleted`       | project visibility/sign-in selection                 | [app/sign-in-action.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/app/sign-in-action.ts)                                                                                                                                        |
| `host_id`       | routing, host info, start controls                   | [conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts), [project/start-button.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/start-button.tsx)                                        |
| `owning_bay_id` | control-plane routing                                | [conat/client.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/conat/client.ts)                                                                                                                                                    |
| `state`         | project list state, start button, warnings           | [projects/util.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/util.tsx), [project/start-button.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/start-button.tsx)                                    |
| `last_edited`   | list sorting and display                             | [projects/util.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/util.tsx), [project-row.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-row.tsx)                                             |
| `last_active`   | collaborator activity sort and visible-project sort  | [projects/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/store.ts), [projects/util.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/util.tsx)                                                  |

### Likely Move To On-Demand Project Detail

These fields have real consumers, but the observed usage is concentrated in
project settings, project detail, or narrow flows rather than the global
projects list/bootstrap path.

| Field             | Why it should move out of the live list payload                                                                              | Example consumers                                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings`        | settings/quotas helpers, not list-critical                                                                                   | [projects/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/store.ts)                                                                                                                                                               |
| `run_quota`       | settings and quota warnings                                                                                                  | [run-quota/hooks.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/run-quota/hooks.tsx), [disk-space.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/warnings/disk-space.tsx)                                 |
| `course`          | rarely changes; mostly course/payment views                                                                                  | [projects/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/store.ts), [student-pay/index.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/purchases/student-pay/index.tsx)                                               |
| `created`         | detail rows and banners, not routing-critical                                                                                | [project-row-expanded-content.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-row-expanded-content.tsx), [project-banner.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/project-banner.tsx)                |
| `env`             | project settings / course inheritance only                                                                                   | [project/settings/environment.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/environment.tsx), [course/student-projects/actions.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/course/student-projects/actions.ts) |
| `region`          | move-project / action-menu only                                                                                              | [projects-actions-menu.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-actions-menu.tsx), [move-project.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/move-project.tsx)                         |
| `launcher`        | launcher settings only                                                                                                       | [launcher-defaults.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/launcher-defaults.tsx)                                                                                                                                      |
| `snapshots`       | snapshot schedule editors and old counts                                                                                     | [edit-schedule.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/snapshots/edit-schedule.tsx), [project_actions.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/project_actions.ts)                                             |
| `backups`         | backup schedule editors and old counts                                                                                       | [edit-schedule.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/backups/edit-schedule.tsx), [project_actions.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/project_actions.ts)                                               |
| `rootfs_image`    | rootfs settings/course setup only                                                                                            | [root-filesystem-image.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/root-filesystem-image.tsx), [course/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/course/store.ts)                                    |
| `rootfs_image_id` | rootfs settings/course setup only                                                                                            | [root-filesystem-image.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/settings/root-filesystem-image.tsx), [course/store.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/course/store.ts)                                    |
| `status`          | project-specific warnings/detail; this should likely come from project-local status state instead of the global projects map | [oom.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/warnings/oom.tsx), [disk-space.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/warnings/disk-space.tsx)                                                         |
| `action_request`  | only used in legacy start-button/start-warning flow                                                                          | [project/start-button.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/start-button.tsx), [project-start-warning.ts](/home/wstein/build/cocalc-lite4/src/packages/frontend/project/project-start-warning.ts)                             |

### Dead Or Legacy From The Browser-Realtime Perspective

These fields had no meaningful `project_map` consumers in the audit, or they
look superseded by newer systems.

| Field                     | Why it looks removable from the live browser payload      |
| ------------------------- | --------------------------------------------------------- |
| `invite`                  | old invite path; collaborator invites have been rewritten |
| `invite_requests`         | old invite/request path                                   |
| `provisioned`             | no frontend `project_map` consumer found                  |
| `provisioned_checked_at`  | no frontend `project_map` consumer found                  |
| `manage_users_owner_only` | no frontend `project_map` consumer found                  |
| `ephemeral`               | no frontend `project_map` consumer found                  |
| `pay_as_you_go_quotas`    | no frontend `project_map` consumer found                  |

## Special Cases

### `avatar_image_tiny`

This field still has live consumers in the project list/nav:

- [projects-table.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-table.tsx)
- [projects-nav.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-nav.tsx)
- [project-avatar.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-avatar.tsx)

However, it is exactly the wrong kind of field for a browser-wide control-plane
projection because it is an inline image payload. The right medium-term move is
to remove it from the database schema entirely and replace it with the newer
project-theming/blob-reference approach.

Until that migration lands, `avatar_image_tiny` remains a blocker to shrinking
the live payload as aggressively as we should.

### `color`

`color` is still used in several project list and settings surfaces:

- [project-row.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-row.tsx)
- [project-row-expanded-content.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/project-row-expanded-content.tsx)
- [projects-nav.tsx](/home/wstein/build/cocalc-lite4/src/packages/frontend/projects/projects-nav.tsx)

If the newer project-theming story fully replaces this, it should be audited
alongside `avatar_image_tiny`.

### `secret_token`

There were no meaningful frontend `project_map` consumers in the audit, but the
field is still used on the backend. It should be removed from the global
browser `projects` payload, not deleted blindly from the backend schema.

## Recommended Next Steps

1. Shrink the logical browser `projects` payload first.
   - remove obviously dead legacy fields from `projects.user_query.get.fields`
   - keep the current browser behavior unchanged for the live control-plane
     fields listed above

2. Move detail-only fields behind explicit project detail/settings fetches.
   - `settings`, `run_quota`, `env`, `launcher`, `snapshots`, `backups`,
     `rootfs_image`, `rootfs_image_id`, `status`, `course`

3. Migrate project theming/avatar off inline database fields.
   - remove `avatar_image_tiny` from schema after replacing its consumers
   - then re-audit `color`

4. Only then redesign the remaining `pg_changefeed: "projects"` path.
   - once the live payload is much smaller, the remaining tracker removal
     becomes easier to reason about
   - in particular, live visibility changes can come from
     `account_project_index`, while heavy project detail can move out of the
     global control-plane stream

## Practical Conclusion

The next Phase 3 step should not be “replace the projects tracker while keeping
the old oversized payload exactly as-is.”

It should be:

- define a smaller live project projection
- move detail/settings fields out of the global `projects` map
- then remove the remaining tracker path for that smaller live projection
