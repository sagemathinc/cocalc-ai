# People And Content Invitations

Date: 2026-09-29.
Status: phases 1-5 implemented; phase 6 release validation and phase 7 agent
enablement remain separate gates.
Source baseline: `82c00b201bdb931fab49ccc437c1bcb0ad673d4d`.

## Implementation Notes

The human workflow now uses the shared prepare/review/send service. Access
offers still use `project_collab_invites`; collaboration invitations have
separate identities and never grant project membership. Drafts and send
operations belong to the sender's account home, access actions to the project
owner, and notification/read state to the recipient's account home.

Implementation entry points (relative to `src/`):

- `packages/util/people-invitations.ts` and `people-invitation-history.ts`:
  bounded public contracts, distinct recipient/contact identities and statuses.
- `packages/server/collaborators/invitations*.ts`: human-session APIs,
  recipient/project discovery, encrypted drafts, exact review and durable sends.
- `packages/server/people/`: contacts, versioned invitation projections,
  transactional source outboxes, backfill, routed owner actions and receipts.
- `packages/server/projects/people-invite-resend.ts`: separately authorized,
  idempotent email resends without rotating invitation tokens.
- `packages/server/notifications/content-invitation*.ts`: consolidated
  permission-free notices and delivery evidence from the existing notification
  and email outboxes. Provider submission is not a read receipt.
- `packages/frontend/collaborators/`: person-first modal, project/status table,
  contact details, global Invites history and explicit management actions.
- Artifact cards, Library, native agent threads and the public authentication
  continuation use the same typed content targets. Opening content is explicit.

Operational constraints before phase 6 sign-off:

- Deploy matching util, database, server/Conat and frontend builds. New storage
  is initialized by the invitation services and background collaboration
  maintenance; the existing `collaborators_enabled` setting gates the workflow.
- Backfill is bounded and uses the same versioned lifecycle outbox as new
  invitations. One-bay coverage becomes complete only after backfill and pending
  work drain. Multi-bay coverage remains explicitly partial until all-owner
  completeness reconciliation is verified; a local empty page is not proof of
  an empty global history.
- Account/project rehome is rejected when the new invitation state would be
  lost. Portable transfer of these families is not implemented. Deletion
  removes private account state and project-owned receipts under the documented
  storage rules; invitation evidence owned by another account is not identity
  proof and is not silently rewritten.
- Missing remote directory tombstones remain retryable and keep coverage partial.
  Global deletion reconciliation and finite terminal-history retention are still
  release follow-ups. Archiving does not erase encrypted contacts/history, which
  are currently retained until owner deletion. Collaboration withdrawal and
  verified contact-to-account linking are not exposed by this implementation.
- Email contacts are not automatically linked to whoever accepts a forwarded
  invitation. Ordinary and course invitation policy remains authoritative.
- Unknown sends are inspected using their original operation IDs. A provider
  timeout is not permission to send a duplicate; new explicit resends also
  respect unresolved attempts and cooldown. Course/account invitations do not
  use the ordinary-email resend endpoint.
- Current People content resolution requires collaborator-level access. A
  viewer's backing-file policy does not imply permission to open an artifact or
  agent thread through that resolver; any upgrade is a separately reviewed offer.
- Automatic content copying and agent/connector invitation scopes remain
  deferred. New send APIs require bound human sessions; existing connector
  privileges do not implicitly enable them.

Focused tests cover contracts, route/state handling, keyboard/focus behavior,
prepare/review binding, owner routing, SQL lifecycle/backfill, notification
counts, delivery suppression, idempotency and resend recovery. Database tests
use isolated PGlite (`COCALC_TEST_USE_PGLITE=1` with Node's
`--experimental-vm-modules`); external email delivery is mocked. Live multi-bay
and authenticated-browser end-to-end release validation is still required.

## Purpose And Decisions

Make inviting someone to useful work a short, transparent workflow, whether
they are already a collaborator, have another CoCalc account, or have not yet
signed up. The primary action is **Invite to collaborate on X**, not **Add a
collaborator to a project**. Projects remain the permission boundary.

Decouple two concerns throughout the UI, schema, APIs, notifications, and CLI:

- An **access invitation** offers a project role. Acceptance can change
  membership, subject to the existing project authorization policy.
