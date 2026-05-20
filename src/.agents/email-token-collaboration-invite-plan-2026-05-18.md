# Email Token Collaboration Invite Plan

Date: 2026-05-18

Status: functionally complete; validation and hardening remain. Project and
course email-token invites, including side-effect-free preview,
Accept/Decline/Block confirmation, token-only invite URLs, manual-link fallback,
email-enabled delivery, and multibay accept routing, work end-to-end as of
2026-05-20.

## Problem

CoCalc currently needs users to find the right person before inviting them to a
project or course. Historically this has caused two separate classes of
problems:

- Security: exact account search by email, name, or UUID can become an account
  enumeration oracle.
- Product correctness: user B may have multiple CoCalc accounts, while user A
  only knows one of B's email addresses. If A invites the wrong existing CoCalc
  account, B either misses the project/course or creates yet another account.

The target design is to stop treating email as an account lookup key in normal
user-facing flows. Email should be a delivery and proof channel. The person who
receives the tokenized invite should be able to accept it using whichever CoCalc
account they actually intend to use.

## Current Relevant State

The current collaborator invite model already exists and should be extended
rather than replaced:

- `project_collab_invites` stores project, inviter account, invitee account,
  status, message, and timestamps.
- The Conat API already has project collaboration invite methods and inter-bay
  routing.
- The frontend has account-based invites and email-based invites in
  `frontend/projects/actions.ts` and `frontend/collaborators/add-collaborators.tsx`.
- Course student rows already store instructor-provided email metadata, and
  course sync already treats `email_invite` as a string column.
- Course student project setup currently invites by email when the student value
  contains `@`, and otherwise invites by account id.

This plan should preserve the existing account-to-account invite path for known
related users, but add a first-class token invite path for email delivery and
course enrollment.

## Principles

- Non-signed-in users must not be able to search accounts.
- Normal signed-in users must not get exact email lookup results unless the
  target account is already related to them by an existing project/course/admin
  relationship.
- Inviting by email must not reveal whether that email has a CoCalc account.
- Email invite APIs must return generic results such as "invite created" or
  "invite sent if allowed".
- The token recipient may accept with any signed-in CoCalc account.
- The token is a bearer capability. Whoever has it can redeem it until it
  expires or is revoked.
- Opening an invite link must be side-effect-free. A signed-in recipient must
  explicitly click Accept before the server adds them to a project or course.
- Invite links must be visible to the inviter so they can be copied into Canvas,
  Slack, LMS announcements, or other channels when email delivery fails.
- Email content must be constrained for low-trust users because this feature
  lets users cause CoCalc to send email.
- Throttling and content limits must be membership-tier parameters, which can
  be overridden by admins.

## Terminology

- Account invite: an invite targeted at a known CoCalc account id.
- Email token invite: an invite delivered to an email address and accepted by
  any signed-in CoCalc account holding the token.
- Course invite: an email token invite with course context that can bind the
  accepting account to a course student row and student project.
- Invite link: the redemption URL generated for an email token invite. This link
  is sent by email and also available to the inviter for copy/paste fallback.

## Data Model

Extend the current project collaboration invite model or add a sibling table
that can be joined to it. The least disruptive approach is:

- Keep `project_collab_invites` for the common invite lifecycle and project
  identity.
- Allow `invitee_account_id` to be null for email token invites.
- Add nullable fields needed for token and email invites.

Proposed additional fields:

- `invite_source`: `account`, `email`, `course_email`, or future scoped values.
- `email_hash`: HMAC of normalized target email for dedupe and rate limiting.
- `email_ciphertext`: encrypted target email for resend/revocation UI where
  needed.
- `token_hash`: hash of the random redemption token, never the plaintext token.
- `token_ciphertext`: encrypted token material used only to reconstruct the
  invite link for authorized inviters, resend jobs, and CLI output.
