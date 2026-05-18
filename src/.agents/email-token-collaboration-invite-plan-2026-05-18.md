# Email Token Collaboration Invite Plan

Date: 2026-05-18

Status: design plan for review, not yet implemented.

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
- Invite links must be visible to the inviter so they can be copied into Canvas,
  Slack, LMS announcements, or other channels when email delivery fails.
- Email content must be constrained for low-trust users because this feature
  lets users cause CoCalc to send email.
- Throttling and content limits must be membership-tier parameters.

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
- Store only a keyed or slow hash of the token.
- Include `invite_id` in the URL for lookup, but validate using `token_hash`.
- Do not store plaintext token in Postgres logs, events, or audit entries.

## URL Shape

Use a stable route such as:

```text
/invites/project/<invite_id>?token=<secret>
```

or:

```text
/invites/redeem?invite_id=<invite_id>&token=<secret>
```

The URL should be safe to copy from the inviter UI. Because it is a bearer
capability, the UI must label it clearly:

```text
Anyone with this link can accept the invite until it expires or is revoked.
```

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
- Server validates `invite_id`, token, status, expiry, and revocation.
- Server resolves the project owning bay and performs the collaborator write on
  the owning bay.
- Server adds the accepting account as a collaborator.
- Server stores `accepted_account_id`, `responded`, and status `accepted`.
- Server projects invite state back to the inviter and accepting account home
  bays as needed.

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

Safe initial defaults:

- Free/default account: 10 per day, 5 per hour, 10 pending per project, no URLs,
  300 character note.
- Paid individual: 50 per day, 20 per hour, 50 pending per project, no URLs, 600
  character note.
- Instructor/course tier: 500 per day, 200 per hour, 500 pending per course, no
  URLs, 600 character note.
- Admin/system: configurable, audited, still not unlimited by default.

Additional global abuse controls:

- Per-IP creation rate limit.
- Per-target-email-hash rate limit.
- Per-project and per-course pending invite caps.
- Resend cooldown, e.g. 15 minutes.
- Reuse active pending invite for same inviter/project-or-course/email hash
  instead of generating unlimited fresh tokens.
- Expire pending token invites after 14 days by default.

## Invite Link Fallback UI

The inviter must be able to copy the redemption link.

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

## Open Questions

- Should token links be included in ordinary invite list responses for inviters,
  or should copying require a separate fresh-auth action?
- Should resending reuse the same token until expiry, or rotate the token on
  each resend? Reuse is better for dedupe and LMS/manual sharing; rotation is
  better if an email was sent to the wrong address.
- Is the student-project `course` field currently sufficient to bind
  `account_id` and let course sync update the `.course` row, or do we need a
  narrow course sync RPC?
- What membership tier names should map to instructor-scale invite limits?
- Should organization-verified domains eventually increase invite limits or
  loosen email content restrictions?

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