- A **collaboration invitation** encourages someone to use or work on specific
  content. It sends context and an entry point; it grants no permission.

For A and B who already collaborate on project P, inviting B to artifact X
creates a collaboration invitation and notification only. It must not create a
redundant access invitation, change B's role, or require B to accept access
again. Dismissing that invitation does not remove access. Conversely, accepting
an access invitation does not mean B has opened or engaged with X.

Agreed scope:

- Rename the Collaborators tab URL to `/people/collaborators/` and add
  `/people/invites/`. Keep Conversations and Shared projects under `/people`.
- Make the reusable invitation workflow person-first, including from artifact
  and agent-thread entry points.
- Persist an account-owned person/contact record for an invited email address
  without creating a fake or placeholder CoCalc account.
- Show outstanding invitations globally and on each person's detail view.
- Track invitation lifecycle, current access, and delivery separately.
- Support creating a new project with the sender as its initial collaborator
  and an invitation for the selected person. No membership before acceptance.
- Preserve context through sign-in, signup, and acceptance, then offer an action
  to open the intended content. Never automatically run an agent or notebook.
- Design the shared service for agent/CLI use now. Enabling agent capabilities
  is a separate, later implementation phase, not a prerequisite for the UI.

Automatic copying or moving content to another project is explicitly deferred.
Copying an artifact card does not copy its backing files, dependencies, or agent
runtime. This release must not suggest that it does.

## Existing Building Blocks

Paths below are relative to `src/`. Recheck these entry points when implementing;
this inventory describes the baseline, not promises about deployed versions.

| Area                          | Existing code and implications                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invitation modal              | `packages/frontend/collaborators/invite-projects.tsx` selects up to 25 projects before opening `add-collaborators.tsx`; replace the ordering, not the project authorization service.                                                                   |
| Invite management             | `packages/frontend/collaborators/invite-inbox.tsx` already displays incoming/outgoing pending invites, delivery feedback, revoke, and email copy-link controls. Its capped pending lists are not a complete global history API.                        |
| Person model                  | `packages/util/collaborators.ts` requires `CollaborationPerson.account_id`; invited email-only contacts need their own identity.                                                                                                                       |
| Project invitations           | `packages/server/projects/collaborators.ts` and `packages/conat/hub/api/projects.ts` provide lifecycle states, account/email invites, role/read policy, resend-related delivery fields, copy links, and access requests.                               |
| Invite routing                | `packages/server/projects/collab-invite-directory.ts` routes email-token redemption. `collab-invite-inbox.ts` projects inbound account invitations; extend the architecture for complete outgoing/history views rather than assuming this covers them. |
| Project-owner routing         | `packages/server/conat/api/projects.ts` and the inter-bay project invite API route project-specific operations. A global local query must not be assumed to include every owning bay.                                                                  |
| Reference identities          | `packages/util/collaboration-references.ts`, personal URLs, Library, and agent discovery resolve typed content identities rather than aliases as authority.                                                                                            |
| Existing access UI            | `packages/frontend/project/access.tsx` provides a reusable access dialog and landing flow; preserve return-to-content context rather than sending users to the generic project list.                                                                   |
| Notifications                 | `packages/server/notifications/`, frontend notification handling, and `collaborators/invite-count.ts` provide the delivery/count paths to integrate with, not duplicate.                                                                               |
| Connector                     | `packages/util/api-key-scope.ts`, `packages/server/agents/cocalc-connector-*.ts`, and CLI scoped routing separate account capabilities, project grants, and temporary turn credentials.                                                                |
| Exact-action review precedent | `packages/server/api/key-actions.ts`, `key-action-store.ts`, and `key-action-routing.ts` implement human review for API-key revocation only. They are a precedent, not an existing generic invitation API.                                             |

Related designs:

- [Collaborators workspace](collaborators-workspace-plan-2026-09-27.md).
- [Email token invitations](email-token-collaboration-invite-plan-2026-05-18.md).
- [Project access requests](project-access-request-flow-plan-2026-05-29.md).
- [Current connector implementation map](api-first-connector-phase1-map-2026-09-25.md).
- [Scalable ownership and routing](scalable-architecture.md).
- [Frontend accessibility](accessibility.md).