- `token_hint`: short non-secret suffix for support/debugging.
- `accepted_account_id`: account that redeemed the token.
- `expires`: token expiration timestamp.
- `revoked`: timestamp or status reuse via `canceled`.
- `resend_count`: number of times CoCalc attempted to email the invite.
- `last_sent`: timestamp of the most recent email send.
- `scope`: high-level invite kind such as `project_collab` or `course_student`.
- `context`: JSONB for structured invite context.

The `context` JSON for course invites should include:

- `course_project_id`
- `course_path`
- `student_id`
- `student_project_id`, if already known
- future `lms_context`, if imported from Canvas or another LMS
- future `lms_user_id`, if available
- future `lms_course_id`, if available

If we prefer stricter SQL shape, the course fields can be columns instead of
JSONB. JSONB is acceptable for initial implementation because the authoritative
course state remains the course project and `.course` sync data, and the token
context is primarily a redemption instruction.

Token storage requirements:

- Generate at least 128 bits of random token entropy.
- Store a keyed or slow hash of the token for redemption validation.
- Store encrypted token material only when the product needs copy/resend/reuse
  semantics. This is required for project owners, instructors, cocalc-cli, and
  the email queue to recover the same active invite link.
- Encrypt `token_ciphertext` using the site master-key infrastructure or an
  invite-token-specific derived key. Never log, index, search, or expose the
  plaintext token except to an authorized creator/project owner/instructor or
  the outgoing email renderer.
- Include `invite_id` in the URL for lookup, but validate using `token_hash`.
- Do not store plaintext token in Postgres logs, events, audit entries, or
  metrics.
- Rotating a token is a security action and should invalidate the previous
  encrypted token and hash. Ordinary resend should reuse the active token until
  expiry or revocation.

## URL Shape

Use the stable token-only route:

```text
/invites/<opaque-token>
```

The URL is safe to copy from the inviter UI, but it is a bearer capability, so
the UI must label it clearly:

```text
Anyone with this link can accept the invite until it expires or is revoked.
```

Routing is handled by the central invite directory keyed by the hashed token,
not by project or invite ids embedded in the URL. This avoids leaking project
implementation details in links and makes multibay redemption route by explicit
directory ownership.

## Account Search Policy

Remove the public HTTP account search route. There is no valid unauthenticated
use case for account search in CoCalc-ai.

For signed-in account search:

- Keep search behind Conat/authenticated APIs.
- Normal callers may search known or related accounts.
- Admins may do exact email/UUID lookup.
- Course/project invite by email does not call account search.
- The collaborator UI should encourage "Invite by email" as the default safe
  path when the inviter knows an email address.

This is separate from displaying historical account names. Existing project,
time-travel, and course contexts may need to resolve account ids to names even
after collaboration ends. That is display of known ids, not account search.

## Project Invite Flow

Creating an email token project invite:

- Caller must be signed in.
- Caller must have permission to invite collaborators to the project.
- Server normalizes the target email.
- Server enforces membership-tier invite limits.
- Server creates or reuses a pending invite for the same project, inviter, and
  email hash.
- Server generates the token link and stores only the token hash.
- Server sends a constrained email if allowed.
- Server returns the invite row plus the redemption link to the inviter.

Accepting an email token project invite:

- If the browser is not signed in, show sign-in/create-account first, then
  resume redemption.
- If the browser is signed in, show a confirmation page with safe invite
  details, the inviter message, and Accept, Decline, and Block actions. Merely
  viewing the link must not add the user to the project.
- Accept calls the redemption action.
- Server validates `invite_id`, token, status, expiry, and revocation.
- Server resolves the project owning bay and performs the collaborator write on
  the owning bay.
- Server adds the accepting account as a collaborator only after Accept.
- Server stores `accepted_account_id`, `responded`, and status `accepted`.
- Server projects invite state back to the inviter and accepting account home
  bays as needed.
- Decline records a declined response without adding the account.
- Block should behave like the internal invite block flow where possible; at
  minimum it must prevent this invite from being accepted by the current
  account.

Revoking an invite:

- Inviter or project owner can revoke pending email token invites.
- Revocation invalidates token redemption immediately.
- Revoked links should show a generic expired/revoked message.

## Course Invite Flow

