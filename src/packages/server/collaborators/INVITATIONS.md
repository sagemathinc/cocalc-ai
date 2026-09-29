# People Invitation Service

This is the human prepare/review/send service. Agent/connector invitation
capabilities remain disabled; declaring a method here does not delegate it.

## Authority

Public methods are under `collaborators`: `prepareInvitation`,
`reviewInvitation`, `sendInvitation`, and `getInvitationOperation`. They use the
bound-session account transform, discard client-selected session hashes, and
validate the current account session at its resolved home. API keys, projects,
hosts, managed agents, and standalone Lite cannot execute these methods.
Ordinary invitations do not invoke admin/direct-add authorization or grant
membership. The separate contact/history/discovery reads are account-only and
remain denied to API-key principals by the existing explicit RPC allowlist.

Sender-home storage never authorizes a project action. The service calls
`people/invitation-actions` for current-owner preflight, receipt inspection, and
execution. Notification-only actions are immutable and fail with review required
when recipient access changes. Typed targets are existing collaboration resource
IDs, not mutable aliases, arbitrary redirects, or runtime instructions.

## Durable Boundaries

Drafts contain encrypted canonical intent and compare-and-swap revisions.
Preparation and review have no invitation, contact, delivery, membership, or
runtime effect. Review binds one revision and a digest of the human session for
at most ten minutes. Revisions invalidate prior reviews.

Send admission commits encrypted intent and a pending operation row together.
The caller's UUID idempotency key is the operation ID; reuse with another review
or revision fails. One draft revision cannot admit another operation. Replaying
an admitted operation does not extend its authorization expiry.

Each project has a stable child ID. Workers inspect the current owner's receipt
before execution, including after a crash that lost the home acknowledgment.
Unknown is not failure and is never a fresh-send instruction. Access execution
uses the existing owner lifecycle, never a home-local project shortcut. A
successful child is retained independently of other projects. Owner reconciliation
can report creation with email still unknown; provider submission cannot be
inferred from a committed access offer.

Notification graph/outbox insertion and home delivery receipts share one fenced
transaction. A consolidated account notice can serve multiple project outcomes.
An email-only recipient is never looked up as an account. Recipient read/archive
state remains in the canonical notification store, not in sender receipts.
Delivery lookup resolves the recipient's current home and reports only delivery,
never engagement. Status is read-only and cannot resend. Unrequested in-app
delivery carries no notification receipt ID.

## Bounds And Maintenance

Limits: one recipient, one optional typed target, 25 projects, 2,000 message
characters, 160 label characters, 100 pending drafts per account, 60 admitted
sends per hour, and 10,000 retained operations per account. Drafts expire after
seven days. Completed operation history is retained at least 90 days and pruned
in batches of 100 on new admission. Unknown/pending work is not silently pruned;
it counts against the retained-operation cap. Draft cleanup occurs on preparation.

The collaborators maintenance loop schedules bounded durable workers without
blocking the existing projection loop. Database claims and fencing tokens prevent
stale workers from overwriting another worker's receipts. Restart/retry always
resolves current ownership again. Account/project rehome fails closed until the
new record families have transfer support. Soft deletion cleanup and hard-delete
cascades purge sender-private ciphertext.

Tests distinguish transactional PGlite integration from real network/provider
evidence. Passing focused tests is not a claim of live three-bay delivery, SMTP
success, deployment enablement, or completion of the whole product release gate.