## Navigation And User Experience

### People workspace

Use `/people/conversations/`, `/people/collaborators/`, `/people/projects/`, and
`/people/invites/` as the visible destinations. Parse the normal trailing-slash
form without an error. Update address-bar generation, copied URLs, direct-load
routes, Back/Forward behavior, and accessibility scenarios. `/people/people`
can canonicalize to Collaborators to preserve development bookmarks; do not add
an elaborate compatibility layer. Owner-qualified `/u/{owner}/people/{alias}`
is a separate personal-alias namespace and must keep its meaning.

Collaborators should include current collaborators and people with invitations,
with clear badges such as **Invitation pending**. Someone with no shared project
yet must not disappear. Combine linked contacts and existing collaborator
results without duplicate people or redefining account IDs as contact IDs.

Invites offers **Sent**, **Received**, and **History**, filters for person,
project, invitation kind, and status, and a visible **Invite** action. Default
Sent to the current user's invitations; showing other collaborators' project
invitations requires a separately authorized project-management view.

Each person detail shows shared projects, current role, pending access offers,
accepted/declined/expired/revoked history, collaboration invitations, and delivery
status. Show authorized **Resend**, **Copy invitation link**, and **Revoke**
actions beside the relevant invitation, not a generic button with hidden scope.

An existing collaborator receiving a content invitation sees, for example:

> A invited you to work on "Prime numbers notebook".
> "I got the visualization working. What do you think?"
> Open notebook
> You already have access through project P.

No permission-acceptance button is needed in that case. Opening, marking read,
or dismissing are recipient actions; none is an inferred commitment to work.
Read receipts or sender-visible engagement tracking are not required for v1.

### Shared person-first flow

1. **Choose person.** Accept email, permitted account-name search, exact public
   username, or an existing contact. Disambiguate names and username versus
   personal alias. An unknown email is a valid recipient, not an error. Do not
   expose whether an arbitrary email already has an account.
2. **Choose projects when necessary.** Show a paginated/searchable table with
   **Already a collaborator**, **Viewer**, **Invitation pending**, and eligible
   projects to select. Display roles and viewer restrictions accurately. Mark
   projects the sender cannot invite to as unavailable with a clear reason.
   Select at most 25 projects, preserving the current bound.
3. **Review.** Show the exact person, projects, proposed roles/read policies,
   optional content card, and editable message. Explain that collaborator access
   is to the project, not just X. No selection or preview sends anything.
4. **Send.** Display a durable per-project outcome and immediate person/invitation
   entries. Separate **Invitation created**, **Notification queued**, **Email
   sent**, **No email sent**, and **Failed**. Offer recovery for failed items
   without repeating successful ones.

When launched from content, choose the person first, but prefill the source
project and content card. If the person already has sufficient access, skip the
unnecessary project-selection step: **person -> message/review -> send**. Offer
an explicit way to inspect/change the context rather than hiding the project.
Do not silently upgrade an existing viewer: show whether they can open X with
their present policy and separately offer a collaborator invitation if needed.

**Create a new project together** is an explicit creation action. Preserve the
person/message draft while the existing project-creation flow runs. A new
project is owned by the sender, not a hidden copy of the source, and the other
person remains pending until acceptance. If creation succeeds but invitations
fail or the user cancels, show the created project and recovery state; do not
silently delete it or create another one on retry.

Use a single accessible modal/workflow rather than stacked forms. Preserve
focus, selections, messages, and scroll during background refresh; announce
meaningful changes without flicker. Keep close/back behavior clear, especially
when returning to the originating artifact or thread.

## Records And Identity

The following are logical contracts; choose final table/type names in the first
implementation phase. Reuse existing project invite records rather than creating
a second source of membership truth.