Course invites should use email token invites, not account lookup.

Creating course student invites:

- Instructor imports or pastes roster rows with email, name, and optional
  external/LMS identifiers.
- The `.course` file continues to store instructor-entered email and names as
  roster metadata.
- For each student row, the system creates or reuses a course email token invite
  with `course_project_id`, `course_path`, `student_id`, and optionally
  `student_project_id`.
- The invite link is emailed to the student and shown to the instructor for
  copy/paste fallback.

Redeeming course student invites:

- Student opens the invite link and signs in with whichever CoCalc account they
  actually use.
- Server validates the token and routes to the course/project owning bay.
- Server binds the accepting account to the course student row.
- Server ensures the accepting account is a collaborator on the student project.
- Server should add the accepting account to the course shared project if the
  course settings require that.
- Server marks the invite accepted with `accepted_account_id`.

Course row update detail:

- Avoid direct ad hoc JSONL file mutation from unrelated server code if
  possible.
- Preferred path: update authoritative course/project metadata through the same
  course sync/project-control mechanism that already owns course state.
- If the student project has a `course` field that already records
  `course_project_id`, course path, and student account id, use that as the
  redemption write and let normal course sync reconcile the `.course` row.
- If that path is incomplete, add a narrow course-owning-bay RPC such as
  `acceptCourseStudentInvite` that updates the student row through the course
  sync abstraction and records an audit event.

The implementation should explicitly test the case where the invite email is
not the same as the accepting account's primary email.

## LMS Future Compatibility

The initial implementation should not implement Canvas/LTI/LMS integration, but
the invite model should not block it.

Design requirements for later LMS support:

- Course invite context can carry external course/user identifiers.
- The roster row can keep instructor/LMS-provided name and email independent of
  CoCalc account profile fields.
- Token redemption can bind a CoCalc account to an existing roster row.
- Later LMS import can create or update the same pending invite rows rather than
  creating a second identity system.
- The accepted account id remains the CoCalc identity used for project access.

This matches the long-term model where an external roster says "this student is
Alice in Canvas", while CoCalc records "this accepted CoCalc account is Alice's
runtime account for this course".

## Email Content Policy

Because invite-by-email lets users cause CoCalc to send email, content must be
constrained by trust level.

Low-trust/default users:

- No arbitrary URLs in invite text.
- No rich HTML supplied by the user.
- Short optional plain-text note only.
- Server-generated subject.
- Server-generated project/course description that avoids untrusted project
  title if the user is low trust.
- Include the inviter display name only if available and length-capped.
- Include the site name and fixed CoCalc invite language.

Trusted users / higher membership tiers / verified organizations:

- Higher invite volume.
- Longer custom message.
- Project or course title may be included after length cap and HTML escaping.
- Still no arbitrary HTML.
- URLs should remain restricted unless there is a deliberate high-trust policy.

Instructors:

- Need high recipient counts for classes.
- Should get tier-based or role-based limits that allow hundreds of course
  invites.
- Should still have constrained content because course invitation volume is
  exactly where email abuse can become expensive.

## Suggested Membership-Tier Limits

Exact numbers can be tuned, but the first implementation should expose these as
membership/tier parameters rather than constants:

- `invite_email_daily_count`
- `invite_email_hourly_count`
- `invite_email_recipients_per_batch`
- `invite_email_pending_per_project`
- `invite_email_pending_per_course`
- `invite_email_resend_cooldown_minutes`
- `invite_email_custom_message_max_chars`
- `invite_email_allow_project_title`
- `invite_email_allow_course_title`
- `invite_email_allow_urls`
- `invite_email_link_copy_enabled`
- `invite_email_send_enabled`
- `project_max_collaborators_and_pending_invites`
- `course_max_students_and_pending_invites`

Safe initial defaults:

- Free/default account: 10 token links per day, 5 per hour, 10 pending per
  project, no system-sent email by default, no URLs, 300 character note. The
  server should return a copyable invite link and tell the user to send it by
  their own email, LMS, chat, or other channel.
