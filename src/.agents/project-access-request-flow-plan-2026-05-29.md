# Project Invite And Access Request Flow Plan

Date: 2026-05-29

Status: done, 2026-05-30.

## Goal

Make direct project URLs useful for signed-in users who are invited, not yet a member, or currently a viewer, without leaking project information to unauthenticated users and without creating a parallel collaborator-permission model.

This plan covers release blocker 13 from `release-blocker-triage-2026-05-29.md`.

## Requirements

- Unauthenticated users who visit a project URL must sign in before any project title, owner, avatar, invite state, or request option is shown.
- A signed-in invited user who visits the project URL can accept the invite directly there.
- A signed-in non-member who visits a project URL can request access.
- Request access lets the user choose `viewer` or `collaborator`, defaulting to `viewer`.
- If the user is already a `viewer`, the only request option is `collaborator`.
- The viewer `Read Only` affordance should explain read-only mode and offer collaborator access request.
- A viewer should also be able to request collaborator access from the project side-rail menu.
- Access-request notifications should follow the same channel patterns as project collaborator invites, including user email preferences in `/settings/preferences/communication`.
- Project owners must be able to block a requester from sending further requests for that project.
- Approval authorization must honor `projects.manage_users_owner_only`: owners/admins can always approve; collaborators can approve only when owner-only collaborator management is disabled.
- The safe project URL page may show project title and owner display identity, including avatar. It must not show project description, collaborator/viewer lists, or email addresses.

## Current Primitives To Reuse

- Project membership and roles live in `projects.users`, with roles represented by `ProjectUserRole`.
- Viewer read restrictions use `ProjectViewerReadPolicy`.
- Project collaborator invites already support `invite_role: "collaborator" | "viewer"` and optional `read_policy`.
- Invite management is exposed through `@cocalc/conat/hub/api/projects` and implemented in `src/packages/server/projects/collaborators.ts`.
- The project setting `manage_users_owner_only` already expresses whether collaborators can manage collaborators.
- Server-side collaborator-management authorization is centralized in `assertCanManageProjectCollaborators`.
- Existing invite blocking is represented by `project_collab_invite_blocks`, exposed through `listCollabInviteBlocks` and `unblockCollabInviteSender`.
- Existing invite UI is in `src/packages/frontend/collaborators`, especially `InviteInboxPanel` and `AddCollaborators`.

## Architecture Rules

- Treat this as a control-plane workflow. It is correct for hub/conat APIs to authorize, create requests, notify, and approve membership changes.
- Do not proxy project data through the hub. Once access is granted, steady-state project traffic remains direct client-to-project-host.
- Route project operations by project `owning_bay_id`. The project owning bay is authoritative for project metadata, membership, access requests, approval, and blocking.
- Route account-facing notifications through the existing notification/invite mechanisms so home-bay preferences and delivery policy are respected.
- Do not assume the local bay database is authoritative unless ownership has been resolved.

## Proposed Data Model

Add a project access request table, or an equivalent first-class record if an existing notification/request table is a better fit:

```sql
project_access_requests (
  request_id uuid primary key,
  project_id uuid not null,
  requester_account_id uuid not null,
  requested_role text not null check (requested_role in ('viewer', 'collaborator')),
  read_policy jsonb,
  message text,
  status text not null check (status in ('pending', 'approved', 'denied', 'blocked', 'canceled')),
  source text not null,
  created timestamptz not null,
  updated timestamptz not null,
  decided timestamptz,
  decided_by_account_id uuid,
  decision_message text
)
```

Constraints and indexes:

- Unique pending request per `(project_id, requester_account_id)`.
- Index pending requests by `project_id`.
- Index requester history by `requester_account_id`.
- Keep denied/approved rows for audit and cooldown behavior.

Blocking:

- Prefer a new project-scoped block table for access requests, since invite blocks are currently account-to-account inviter blocks:

```sql
project_access_request_blocks (
  project_id uuid not null,
  blocker_account_id uuid not null,
  blocked_account_id uuid not null,
  created timestamptz not null,
  updated timestamptz not null,
  primary key (project_id, blocked_account_id)
)
```

- If implementation can safely generalize `project_collab_invite_blocks` without confusing invite semantics, reuse its UI patterns but keep request blocking project-scoped.

## New Hub API Surface

Add these methods under `projects` in `@cocalc/conat/hub/api/projects`:

- `getProjectAccessLandingInfo({ project_id })`
- `requestProjectAccess({ project_id, requested_role, message?, source })`
- `listProjectAccessRequests({ project_id, status? })`
- `respondProjectAccessRequest({ project_id, request_id, action, role?, read_policy?, message? })`
- `listProjectAccessRequestBlocks({ project_id })`
- `unblockProjectAccessRequester({ project_id, blocked_account_id })`

`getProjectAccessLandingInfo` returns only signed-in-safe metadata:

```ts
{
  project_id: string;
  title: string | null;
  owner?: {
    account_id: string;
    first_name?: string | null;
    last_name?: string | null;
    name?: string | null;
    avatar_image_tiny?: string | null;
  };
  relationship:
    | "none"
    | "viewer"
    | "collaborator"
    | "owner"
    | "admin";
  pending_invite?: {
    invite_id: string;
    invite_role: "viewer" | "collaborator";
    read_policy?: ProjectViewerReadPolicy | null;
  };
  pending_request?: {
    request_id: string;
    requested_role: "viewer" | "collaborator";
    status: "pending";
  };
  blocked?: boolean;
}
```

It must not return:

- Project description.
- Full `users` map.
- Collaborator or viewer list.
- Email addresses.
- Project host/runtime information.
- File/listing information.

Authentication behavior:

- `getProjectAccessLandingInfo` requires an account. Unauthenticated calls should fail with the normal auth-required error, and the frontend should route to sign-in before calling it.
- Signed-in users may get the minimal title/owner/avatar data even when they have no project membership, per product requirement.

## Server Behavior

Access info:

- Resolve project ownership first.
- On the owning bay, load only title, users, owner identity fields required for display/avatar, current caller role, pending invite, pending access request, and blocked state.
- If project does not exist, return not found without revealing extra details.

Invite acceptance from project URL:

- Reuse `respondCollabInvite({ action: "accept" })`.
- If acceptance succeeds, route the user into the project.
- If invite is expired, revoked, or blocked, show that state with a request-access fallback when appropriate.
- If the user accepts a viewer invite, project opens in viewer mode.
- If the user accepts a collaborator invite, project opens in collaborator mode.

Request creation:

- Reject unauthenticated users.
- Reject owners/collaborators because they already have full access.
- If caller is a viewer, only allow `requested_role: "collaborator"`.
- If caller is not a member, allow `viewer` or `collaborator`, defaulting frontend to `viewer`.
- Reject if project-scoped request block exists.
- Normalize and length-limit optional message using the same style as invite messages.
- Enforce cooldown/rate limits to prevent repeated spam even before blocking. Start with per-project-per-requester cooldown plus an account-wide daily cap.
- Upsert the single pending request instead of creating many pending rows. Updating the requested role/message should update `updated`.

Approval:

- Use the same authorization policy as collaborator management:
  - Admins and project owners can approve/deny/block.
  - Collaborators can approve/deny/block only when `manage_users_owner_only` is not true.
  - Viewers and non-members cannot approve.
- Approval grants the requested role by updating `projects.users`.
- If approving as `viewer`, attach the selected/default `ProjectViewerReadPolicy`.
- If approving as `collaborator`, clear viewer-only read policy.
- Deny keeps the request history but does not grant access.
- Block marks the request blocked and creates/updates the project-scoped block.
- Publish normal project account feed/index updates after membership changes.

Notifications:

- On request creation, notify eligible approvers using the same delivery family as collaborator invites.
- Honor communication preferences so email behavior follows `/settings/preferences/communication`.
- Avoid duplicate notification spam for repeated updates to the same pending request.
- On approval/denial/block, notify the requester.
- Include enough payload for UI actions: `project_id`, `request_id`, requester display name/avatar, requested role, and project title.
- Do not include project description or email addresses in request notifications unless the existing invite notification channel already has a signed-in-only context where that is safe.

## Frontend UX

Project URL routing:

- If unauthenticated, redirect to sign-in first. Do not render title/owner/access state before authentication.
- After sign-in, call `getProjectAccessLandingInfo`.
- If the user has a pending invite, show accept/decline controls directly on the project URL page.
- If the user has no membership, show:
  - Project title.
  - Owner name/avatar.
  - Relationship: no current access.
  - Request access form with `viewer` selected by default and `collaborator` as the other option.