| Record                    | Required identity and behavior                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person/contact            | Stable `person_id`, owning human `account_id`, display label, protected email identity if supplied, optional `linked_account_id`, and link provenance. Private to the owner; not a globally editable representation of another person. |
| Invitation draft          | Stable draft ID, human owner, revision, exact recipient, content target, proposed project actions, message, channel choices, expiry, and optional trusted agent provenance. Persistence has no delivery or membership effect.          |
| Invitation send operation | Stable operation ID, immutable reviewed payload, per-project outcomes, collaboration invitation ID, and delivery receipts. Used to inspect unknown outcomes and retry idempotently.                                                    |
| Collaboration invitation  | Stable invitation ID, sender, contact/account recipient, typed content target, authored message, optional associated access invite IDs, timestamps, and lifecycle. Permission-free.                                                    |
| Access invitation         | Existing project-owned invitation with role/read policy, recipient binding, lifecycle, and acceptance identity. Add only the necessary typed association to a send/content invitation.                                                 |
| Recipient state           | Read/dismissed state owned by the recipient's home bay, independent of access acceptance and sender delivery status.                                                                                                                   |
| Account invite projection | Bounded metadata and versioned statuses for global sent/received/history views; never an authorization grant.                                                                                                                          |

Create or reuse the persistent contact when the first invitation is durably
created, including when email delivery fails. Typing in a search box should not
populate an address book. Drafts may retain a recipient specification without
making that recipient a visible invited person. Existing account-backed people
remain usable without requiring every list read to materialize new contacts.

Keep historical invitation evidence after a contact is hidden/archived. Define
contact deletion, account deletion, encrypted-email retention, and operational
log retention explicitly; hiding a row must not rewrite acceptance history.
Normalize email with the existing invite rules, not speculative provider-specific
dot/plus rewriting. Deduplicate within one contact owner's namespace only.

### Email acceptance is not automatic identity proof

Existing ordinary email invitations are bearer links that may be accepted by a
different signed-in account; course flows can impose additional matching rules.
Preserve those behaviors. Do not introduce global exact-email account lookup as
part of person-first selection or calculate a shared-project table by secretly
resolving an unrelated email.

Record `accepted_account_id` as an acceptance fact. Possession of a forwarded
link does not prove ownership of the original email. Automatically link an email
contact to an account only with appropriate verified identity evidence; otherwise
show **Accepted by account Y** and ask the contact owner to confirm the intended
association. An explicit account selection establishes the account target, not
verification of an unrelated email address. Preserve provenance and conflicts
instead of merging people globally or retargeting old invitations.

For an email-only contact, shared membership may be unknown. Say so rather than
claiming they have no access. Acceptance can discover that the chosen account
already has access and finish without a redundant membership mutation.

### Independent state machines

- Access lifecycle retains `pending`, `accepted`, `declined`, `expired`,
  `canceled`, and applicable blocking semantics from the existing service.
- Current access is a fresh authorization result, not a synonym for accepted.
  It may change independently after acceptance or through another invitation.
- Collaboration lifecycle distinguishes active from withdrawn; read/dismissed
  are recipient state. Associated pending access is displayed as a dependency,
  not an invented acceptance of the collaboration invitation.
- Delivery tracks channel-specific queued/sent/failed/suppressed outcomes and
  retry history. A successful provider submission is not proof a human received
  or read the email.
- Revoking a pending access offer does not remove existing membership. Withdrawing
  a collaboration invitation does not revoke permission or recall delivered
  email. Use distinct, accurately labeled operations for these actions.

## Shared Service Contract

Provide typed Conat APIs for the UI and future CLI. Method names below are
proposed, not existing commands or capabilities.

| Operation                 | Contract                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve recipient/content | Bounded, authorized resolution of email specifications, known/public account identities, personal aliases in the human's namespace, and stable content targets. Return ambiguity, not a guess. |
| List eligible projects    | Paginated project/access summary for the selected verified account or email contact, including existing and pending roles and sender invite authority. No per-project browser fanout.          |
| Prepare/revise            | Return a draft ID/revision, exact action summary, authoritative access checks, permissions needed, and warnings. No notifications, invitations, membership changes, or runtime startup.        |
| Review                    | Render the exact server-bound draft and a supported human confirmation action. Any change to recipient, target, role, message, or channels produces a new revision.                            |
| Commit/send               | Require an explicit current review/authorization, an idempotency key, and the exact draft revision. Return a durable operation ID and per-action results.                                      |
| Status/list               | Inspect an operation or paginated invite/contact history without resending; include delivery and projection freshness.                                                                         |
| Manage                    | Separate authorized resend, copy-link, revoke, dismiss, and accept/decline operations, each with explicit target and idempotency semantics.                                                    |