- Paid individual: 50 per day, 20 per hour, 50 pending per project, no URLs, 600
  character note.
- Instructor/course tier: 500 per day, 200 per hour, 500 pending per course, no
  URLs, 600 character note.
- Admin/system: configurable, audited, still not unlimited by default.

Additional global abuse controls:

- Per-IP creation rate limit.
- Per-target-email-hash rate limit.
- Per-project and per-course pending invite caps.
- Per-project cap on current collaborators plus pending invites. Inviting past
  the cap should fail with an actionable message to revoke a pending invite,
  remove a collaborator, or upgrade the sponsoring membership tier.
- Resend cooldown, e.g. 15 minutes.
- Reuse active pending invite for same inviter/project-or-course/email hash
  instead of generating unlimited fresh tokens.
- Expire pending token invites after 14 days by default.

## Invite Link Fallback UI

The inviter must be able to copy the redemption link.

The UI must treat email sending and invite creation as separate outcomes.
Creating the token invite should work even when the site cannot send email. The
backend response should include explicit delivery status so the frontend can
avoid misleading "email sent" messages.

Recommended response fields:

- `email_sent`: true only when the system actually accepted an outgoing email
  for delivery.
- `email_available`: false when the site has no configured/enabled email
  backend.
- `email_blocked_reason`: machine-readable reason such as
  `email_not_configured`, `tier_disallows_email`, `rate_limited`, or
  `cooldown`.
- `invite_url`: present whenever the caller is authorized to copy the link.
- `manual_delivery_required`: true when the invite exists but the inviter must
  send the link through another channel.

Launchpad special case:

- Launchpad deployments may intentionally have no email backend configured,
  especially during early onboarding for individuals and small work groups.
- In that case, project/course invite creation should still succeed and return a
  copyable invite link.
- The frontend should say something like: "Email is not configured for this
  site. To add this person, send them this invite link."
- This should not be treated as an error unless the caller explicitly requested
  "send email only" semantics.
- The same pattern applies to free-tier users when system-sent invite email is
  disabled by membership policy.

Project collaborator UI:

- Make "Invite by email" prominent.
- After creating the invite, show status and a "Copy invite link" button.
- Show "Email sent" or "Email not sent, copy this link manually" separately
  from invite creation.
- Show pending email invites in the outgoing invite list with revoke/resend/copy
  actions.

Course UI:

- Each student row with a pending email invite should show invite status.
- Instructor can copy the invite link per student.
- Bulk invite should show a summary and allow exporting/copying invite links for
  LMS/manual distribution if email delivery is unreliable.
- Resend should respect cooldown and reuse the active token unless explicitly
  rotating a revoked/expired invite.

## Multibay Routing

This touches accounts, collaborators, projects, and courses, so it must follow
the scalable architecture rules:

- Browser/account control-plane requests arrive at the caller's home bay.
- Project and course membership writes are authoritative on the project owning
  bay.
- Email token invite creation must resolve the project/course owning bay before
  writing invite state.
- Redemption may start from the accepting account's home bay, but must route to
  the invite/project owning bay for validation and membership/course writes.
- Project invite state that appears in account UI should be projected back to
  account home bays, as the current collab invite inbox already does.

For launchpad, this collapses to one bay but should use the same code paths.

## API Sketch

Project collaborator APIs:

- `createEmailProjectInvite({ project_id, email, message? })`
- `resendEmailInvite({ invite_id })`
- `revokeInvite({ invite_id })`
- `copyInviteLink({ invite_id })` or include link in list results for authorized
  inviters
- `redeemInviteToken({ invite_id, token })`

Course APIs:

- `createCourseStudentInvite({ course_project_id, course_path, student_id })`
- `bulkCreateCourseStudentInvites({ course_project_id, course_path, student_ids })`
- `redeemCourseStudentInvite({ invite_id, token })`

The project and course redemption APIs can share a common token validator and
dispatch by `scope`.

CLI requirements:

- `cocalc-cli` must be able to create an email token invite and print the
  redemption link without sending email.
- `cocalc-cli` should also support `--send-email` when the account/tier allows
  system-sent email.