- If the user is a viewer, open the project normally in viewer mode, and expose collaborator-request affordances from within the project.
- If the user is collaborator/owner/admin, open the project normally.

Viewer affordances:

- Make the `Read Only` indicator clickable.
- Popover/modal explains that viewer mode can browse/open allowed files but cannot edit, start runtime, use terminals, run agents, or change settings.
- Include a primary action `Request collaborator access` unless a collaborator request is already pending or blocked.
- Add `Request collaborator access` to the side-rail `...` menu for viewers.

Approver UI:

- Add a pending access request list near the collaborator invite inbox in project settings/flyout.
- Show requester display name/avatar, requested role, message, and age.
- Actions: approve, deny, block.
- For collaborator requests, allow approving as collaborator or downgrading to viewer if that is useful; default to requested role.
- Hide this panel from users who cannot manage collaborators under `manage_users_owner_only`.
- Add a blocked requesters list near the existing invite-block management UI.

Requester UI:

- If a pending request exists, show `Request pending` with requested role and a disabled/resend-after-cooldown state.
- If denied but not blocked, allow another request after cooldown.
- If blocked, say the project is not accepting access requests from this account. Do not reveal internal block metadata.

## Abuse And Privacy Controls

- No project information is shown before sign-in.
- Signed-in non-members see only title and owner display identity/avatar.
- Request creation is rate-limited.
- Repeated requests update a pending row instead of creating notification floods.
- Project-scoped blocking stops future requests from abusive accounts.
- Approval and blocking require the same authority as collaborator management.
- All membership-changing actions should be audited in the project log.
- Do not expose owner email, collaborator email, collaborator list, viewer list, project description, files, host information, runtime state, or settings on the access landing page.

## Implementation Phases

1. Add server tests for the desired state machine:
   - unauthenticated safe-info call fails;
   - signed-in non-member gets title/owner/avatar only;
   - pending invite is reported and can be accepted from project URL;
   - non-member requests viewer/collaborator;
   - viewer can only request collaborator;
   - blocked requester cannot request;
   - `manage_users_owner_only` controls collaborator approvers.

2. Implement the owning-bay routed hub APIs:
   - safe landing info;
   - create/list/respond access requests;
   - block/unblock requesters.

3. Wire notifications:
   - request-created notification to eligible approvers;
   - request-decision notification to requester;
   - reuse invite delivery preferences/patterns where possible.

4. Implement the project URL access page:
   - auth gate first;
   - invite accept/decline path;
   - no-access request form;
   - pending/blocked states.

5. Implement viewer in-project affordances:
   - clickable `Read Only` indicator;
   - side-rail request collaborator access action;
   - pending/blocked state handling.

6. Implement approver management UI:
   - pending request list in collaborator settings/flyout;
   - approve/deny/block actions;
   - blocked requester list and unblock.

7. Validation:
   - focused server tests for project access request APIs;
   - focused frontend tests for access page and viewer affordance states;
   - multibay routing tests or inter-bay API tests for non-local project ownership;
   - manual browser pass for unauthenticated, invited, non-member, viewer, collaborator, owner, blocked requester.

## Closeout

Implemented and validated. The flow now covers signed-in project URL access
landing, project invite accept/decline, non-member access requests with viewer
default, viewer-to-collaborator requests, request approval/deny/block/unblock,
requester decision notifications, inline notification review, completed-request
notification state, and post-action invite feedback with an open-project path.

Manual validation on 2026-05-30 covered the main end-to-end browser paths:
non-member request, pending request display, owner review/approval, viewer mode,
and notification-center handling.

## Open Decisions

- Whether access requests should support an optional requester message. Recommendation: yes, but short, sanitized, rate-limited, and included only in signed-in approver UI/notifications. (ANS: Yes, but short and safe.)
- Whether a denied request can be retried immediately. Recommendation: no; apply a cooldown unless the approver blocks the requester. (ANS: I agree)
- Whether approvers can change requested role at approval time. Recommendation: allow downgrade from collaborator to viewer, but do not silently upgrade viewer to collaborator without an explicit approver choice. (ANS: agreed)
- Whether request blocks should also block future collaborator invites from the requester. Recommendation: no; keep request blocking project-scoped and separate from invite sender blocking unless product explicitly wants account-to-account invite blocking semantics. (ANS: agreed)