Bind content using stable project/resource IDs, not a mutable alias, display
name, arbitrary redirect URL, or a client-supplied assertion of access. A native
agent thread and an artifact can use existing typed identities; direct file/app
targets should use an explicitly validated target variant when supported, not
an untyped URL escape hatch. Keep a bounded authored label/message for intent;
resolve current authorized metadata when displaying or opening content.

Recheck sender authority, recipient access, blocks, resource existence, roles,
and applicable connector scope at execution. Notification-only drafts must fail
with **Review required** if access was lost, never turn into grants. Permission
offers must not silently widen after review; a role or target change needs a new
review. Existing `manage_users_owner_only`, viewer policies, invitation limits,
and project-owner membership checks remain authoritative.

Commit local intent and an outbox transactionally. Use stable child operation
IDs at remote project owners and receipts for reconciliation: there is no atomic
transaction across 25 project-owning bays. Distinguish durable admission from
completed invitations and channel delivery. A timeout is **unknown**, not proof
of failure; inspect before retrying and use the same key for identical retries.
Never roll back a successful project invitation by silently revoking it because
another project failed.

Aim for one coherent recipient message listing the reviewed projects and content,
while retaining separate project invitation decisions and statuses. A batch
landing page must list the exact roles and support explicit acceptance of selected
offers; a grouping link must not introduce a new broader grant. Opening or
previewing a link is side-effect-free. Course batch delivery remains unchanged.

## Ownership, Projections, And Notifications

| Data/action                                                     | Authority                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Contacts, drafts, send orchestration, agent approvals           | Sender's account `home_bay_id`.                                                                                                           |
| Access invites, membership, project restrictions and acceptance | Project `owning_bay_id`, through the existing routed service.                                                                             |
| Collaboration invitation intent                                 | Sender's account home, with an authenticated, versioned recipient projection. The target project owner authorizes content-related checks. |
| Received items, read/dismiss state, notification preferences    | Recipient's account home.                                                                                                                 |
| Username and bearer-token routing                               | Existing seed-directory services; not a new global contacts database.                                                                     |
| Opening and using content                                       | Existing authorized project-host data plane; no hub proxy for file/notebook/runtime traffic.                                              |

Project owners emit durable invitation lifecycle changes to sender and eligible
recipient homes. Extend projections to cover email-only outgoing invitations and
accepted/declined/expired/revoked history, not just pending inbound account rows.
Use monotonic source versions, idempotent consumers, deletion/tombstone events,
bounded queues, and retry/reconciliation. Delayed pending events cannot replace
accepted or revoked state. Backfill existing invitations in bounded background
jobs with explicit coverage status; don't build the global list by scanning
every project when a page opens.

Paginate by stable keysets; bind cursors to account, filters, and snapshot/version.
Return real server counts for the selected filters and independent pending/unread
totals. Counts must not be a page length, a capped list, or `max` of unrelated
sources. Outgoing pending counts are not incoming unread notification counts.
Use the same event identities for notifications, badges, and read transitions
so list contents and badges agree. Partial coverage/outages must be visible,
not reported as complete zero results.

Show durable local send results immediately, then reconcile projections by ID
and version without duplicates or flicker. Query only authorized contact/invite
history; after sender membership loss, retained authored history does not allow
new project metadata fetches, invites, copy-link operations, or resends.

Use existing notification delivery, preferences, blocks, tier limits, and email
outbox infrastructure. Coalesce the access and content portions into one useful
notification when appropriate. An existing collaborator still receives the
content invitation even though no access invite exists. Explicit resend is
cooldown/rate-limited and has its own operation ID; it should not create another
pending access offer or gratuitously rotate the existing token.

Account/project rehome and hard deletion must cover the new records, outbox
cursors, recipient state, token routes, and retry receipts. Resolve ownership at
operation time; never trust stale stored bay IDs as permanent routing. Add a
fail-closed rehome guard until each new record family has tested transfer support.
Launchpad is the one-bay case. Standalone single-user Lite must explicitly gate
unavailable invitation functionality rather than pretend to provide multiuser
account or email-delivery semantics.

## Content Opening, Privacy, And Abuse