- This enables scripts such as "create project, create invite link, send the
  link through an external workflow".
- CLI output must not imply whether the target email is a CoCalc account.

## Security Notes

- Invite token links are bearer credentials. They must be revocable, expiring,
  and audit logged.
- Copying invite links is necessary operationally, but the UI must explain the
  bearer-link risk.
- Email delivery must not reveal whether the target email belongs to a CoCalc
  account.
- Project/course titles in email can be attacker-controlled content. Include
  them only according to trust-tier policy and always length-cap and escape.
- The invite accepting account should be shown to the inviter after acceptance
  so a teacher/project owner can spot obvious mistakes.
- If the wrong person accepts a forwarded token, the mitigation is revoke/remove
  collaborator and issue a fresh invite.

## Migration Strategy

Phase 1: eliminate public enumeration paths.

- Remove or disable public HTTP account search.
- Ensure signed-in account search uses the Conat policy path.
- Do not use account search for email invites.

Phase 2: add email token invite infrastructure.

- Extend schema.
- Add token generation/validation helpers.
- Add rate-limit and tier-limit enforcement.
- Add server-generated email templates.
- Add audit events.

Phase 3: convert project email invites.

- Update `invite_collaborators_by_email` to create token invites.
- Return invite link and email-send status.
- Add outgoing invite copy/resend/revoke UI.
- Keep existing account-to-account invite flow for known related accounts.

Phase 4: convert course student invites.

- Create course-context token invites from student rows.
- Add per-student copy/resend/revoke/status UI.
- Implement redeem path that binds the accepting account to the course/student
  project using authoritative course/project routing.
- Test accepting with an account whose primary email does not match the roster
  email.

Phase 5: tighten search UI.

- Make "Invite by email" the encouraged path.
- Restrict collaborator account search to existing related accounts.
- Remove any UI wording that implies email lookup found or did not find an
  account.

Phase 6: LMS readiness.

- Add inert context fields for future LMS identifiers if needed.
- Document Canvas/LTI binding expectations before implementing LMS import.

## Implementation Status and Remaining Work (2026-05-20)

Implemented:

- Public unauthenticated account search has been removed from the HTTP API.
- Authenticated account-name resolution has input validation and a shared batch
  cap.
- Membership limits now include collaborator-plus-pending-invite caps and
  invite email/link quota fields.
- A built-in `instructor` membership tier template exists.
- Project email token invite creation supports normalized email dedupe, token
  hashing, encrypted token recovery, expiry, status tracking, and authorized
  link copy.
- Project invites handle the Launchpad/no-email-backend case by creating a
  manual-delivery invite link instead of failing or claiming email was sent.
- Pending project invites can be listed and revoked from the collaborator UI.
- Public `/invites/*` routing reaches the public shell.
- Token-only `/invites/<opaque-token>` URLs are generated and accepted.
- The central invite directory routes token preview and redemption without
  embedding project ids or invite ids in the URL.
- Email token redemption routes the project collaborator write through the
  project-owning bay.
- Email token accept checks account trust on the accepting account's home bay
  before forwarding the checked accept to the project-owning bay.
- Opening a token link while signed in previews the invite without adding a
  collaborator, then requires explicit Accept, Decline, or Block.
- Signed-in invite confirmation reminds the user which account will accept the
  invite and provides a sign-out path for switching accounts first.
- Decline and Block are implemented for email token invites; neither adds a
  collaborator.
- Course-scoped project invite redemption can bind the accepting account id
  through the student-project course metadata path.
- Full course invite creation and acceptance have been manually validated with
  email enabled.
- Course add-students UI uses email-first roster entry and copyable invite
  links.
- `cocalc-cli` has project invite commands for create, copy-link, redeem, list,
  accept, decline, block, revoke, blocks, and unblock.
- Manual-delivery project invite results are rendered as successful structured
  UI with copy-link buttons when email is unavailable or disabled.

Remaining before this plan is fully finished:

- Complete the remaining validation matrix below, including accepting a course
  invite with an account whose primary email differs from the roster email.
