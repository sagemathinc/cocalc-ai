# Dedicated Host Owner Access Control Plan

Status: proposed implementation plan as of 2026-05-11.

This plan defines the first public release model for delegated access to
dedicated hosts.

The core policy is:

- every dedicated host has exactly one billing owner
- all charges for the dedicated host go directly to that owner
- the owner may delegate host use and limited host management to other accounts
- delegated users can consume owner-paid host capacity, so the UI must make the
  trust boundary explicit
- owner-configured per-host spend limits are separate from system and
  membership limits

## Product Model

A dedicated host has three effective access levels.

| Level   | Meaning                                                                 | Billing responsibility               |
| ------- | ----------------------------------------------------------------------- | ------------------------------------ |
| Owner   | The account that created or owns the host.                              | All host charges go to this account. |
| Manager | A trusted delegate who can operate the host and manage the access list. | No host charges go to the manager.   |
| User    | A delegate who can place projects on the host.                          | No host charges go to the user.      |

The owner is implicit. Do not store the owner as a normal ACL row, and do not
allow managers to remove, replace, or demote the owner.

This model intentionally does not introduce groups, organizations, share links,
or email-address invites for the first release. Access is granted to existing
accounts only.

## Concrete User Stories

### Research group

A faculty member creates an expensive GPU host for a research project. The host
charges always go to the faculty member.

The faculty member adds a graduate student as a manager. The graduate student
can:

- start and stop the host
- add undergraduates who may use the host
- remove undergraduates when they leave the project
- promote one trusted undergraduate to manager

Undergraduates can create or move their own projects onto the host, but they
cannot start or stop the host and cannot add other people.

### Small lab with budget guardrails

A lab owner creates a host that costs roughly `$12/hour`. They set an optional
per-host 5-hour spend limit of `$100` and 7-day spend limit of `$500`.

The host can be shared normally, but once the host itself has spent about `$500`
in the rolling 7-day window, or about `$100` in the rolling 5-hour window, the
system stops it and clearly shows:

- the configured host cap
- current 5-hour host spend
- current 7-day host spend
- when the cap was hit
- that the host was stopped by the owner-configured per-host limit
- how the owner can raise or remove the limit

This limit is an owner opt-in safety setting. It is not imposed by membership,
admin policy, or the site-wide billing system.

## Current Starting Point

Current access control is mostly stored in `project_hosts.metadata`.

Observed behavior:

- `metadata.owner` is the effective host owner
- `metadata.collaborators` is a flat list of collaborator account ids
- `metadata.host_collab_control` is a global flag that lets collaborators start
  or stop the host
- placement currently treats owner and collaborator as allowed to place
  projects

Important current files:

- `src/packages/util/db-schema/project-hosts.ts`
- `src/packages/conat/hub/api/hosts.ts`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/project-host/placement.ts`
- `src/packages/server/project-host/spend-maintenance.ts`
- `src/packages/server/project-host/spend-enforcement.ts`
- `src/packages/frontend/hosts/host-list.tsx`
- `src/packages/frontend/hosts/host-drawer.tsx`
- `src/packages/frontend/hosts/pick-host.tsx`

The current model is too coarse because it cannot express:

- can use the host but cannot start it
- can start/stop the host but cannot change billing/destructive settings
- can add/remove other host users
- per-user manager status
- a clear audit trail of delegated authority changes

## Database Design

Add a first-class table for active host access.

Recommended table:

```sql
CREATE TABLE project_host_access (
  host_id UUID NOT NULL REFERENCES project_hosts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'manager')),
  created_by UUID REFERENCES accounts(account_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES accounts(account_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES accounts(account_id),
  PRIMARY KEY (host_id, account_id)
);

CREATE INDEX project_host_access_account_idx
  ON project_host_access(account_id)
  WHERE revoked_at IS NULL;

CREATE INDEX project_host_access_host_idx
  ON project_host_access(host_id)
  WHERE revoked_at IS NULL;
```

Use a single row per `(host_id, account_id)` and set `revoked_at` on removal.
Re-adding an account clears `revoked_at` and updates the role. This preserves a
basic audit trail without needing a separate event table in the first slice.

The owner remains `project_hosts.metadata.owner` for the first release. This is
already the billing authority used by dedicated-host spend maintenance and
purchase-session reconciliation. Moving owner to a top-level column can be a
future cleanup, but it is not necessary for this feature.

### Migration From Metadata Collaborators

There is no public-production dedicated-host compatibility requirement. The
only existing hosts are alpha/dogfooding hosts, and they are one-owner,
site-funded hosts. They must keep working, but we should not preserve a long
legacy collaborator model.

One migration should convert any existing metadata collaborators into table
rows so alpha hosts do not silently lose delegated access if any exists:

- if `metadata.host_collab_control === true`, convert collaborators to
  `manager`
- otherwise convert collaborators to `user`
- ignore collaborator entries equal to the owner
- after migration, new writes should not use `metadata.collaborators` or
  `metadata.host_collab_control`

Post-migration code should use `project_host_access` as the source of truth for
delegated access. Do not add a long-term read fallback to metadata
collaborators.

## Permission Matrix

| Action                                      | Owner | Manager | User | Admin                  |
| :------------------------------------------ | :---- | :------ | :--- | :--------------------- |
| See host in host picker                     | Yes   | Yes     | Yes  | Yes                    |
| Move own project to host                    | Yes   | Yes     | Yes  | Yes                    |
| Create new project on host                  | Yes   | Yes     | Yes  | Yes                    |
| See owner-paid warning                      | Yes   | Yes     | Yes  | Optional               |
| Start host                                  | Yes   | Yes     | No   | Yes                    |
| Stop/restart host                           | Yes   | Yes     | No   | Yes                    |
| See all projects on host                    | Yes   | Yes     | No   | Yes                    |
| Stop/restart projects on host               | Yes   | Yes     | No   | Yes                    |
| Add/remove users                            | Yes   | Yes     | No   | Yes                    |
| Add/remove managers                         | Yes   | Yes     | No   | Yes                    |
| Remove/demote owner                         | No    | No      | No   | No                     |
| Rename host                                 | Yes   | No      | No   | Yes                    |
| Set per-host spend caps                     | Yes   | No      | No   | Yes                    |
| Configure per-project RAM cap               | No    | No      | No   | Yes                    |
| Change machine/provider/funding mode        | Yes   | No      | No   | Yes                    |
| Drain host                                  | Yes   | No      | No   | Yes                    |
| Delete/deprovision host                     | Yes   | No      | No   | Yes                    |
| Run UI software upgrade/maintenance actions | Yes   | No      | No   | Yes                    |
| Direct SSH or secret access to host         | No    | No      | No   | Admin-only break-glass |

Recommended first-release decisions:

- keep rename owner/admin only unless there is a concrete user need
- keep per-host spend cap owner/admin only because it directly changes the
  owner's financial risk
- keep per-project RAM cap admin-only because it overrides normal membership
  RAM limits for all projects placed on the host
- keep drain/delete/deprovision strictly owner/admin
- never expose direct SSH to dedicated-host owners, managers, or users

Managers can intentionally cause spend by starting a host and by letting users
place projects on it. This is the whole point of manager delegation. The UI
must therefore describe manager as a high-trust role. Managers still should not
rename hosts because that is confusing ownership/identity state.

## Billing Invariants

These invariants should be enforced in code and tests:

- `metadata.owner` is the billing account for the host
- adding a manager or user never changes `metadata.owner`
- starting a host as a manager charges the owner
- placing a project as a manager or user consumes owner-paid host capacity
- per-host spend cap enforcement stops the host but does not transfer charges
- purchase sessions and spend-maintenance snapshots are keyed by owner account
- audit records store the actor separately from the charged account

This distinction should be visible in UI copy:

> Charges for this host are paid by `<owner>`. People you add can consume this
> host's capacity according to their role.

For manager grants:

> Managers can start and stop this host, add or remove people, and cause the
> host to run using the owner's budget.

For user grants:

> Users can create or move projects onto this host, using capacity paid by the
> owner. They cannot start or stop the host.

## Host Security Boundary

Dedicated-host owners, managers, and users have the same security boundary as
normal CoCalc users. They must not get direct SSH access to the host operating
system and must not be able to read host-local secrets such as Cloudflare tunnel
credentials, R2/object-storage credentials, provider tokens, or service keys.

Allowed owner/admin maintenance is limited to explicit UI/API actions that
perform controlled upgrades or maintenance on behalf of the user. These actions
must not expose shell access, secret files, environment variables, or raw host
filesystem browsing.

Managers can see operational metrics/logs needed to run the host, but logs must
be scoped to user-safe operational output and must not expose host secrets.

## Host Resource Policy

Dedicated hosts need one host-level project resource option:

```ts
metadata.resources.project_ram_limit_mb?: number;
```

This lets an admin configure how much RAM projects on that host may use, even if
the project owner's membership would normally provide less RAM. The limit is a
host policy because dedicated hosts are finite physical/VM capacity that the
host owner is paying for.

Semantics:

- admin-only setting
- applies to projects while they run on this host
- allowed range is `500MB <= project_ram_limit_mb <= host_ram_mb - 3072MB`
- reserve 3GB for host management and system services
- 500MB is the lower bound because it is enough to run a minimal project
- unset means project RAM comes from the normal project owner membership limit

Do not add host-level CPU or storage overrides:

- CPU is priority-based and should remain controlled by the existing scheduler
  priority model.
- Storage must continue to come from the project owner's membership because
  project storage persists beyond any particular project-host lifecycle.

## Owner-Configured Per-Host Spend Limits

Add optional settings:

```ts
metadata.billing.owner_spend_limit_5h_usd?: number;
metadata.billing.owner_spend_limit_7d_usd?: number;
metadata.billing.owner_spend_limit_status?: {
  state: "ok" | "at_risk" | "stopped_limit_exceeded";
  limit_5h_usd?: number;
  limit_7d_usd?: number;
  used_5h_usd: string;
  used_7d_usd: string;
  exceeded_window?: "5h" | "7d";
  first_exceeded_at?: string;
  stopped_at?: string;
  reason?: string;
}
```

These are per-host, owner-controlled rolling spend caps. The 5-hour and 7-day
windows are intentionally symmetrical with the membership spend-limit model, but
they are owner opt-in guardrails for a specific dedicated host.

They are intentionally different from:

- membership 5-hour and 7-day prepaid/postpaid limits
- admin entitlement overrides
- site-wide billing enforcement
- payment-method or subscription validity checks

Semantics:

- unset means no owner-configured per-host cap
- `0`, negative, non-finite, or invalid values are rejected
- only owner/admin can set, change, or remove them
- each configured cap applies to spend attributable to this host in its rolling
  window
- when either configured window is exceeded, the host is stopped
- recovery is simple: owner raises/removes the exceeded cap, then starts the host
  again

These limits should not deprovision disks or trigger the failed-payment recovery
state machine. It is a voluntary guardrail, not a payment failure.

### Spend Measurement

Preferred implementation:

- reuse purchase-session or metered usage records for dedicated-host spend
- filter by `host_id`
- sum host spend over `NOW() - interval '5 hours'`
- sum host spend over `NOW() - interval '7 days'`
- compare against `metadata.billing.owner_spend_limit_5h_usd`
- compare against `metadata.billing.owner_spend_limit_7d_usd`

If the existing spend tables do not yet make host-level rolling-window
aggregation cheap, add a helper in `src/packages/server/project-host/spend.ts`
rather than duplicating SQL inside maintenance.

### Enforcement Path

Integrate this into `src/packages/server/project-host/spend-maintenance.ts`.

Recommended ordering:

1. reconcile active purchase session for owner and host
2. compute host-level 5-hour and 7-day spend
3. if owner cap is exceeded, mark `owner_spend_limit_status`
4. request provider stop with a distinct reason
5. notify the owner using billing/spend notification category
6. do not run deprovision flow solely because this voluntary cap was hit

Recommended reason code:

```ts
"owner_host_spend_limit_exceeded";
```

This should produce wording like:

> This host was stopped because its owner-configured 5-hour spend limit was
> reached.

or:

> This host was stopped because its owner-configured 7-day spend limit was
> reached.

The host list and drawer should show:

- current 5-hour host spend
- current 7-day host spend
- configured caps
- cap status
- whether the cap caused the host to stop
- a direct owner/admin control to raise or remove each cap

## Backend API Plan

Add shared types in `src/packages/conat/hub/api/hosts.ts`:

```ts
export type HostAccessRole = "user" | "manager";
export type HostEffectiveAccessRole =
  | "owner"
  | "manager"
  | "user"
  | "pool"
  | "shared"
  | "admin";

export interface HostAccessEntry {
  host_id: string;
  account_id: string;
  role: HostAccessRole;
  created_by?: string | null;
  created_at: string;
  updated_by?: string | null;
  updated_at: string;
  revoked_at?: string | null;
}
```

Extend `Host` with:

```ts
access_role?: HostEffectiveAccessRole;
can_manage_access?: boolean;
can_view_host_projects?: boolean;
billing_owner_account_id?: string;
project_ram_limit_mb?: number;
host_ram_mb?: number;
owner_spend_limit_5h_usd?: number;
owner_spend_limit_7d_usd?: number;
owner_spend_5h_usd?: string;
owner_spend_7d_usd?: string;
owner_spend_limit_state?: "ok" | "at_risk" | "stopped_limit_exceeded";
```

Add RPC methods:

```ts
listHostAccess({ account_id, id });
setHostAccess({ account_id, id, target_account_id, role });
removeHostAccess({ account_id, id, target_account_id });
setHostProjectRamLimit({ account_id, id, project_ram_limit_mb });
clearHostProjectRamLimit({ account_id, id });
setHostOwnerSpendLimits({ account_id, id, limit_5h_usd, limit_7d_usd });
clearHostOwnerSpendLimits({ account_id, id, window? });
getHostOwnerSpendStatus({ account_id, id });
```

Permission requirements:

- `listHostAccess`: owner, manager, admin
- `setHostAccess`: owner, manager, admin
- `removeHostAccess`: owner, manager, admin
- `setHostProjectRamLimit`: admin
- `clearHostProjectRamLimit`: admin
- `setHostOwnerSpendLimits`: owner, admin
- `clearHostOwnerSpendLimits`: owner, admin
- `getHostOwnerSpendStatus`: owner, manager, admin; user can see a reduced
  status if useful in the host picker

Fresh auth:

- require fresh auth when granting `manager`
- require fresh auth when changing owner spend caps
- require fresh auth when changing the admin project RAM cap
- do not require fresh auth for adding a `user`

## Backend Implementation Plan

### 1. Centralize host access logic

Add a helper module:

- `src/packages/server/project-host/access.ts`

Responsibilities:

- load host owner and ACL role
- resolve effective role
- expose boolean permission helpers
- enforce owner/manager/user/admin gates
- keep `project_host_access` as the delegated-access source of truth

Suggested helpers:

```ts
getHostAccessForAccount({ host_id, account_id, admin_view? })
requireHostPermission({ host_id, account_id, permission })
listHostAccessEntries({ host_id })
setHostAccessEntry({ host_id, actor_account_id, target_account_id, role })
removeHostAccessEntry({ host_id, actor_account_id, target_account_id })
```

### 2. Replace coarse collaborator checks

Update `src/packages/server/conat/api/hosts.ts`:

- replace `loadHostForView`
- replace `loadHostForListing`
- replace `loadHostForStartStop`
- replace collaborator checks in `listHostsLocal`
- update `setHostStar` to allow owner/manager/user as appropriate
- keep destructive lifecycle methods owner/admin only

Update `src/packages/server/project-host/placement.ts`:

- replace `isCollab` with explicit effective access role
- `owner`, `manager`, and `user` can place projects
- pool access still uses membership tier rules

Critical server-side enforcement:

- project create and project move must validate destination host access on the
  server
- the UI host picker is not sufficient as an authorization boundary

### 3. Add host resource and spend-cap helpers

Add helpers near existing spend code:

- `getDedicatedHostProjectRamLimitStatus({ host_id, metadata })`
- `setDedicatedHostProjectRamLimit({ host_id, limit_mb })`
- `clearDedicatedHostProjectRamLimit({ host_id })`
- `getDedicatedHostSpend5h({ host_id })`
- `getDedicatedHostSpend7d({ host_id })`
- `getDedicatedHostOwnerSpendLimitStatus({ host_id, metadata })`
- `setDedicatedHostOwnerSpendLimits({ host_id, owner, limit_5h, limit_7d })`
- `clearDedicatedHostOwnerSpendLimits({ host_id, owner, window? })`

The RAM helper must validate host capacity before writing:

- reject values below 500MB
- reject values above `host_ram_mb - 3072MB`
- reject values when host RAM cannot be determined

Integrate into `spend-maintenance.ts` before general membership-lane enforcement
requests a drain. The voluntary cap should request a stop, not a deprovision
flow.

### 4. Multibay routing

Host ACL and per-host spend-cap writes must execute on the bay that owns the
host row.

Rules:

- if the host is local, write locally
- if the host belongs to another bay, route to that bay before evaluating
  permissions
- never write ACL rows into the admin actor's home bay merely because that is
  where the actor is homed
- when a host home bay changes, migrate `project_host_access` rows and
  host-local configuration such as owner spend caps and project RAM policy with
  the `project_hosts` row
- make bay move idempotent: after a failed/retried move, exactly one bay should
  own the active ACL rows for the host

This mirrors the admin entitlement override bug class: writes must follow the
target resource, not the actor.

## Frontend Plan

### Host drawer

Add an `Access` section/tab visible to owners, managers, and admins.

Owner/manager view:

- show owner
- show warning that all host charges go to the owner
- list users and managers
- add existing account
- select role: `Can use host` or `Manager`
- remove access
- promote/demote between user and manager
- disable owner removal

Owner/admin-only controls:

- per-host 5-hour and 7-day spend caps
- current rolling 7-day spend
- current rolling 5-hour spend
- cap status
- raise/remove cap

Admin-only controls:

- per-project RAM cap for projects running on this host
- show allowed range: 500MB through host RAM minus 3GB
- explicitly state that CPU and storage are not overridden by the host

### Host picker and create/move flows

For each host, show why it is available:

- `Owned by you`
- `Managed by you`
- `Shared with you`
- `Membership pool`

For delegated hosts, show:

> Paid by `<owner display name>`.

For user role on a stopped host:

- allow the host to be visible
- do not show a start button
- explain: `Ask the owner or a manager to start this host.`

### Host list

Add lightweight indicators:

- role badge: Owner, Manager, User, Pool
- paid-by owner when not owned by current user
- 5-hour/7-day cap badge when configured
- stopped-by-owner-cap badge when applicable
- admin-visible project RAM cap badge when configured

## Audit And Notifications

Minimum audit records:

- actor account id
- host id
- target account id
- old role
- new role
- removed/revoked
- timestamp

The `project_host_access` row history is enough for the first implementation if
updates preserve `created_*`, `updated_*`, and `revoked_*`. A later event table
can improve audit readability.

Notifications:

- notify target account when granted access
- notify target account when removed
- notify owner when manager grants or removes another manager
- notify owner when either per-host spend cap stops a host

Use the billing/spend notification category for spend-cap enforcement.

## Testing Plan

### Unit tests

Add tests for:

- owner is implicit full access
- user can place projects but cannot start/stop or manage ACL
- manager can start/stop and manage ACL
- manager cannot delete/deprovision/change funding/machine/rootfs controls
- manager cannot remove/demote owner
- owner/manager/user cannot get direct SSH or host secret access
- admin bypass works
- metadata collaborator migration maps correctly
- project RAM cap validates 500MB through host RAM minus 3GB
- project RAM cap overrides membership RAM only while project is on that host
- CPU and storage are not overridden by dedicated-host policy
- per-host spend cap status computes correctly
- per-host spend cap stop does not trigger deprovision
- billing owner remains unchanged for manager/user actions
- host bay moves preserve `project_host_access` rows and host-local config

### Integration tests

Add hub/API tests for:

- `listHostAccess`
- `setHostAccess`
- `removeHostAccess`
- `setHostProjectRamLimit`
- `clearHostProjectRamLimit`
- `setHostOwnerSpendLimits`
- `clearHostOwnerSpendLimits`
- `listHosts` role/cap fields
- project move/create authorization against a delegated host
- host home-bay move with ACL/config migration

### Live smoke

On `lite4b` or equivalent multibay setup:

1. owner creates a dedicated host
2. owner adds manager
3. manager adds user
4. user creates or moves a project to host
5. user cannot start/stop host
6. manager starts/stops host
7. manager cannot delete/deprovision/change machine/funding
8. owner sets very low 5-hour and 7-day host caps
9. maintenance stops the host with owner-cap reason
10. owner raises/removes cap and starts host again
11. inspect billing/purchase-session records and verify charges stay on owner
12. admin sets project RAM cap and verifies placed projects can use that RAM
13. verify CPU priority and storage still come from normal membership/project
    settings
14. move host between bays and verify ACL/config still works from the new home
    bay

## Implementation Phases

### Phase 1: Data and backend permissions

- add `project_host_access` schema
- add access helper
- migrate any alpha metadata collaborators once
- replace server-side permission checks
- expose role/cap fields in `listHosts`
- add host-home-bay migration handling for access/config rows

### Phase 2: API and UI management

- add host access RPC methods
- add owner spend cap RPC methods
- add admin project RAM cap RPC methods
- add host drawer access UI
- add host picker/list role and paid-by labels

### Phase 3: Spend cap enforcement

- add host-level 5-hour and 7-day spend aggregation
- integrate cap check into spend maintenance
- add stop reason and status display
- add owner notification

### Phase 4: Smoke and hardening

- run API tests
- run browser smoke
- run multibay smoke
- update release scoreboard
- fix only correctness, security, and clarity bugs found during smoke

## Resolved First-Release Decisions

- Managers cannot rename hosts.
- Managers can see host metrics and operational logs, but never direct SSH,
  host secrets, raw host filesystem access, or admin maintenance surfaces.
- Managers can stop/restart host projects if that is already part of the host
  operations panel.
- Host access grants require existing accounts only.
- Pending email invites can be added later, but are not part of this first
  release.

## Non-Goals For First Release

- group-based host access
- organization-wide host access
- public invite links
- split billing across users
- charging project owners for owner-paid dedicated-host capacity
- per-user quotas inside a dedicated host
- automatic manager inheritance from project collaborators
- automatic access based on course membership

The first release should solve the real collaboration problem without expanding
the billing model. The owner pays; trusted people can use or manage the host.