Invitation context is an entry point, not a permission bypass. Before acceptance,
show only sender-authored invitation content and metadata allowed by the existing
safe invite preview policy. Do not fetch notebook contents, private thumbnails,
chat messages, or backing files to embellish an invitation for a non-member.
Authenticate and authorize again on open. Preserve the selected destination
through login/signup/acceptance using typed intent, not an arbitrary open redirect.

If X is deleted, moved out of scope, or no longer accessible, explain that and
offer the existing request-access dialog or an authorized project fallback. An
artifact in P may preview a file in Q: show the additional access requirement
explicitly or limit the action to the accessible card. Never claim that inviting
someone to P grants access to Q, and never add Q to a grant without review.

Keep contact emails and recoverable invite tokens protected using existing
normalization, encryption, copy-link authorization, and redaction conventions.
Ordinary content links are not bearer invitation links. Copying the latter is a
privileged disclosure and must not put tokens into public artifacts, generic
audit logs, indexed message content, or support diagnostics.

Enforce sender/recipient/project limits, block rules, message bounds, allowed
recipient search, and channel preferences for both invitation kinds. Notification
permission is not permission to spam all project collaborators. Initial scope
is one intentionally selected person, one optional content target, and at most
25 project offers per reviewed send; retries must not bypass these limits.
Define finite pending-draft, queue, and delivery-log retention budgets before
enablement without silently hiding outstanding invitations beyond a list cap.

## Agent And CLI Design

### Separation of authority

Agents use the same invitation service, not browser automation or a second
invitation implementation. Effective authority is the intersection of the human's
current authority, explicit connector scope, and the exact authorized action.
Runtime/file access, project listing, and basic account lookup must not silently
include collaborator discovery, notification sending, or membership management.

Future scope groups, with names to be finalized alongside endpoint classification:

- **Prepare invitations:** bounded permitted recipient/content lookup, project
  access checks, and private drafts. Neither contact search nor alias resolution
  is implied by basic account lookup. Return missing scopes clearly and do not
  reveal metadata outside the delegated read boundary.
- **Notify existing collaborators:** send a human-requested collaboration
  invitation for a selected recipient/content in permitted projects when access
  already suffices. No grants, upgrades, or implicit enrollment of agents.
- **Request permission invitations:** submit an exact proposal for human review;
  never approve or execute its own permission expansion.
- **Inspect/manage own invitation work:** bounded status/history and separately
  classified resend/revoke/copy-link operations. Do not treat a read capability
  as permission to retrieve bearer invitation links or resend email.

Add capabilities explicitly to shared scope parsing, the connector editor,
gateway/Conat method classification, server authorization, multibay routing, and
tests. Reject unknown capabilities and fail closed on older components. Keep
project selection and account-owned contact/draft scopes separate. A broad
runtime preset must not acquire these new capabilities as a side effect.

### Example agent interaction

User: **Invite @bella to work with @artifact.**

1. Resolve both references in the requesting human's authorized namespace. Prefer
   bound references already in the message; disambiguate personal aliases and
   account usernames, and ask about ambiguous matches rather than guessing.
2. Prepare a server-bound draft with stable recipient/content IDs, proposed
   message, exact projects/roles, and access status. The service, not model prose,
   determines which permission changes would be required.
3. If access already exists and the connector expressly permits the requested
   send, send the collaboration invitation. Otherwise present the draft in the
   human invitation workflow; missing delegation never justifies a broader login.
4. For permission changes, use a supported first-party authenticated action review
   and any required fresh auth. Show **Invite Bella as collaborator to P and
   send this message about X**, including whole-project access consequences.
5. Commit only the reviewed revision, then inspect and report durable per-action
   results. **Prepared**, **Awaiting approval**, **Created**, and **Email failed**
   are different outcomes, not synonyms for **Sent**.

An email input remains an email invitation specification until identity is
established through the normal flow; the agent must not invent an account match.
General help and a manually completed review remain useful when delegation is
insufficient for automated discovery or sending.

### Review, credentials, and retries

Human confirmation binds recipient, stable target, projects, roles/read policies,
message, channels, draft revision, and expiry. Reject substitution and stale
reviews. Recheck membership and management policy immediately before execution.
Loss of recipient access cannot transform an approved notification into an access
offer. Loss of sender authority cannot be bypassed by an earlier approval.