- Add abuse/admin observability for invite creation, email sends, copied links,
  accepts, revokes, expirations, and rate-limit denials.
- Keep site-license student/instructor pools in the separate plan:
  `src/.agents/site-license-seat-pools-approval-plan-2026-05-19.md`.

## Open Questions

- Should token links be included in ordinary invite list responses for inviters,
  or should copying require a separate fresh-auth action? ANS: yes; no fresh
  auth.
- Should resending reuse the same token until expiry, or rotate the token on
  each resend? Reuse is better for dedupe and LMS/manual sharing; rotation is
  better if an email was sent to the wrong address. ANS: reuse; user can cancel
  the invite, then send a new one if they want to ensure one token is
  invalidated.
- Is the student-project `course` field currently sufficient to bind
  `account_id` and let course sync update the `.course` row, or do we need a
  narrow course sync RPC? ANS: let's avoid this RPC if we can, since it will be
  complicated to implement, similar to codex/acp sync work.
- What membership tier names should map to instructor-scale invite limits? ANS:
  create a new "instructor" membership tier.
- Should organization-verified domains eventually increase invite limits or
  loosen email content restrictions? ANS: yes. If a user is at an org with a
  site license, we should trust them more.

## Recommended First Implementation Slice

Start with project email token invites, because they are simpler than course
redemption and immediately remove the most dangerous account lookup path.

The first slice should include:

- Public account search removal.
- Schema support for email token invites.
- Project email invite creation with constrained email template.
- Copy invite link for inviters.
- Token redemption that adds the accepting account as project collaborator.
- Rate limits and membership-tier parameters for invite count and content.

After that works, course invites can reuse the token infrastructure and add the
course-specific binding semantics.

## Detailed Implementation Plan

This section incorporates the review decisions above and is intended to be the
execution plan.

### Phase 0: Preflight Audit

Confirm current behavior before changing it:

- Enumerate all public and signed-in account search paths.
- Enumerate all project collaborator invite paths, including frontend,
  cocalc-cli, Conat, inter-bay, and legacy HTTP routes.
- Enumerate course invite paths, especially `invite_collaborators_by_email`
  calls from course student project configuration.
- Confirm whether student project `projects.course.account_id` is sufficient to
  reconcile the `.course` row without a new course sync RPC.
- Confirm the current membership template schema supports new usage-limit
  fields without a migration beyond template/default updates.

### Phase 1: Membership Limits and Instructor Tier

Add the missing quota knobs before enabling email-token invites broadly:

- Add `project_max_collaborators_and_pending_invites` to effective membership
  usage limits.
- Enforce it on account invites and email token invites.
- Count current project collaborators plus pending account/email/course invites
  for that project.
- Return an actionable error when the cap is reached: revoke pending invites,
  remove collaborators, or upgrade membership.
- Add invite email/link parameters to membership usage limits:
  `invite_email_send_enabled`, `invite_email_daily_count`,
  `invite_email_hourly_count`, `invite_email_recipients_per_batch`,
  `invite_email_pending_per_project`, `invite_email_pending_per_course`,
  `invite_email_resend_cooldown_minutes`,
  `invite_email_custom_message_max_chars`, `invite_email_allow_project_title`,
  `invite_email_allow_course_title`, `invite_email_allow_urls`, and
  `invite_email_link_copy_enabled`.
- Add `course_max_students_and_pending_invites` for course-scale enforcement.

Create a built-in `instructor` membership tier template between `member` and
`pro`.

Suggested starting values:

- `id`: `instructor`
- `label`: `Instructor`
- `store_visible`: true
- `course_store_visible`: false
- `priority`: between member and pro
- `price_monthly`: around 49
- `price_yearly`: around 49 \* 9
- `project_defaults.disk_quota`: 50000 MB
- `project_defaults.memory`: 8000 MB
- `project_defaults.cores`: 2
- `project_defaults.network`: 1
- `project_defaults.member_host`: 1
- `project_defaults.mintime`: 8 hours
- `max_projects`: substantially above member, e.g. 250
- `max_sponsored_running_projects`: between member and pro, e.g. 10
- `project_max_collaborators_and_pending_invites`: e.g. 250
- `course_max_students_and_pending_invites`: e.g. 500
- `invite_email_send_enabled`: true
- `invite_email_daily_count`: 500
- `invite_email_hourly_count`: 200
- `invite_email_recipients_per_batch`: 200
- `invite_email_pending_per_course`: 500
- `invite_email_pending_per_project`: 250
- `invite_email_custom_message_max_chars`: 600
- `invite_email_allow_urls`: false
- `invite_email_allow_project_title`: true
- `invite_email_allow_course_title`: true
- Blob/rootfs/ACP limits should be between member and pro, but biased toward
  high project count and storage rather than high host-creation power.

Site-license follow-up:

- Site licenses need separate student and instructor pools, not one membership
  class for every verified-domain user.
- Model package metadata as two seat pools: student cap and instructor cap.
- Students can self-claim automatically up to the student cap.
- Instructor claims require manual approval by site admins or delegated
  organization approvers.
- Organization-verified instructor approval can raise invite/email limits, but
  this should be explicit and audited.

### Phase 2: Schema and Token Infrastructure

Extend the invite data model:

- Add source/scope fields for account, email, and course email invites.
- Allow null `invitee_account_id` for email-token invites.
- Add `accepted_account_id`, `email_hash`, `email_ciphertext`, `token_hash`,
  `token_ciphertext`, `token_hint`, `expires`, `last_sent`, `resend_count`, and
  `context`.
- Add indexes for pending invite lookup by project, inviter, status, email hash,
  and expiry.
- Add maintenance to expire pending invites.

Implement token helpers:

- Normalize email addresses consistently.
- Compute HMAC email hashes for dedupe/rate limits.
- Generate random invite tokens.
- Hash tokens for redemption.
- Encrypt token material for authorized copy/resend/CLI/email rendering.
- Redact tokens from logs and errors.
- Add tests that plaintext tokens do not appear in serialized invite rows,
  audit rows, or logger calls.

Email queue handling:

- If email is queued asynchronously, the queue must either receive the plaintext
  token only in process memory or store an encrypted invite id reference that the
  worker resolves.
- Do not store plaintext token in queue payloads.
- Prefer queue payload `{ invite_id, template }`; the worker decrypts
  `token_ciphertext` only when rendering the outgoing email.

### Phase 3: Project Email Token Invites

Implement project email token invite creation:

- Require signed-in caller.
- Require project collaborator/admin permission to invite.
- Enforce collaborator-plus-pending-invite cap.
- Enforce membership invite limits and email-send permission.
- Create or reuse a pending invite for the same project, inviter, email hash,
  and scope.
- Return the invite row and invite link to authorized inviters.
- If the tier does not allow system-sent email, return the link with a clear
  message that the inviter must send it externally.
- If no site email backend is configured or enabled, return the link with
  `email_available=false` and `manual_delivery_required=true`; do not fail
  invite creation.
- If the tier allows email, enqueue a constrained email and still return the
  link for fallback.

Implement redemption:

- Public route accepts `invite_id` and token.
- If the user is not signed in, redirect through sign-in/create-account and
  resume redemption.
- If the user is signed in, show an invite preview/confirmation page first. This
  page validates enough state to display safe details but must not mutate
  membership.
- Provide Accept, Decline, and Block actions. Accept calls the final redemption
  action; Decline and Block must not add a collaborator.
- Validate status, expiry, hash, project ownership, and revocation.
- Route membership write to the project owning bay.
- Add the accepting account as collaborator only after Accept.
- Store `accepted_account_id`, `responded`, and status `accepted`.
- Project the resulting invite state to relevant home bays.

Convert existing frontend project email invite UI:

- Make "Invite by email" the primary path for unknown people.
- Stop presenting email search as account discovery.
- Show copy-link action after invite creation.
- Show outgoing pending email invites with copy, resend, revoke, and status.
- Keep account-to-account invites for already-related accounts.