The authenticated service executes a human-approved operation; it does not return
a more powerful credential to the agent. Workbench may display a review card,
but ordinary proposed-action artifact decisions are not service authorization,
fresh auth, or an audit trail. The agent cannot approve its own draft through
browser scripts, a question response, or fabricated user messages.

Persist drafts independently of turn credentials. A draft may survive normal
turn completion/credential expiry, but this gives the agent no continuing right
to send, inspect, or retrieve tokens. A later human review is a new, explicit
authorization with current checks and bounded expiry, not reuse of an expired
agent grant. Connector revocation must stop new agent operations and invalidate
uncommitted delegated execution approvals; it need not erase the human's saved
draft. Human-initiated adoption of an old draft requires a new review.

Bind provenance server-side to human, connector/configuration revision, native
agent, source project, and run/turn when available. Treat it as issuance/audit
context, not proof that no other process in the shared source project could use
the temporary credential. Never read, print, copy, or persist connector secrets
in invitation records, cards, or CLI output.

The CLI should expose typed prepare/review/status/send operations using ordinary
scoped credential selection, stable request IDs, and machine-readable outcomes.
Reuse idempotency keys for identical retries; inspect unknown outcomes before
issuing new work. CLI copy-link requires explicit authority and intentional
secret output; routine status/support output contains IDs and redacted metadata.
Support must be able to resolve a permitted invitation/content URL to its stable
IDs, owner bay, operation status, and delivery state without extracting tokens.

Do not conflate inviting a human to an agent thread with changing Agent Networks,
connector grants, or execution policy. Notifications, previews, acceptance, and
opening a thread must never launch an agent. Instructions embedded in an artifact
are content, not authorization to contact people or grant access.

Connector readiness also depends on compatible hub/host/project CLI builds. The
discussion's read-only CLI probe succeeded after the project's CLI was updated;
an older CLI had incorrectly used an unsupported account-query path. Future UI
and CLI integration should report unsupported capability/version states clearly,
not imply a missing user grant or suggest credential substitution. This plan does
not require automatic CLI upgrades or restarting projects for scope changes.

## Implementation Sequence

Deliver reviewable commits with focused tests; do not mark a phase complete only
because its types or UI skeleton exist. Agent enablement is intentionally last.

1. **Contracts and routes.** Finalize contact identity/provenance, independent
   lifecycle types, typed target/draft contracts, finite bounds, and the view
   names. Add `/people/collaborators/` and `/people/invites/` routing tests. Document
   exact principal/capability classification before exposing new mutations.
2. **Contacts and global invite queries.** Add account-home contacts, project-owner
   lifecycle outbox events, complete sent/received/history projections, keyset
   pagination/counts, invalidation, background backfill, and rehome/deletion rules.
   Reuse existing access invitations and preserve course semantics.
3. **Prepare/review/send service.** Implement authoritative preflight, exact-review
   binding, durable orchestration and retry receipts, notification-only sends,
   associated access offers, and truthful per-action/delivery outcomes.
4. **People UI.** Replace project-first selection with the reusable person-first
   workflow, project/status table, new-project return flow, person records/details,
   and Invites tab. Wire global/per-person management and immediate reconciliation.
5. **Content entry and recipient landing.** Add artifact and agent-thread entry
   points, authored context, consolidated notifications/email, login/signup/accept
   continuation, authorized content open, and missing-access dialog/fallback.
6. **Human-flow release gate.** Complete the acceptance matrix, multi-bay and
   browser checks, accessibility review, support diagnostics, and deployment
   version/feature-flag documentation. No agent delegation is enabled by this gate.
7. **Agent/CLI follow-up.** Add explicit scopes and connector UI, typed CLI
   operations, first-party human review integration, provenance, scope/lifetime
   denial tests, and live scoped-client evidence before enabling agent sends.

There is no need for a parallel legacy person schema for this unreleased feature.
Use explicit development migrations/backfill where needed, while preserving real
project memberships, existing invitation identities/tokens, saved content
references, and deployed course invitation behavior. Avoid broad refactors of
unrelated account or course code.

## Acceptance And Validation

The following are release gates, not claims of completed tests.

| Scenario                         | Required result                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Existing collaborator            | One useful collaboration notification; no access invitation, role change, or acceptance requirement.                            |
| Existing viewer                  | Correct content/read-policy check; an upgrade is a separately reviewed offer, never implicit.                                   |
| Known account without access     | Explicit access offer plus preserved content intent; acceptance opens the intended authorized destination.                      |
| Email-only recipient             | Visible pending contact immediately; no fake account, exact-email enumeration, or premature membership.                         |
| Forwarded email link             | Record actual accepting account; do not assert email ownership or silently merge the wrong contact.                             |
| Multi-project send               | One coherent workflow with exact per-project roles, partial success, inspectable unknown outcomes, and duplicate-free recovery. |
| Existing pending offer           | Show/reuse it only when compatible and authorized; don't silently modify another sender's offer.                                |
| Expiry/revoke/decline/block      | Correct statuses and permitted recovery; an obsolete link cannot grant access.                                                  |
| Delivery failure                 | Invitation remains visible; email-not-sent and copy-link fallback are explicit and accurately authorized.                       |
| Accepted then removed            | History says accepted; current access says unavailable; history never restores permission.                                      |
| Content or alias change          | Stable target remains bound; deleted/inaccessible content has a safe fallback, not a guessed replacement.                       |
| Cross-project file preview       | Access to the artifact's project does not imply access to the backing-file project.                                             |
| New project then canceled/failed | Created project is reported and reused on retry; no duplicate creation or silent deletion.                                      |
| Out-of-order projection events   | Newer lifecycle/read state wins; list totals and notification badges remain consistent.                                         |
| More than a page of invitations  | Every authorized outstanding item remains reachable and totals are not capped page lengths.                                     |
| Three-bay placement              | Sender home, recipient home, and project owner on different bays work without local-DB shortcuts.                               |
| Rehome/outage/deletion           | Durable retries and routing fences; no stale authority, duplicate emails, lost state, or false complete-zero result.            |
| Agent insufficient scope         | Draft/help only as allowed; no broadened login, privilege inference, token disclosure, or send.                                 |
| Agent existing-access send       | Requires explicit notification capability and human request; access loss causes review, not a grant.                            |
| Agent approval race              | Changed recipient/role/message/configuration or stale review is rejected; exact-action checks also hold at execution.           |
| Agent turn ends                  | No surviving credential authority; a human can explicitly adopt/review a retained draft through normal auth.                    |
| No automatic execution           | Opening, accepting, or notifying never starts an agent/notebook or creates an Agent Network.                                    |

Run focused util/database/server/Conat tests for identity, transactions,
authorization, lifecycle, projections, counts, and multibay routing. Add isolated
PostgreSQL integration tests for retries, concurrent decisions, ordering,
reconciliation, and representative large invitation histories/query plans.
Keep production accounts, emails, and invitation tokens out of fixtures/reports.

Frontend tests must query accessible roles/names and cover keyboard person/project
selection, review, send, Escape, focus restoration, draft preservation, and stable
refresh. Run package typechecks and `pnpm -C src lint:frontend`; use the existing
accessibility harness for the new routes/dialogs. Validate light/dark themes,
320px width, 200% zoom, account animation preferences, and mobile review tables.

Use isolated live accounts for sender/recipient acceptance, email/manual-link
delivery, and multibay checks. Later replay the agent matrix with both manual
scoped keys and real turn-issued connector credentials, including expiry and
revocation. Record exactly which builds and scenarios passed; do not substitute
mocked test success for live delivery or scoped CLI evidence.

## Explicitly Deferred

- Automatic content copying/moving, dependency packaging, or agent cloning into
  a newly created project.
- Agent sends/permission-review integration until the human service and UI are
  complete and their separate capability/approval gates pass.
- Sender-visible read receipts, engagement analytics, reminders, or growth
  campaigns. Existing delivery evidence is not an engagement signal.
- Bulk unrelated-person outreach, public address-book lookup, or automatic
  permission grants based on chat text, aliases, or contact entries.

No further product clarification is required to begin phases 1-6. Table names,
capability spelling, and finite retention budgets should be finalized in the
contract phase without changing the boundaries above.