### Phase 4: cocalc-cli Support

Add CLI commands after the server API is stable:

- Create project invite link without sending email.
- Optionally send email when allowed by membership tier.
- Print machine-readable JSON with project id, invite id, expires, and invite
  URL.
- Never reveal whether the target email maps to an existing account.

Example shape:

```text
cocalc project invite create --project <project_id> --email user@example.com --json
cocalc project invite create --project <project_id> --email user@example.com --send-email
cocalc project invite revoke --project <project_id> --invite <invite_id>
```

The exact command namespace should match existing CLI conventions.

### Phase 5: Account Search Lockdown

Remove the public HTTP account search route.

For signed-in search:

- Route through one policy implementation.
- Allow admin exact lookup.
- Allow normal users to search only related accounts.
- Keep account-id-to-name display helpers for historical project/course
  contexts.
- Update tests to prove unauthenticated HTTP callers cannot search names,
  emails, or UUIDs.

### Phase 6: Course Email Token Invites

Implement course invite creation using the same token infrastructure:

- Instructor selects or bulk-invites course student rows.
- For each row, create/reuse a course email token invite with course context.
- Respect course/instructor membership limits.
- Email is optional according to tier; copyable links are always available to
  authorized instructors.
- Add per-student invite status, copy, resend, revoke, and accepted-account UI.

Implement course redemption:

- Validate invite token as in project redemption.
- Route to the owning bay for the course/student project.
- Add the accepting account to the student project.
- Prefer updating the student project `course` field with the accepted
  `account_id`, then let existing course sync reconcile the `.course` row.
- Only add a dedicated course sync RPC if the project `course` field path cannot
  reliably update the roster.
- Add shared-project collaboration if course settings require it.
- Record accepted account id on the invite.

Course tests:

- Student accepts with an account whose primary email differs from the roster
  email.
- Instructor can copy a link when email sending is disabled.
- Revoke prevents a copied link from working.
- Reuse/resend keeps the same token until revocation or expiry.
- Collaborator-plus-pending cap includes course pending invites.

### Phase 7: Site License Instructor Approval

Plan this after basic token invites are live, but do not ignore it:

- Extend site license package metadata to include student and instructor pools.
- Let verified-domain users self-select student or instructor intent.
- Auto-approve student claims up to the student cap.
- Queue instructor claims for approval by admins or delegated organization
  approvers.
- Apply instructor membership limits only after approval.
- Audit approvals and revocations.

This solves the current site-license flaw where everyone at a domain receives
the same membership class despite very different abuse and resource profiles.

### Phase 8: Cleanup and Hardening

After project and course token invites work:

- Remove old non-token email invite behavior.
- Remove or disable any remaining exact email account lookup in normal invite
  flows.
- Ensure all invite emails use server templates and tier-gated content.
- Add maintenance jobs for expired invites and old encrypted token cleanup.
- Add admin views for invite abuse investigation: inviter, project, target email
  hash, status, counts, and timestamps, without casually exposing plaintext
  target emails.
- Add metrics for created invites, sent emails, copied links, accepted invites,
  revoked invites, expired invites, and rate-limit denials.

### Phase 9: Validation Matrix

Required tests before release:

- Free user can create a copyable invite link but cannot send system email.
- Free user hits project collaborator-plus-pending-invite cap.
- Member user can send allowed volume of constrained emails.
- Instructor user can bulk-create hundreds of course invites within limits.
- Project owner can revoke a pending copied invite link.
- Visiting a valid token link while signed in shows a confirmation page and
  does not add the account until Accept is clicked.
- Declining a valid token link does not add the account and prevents accidental
  acceptance through that response path.
- Blocking a token invite does not add the account and suppresses future invite
  prompts from the blocked source according to the internal invite-block model.
- Redeeming with a different account email succeeds.
- Redeeming an expired, revoked, or rotated token fails.
- Public account search is gone.
- CLI can create a project, create an invite link, and output JSON for
  automation.
- Multibay route tests cover creation on home bay and redemption/write on
  project owning bay.
