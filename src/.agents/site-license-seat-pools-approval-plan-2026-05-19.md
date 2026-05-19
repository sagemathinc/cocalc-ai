# Site-License Seat Pools and Approval Plan

Date: 2026-05-19

Status: design spec. Do not implement until the email-token collaboration
invite work is fully finished and validated.

## Problem

CoCalc site licensing needs to support real academic and enterprise deals where
one organization has at least two classes of users:

- a broad, low-risk student or baseline user population
- a smaller, higher-trust instructor/faculty/admin population with higher
  resource limits and higher abuse potential

The current site-license model is effectively one pool:

- a set of verified email domains
- one seat cap
- one membership tier

That is not enough for campus licenses. A university may buy, for example,
5000 student seats and 200 instructor seats. Those seats should have different
tiers, different limits, and different claim/approval rules.

This directly affects project invites and course workflows. Instructors need
larger project, collaborator, and email-invite quotas; students should not get
the same mass-email or course-management capabilities just because they have an
institutional email address.

## Existing Primitive

The current code already has a useful primitive:

- `membership_packages.kind = "site"`
- `membership_packages.membership_class`
- `membership_packages.seat_count`
- domain policy stored in package `metadata`
- claim logic based on verified email domains
- `membership_claim_scopes` / `membership_claim_identities` to prevent one
  institutional identity from claiming multiple seats via email variants

The new design should build on this. We should not introduce a separate
entitlement engine.

## Recommended External Model

From the outside, an organization should see a single site license with one or
more named pools:

```ts
type SiteLicensePool = {
  name: string;                 // e.g. "Students", "Instructors"
  membership_class: string;     // e.g. "student", "instructor"
  seat_count: number;
  requires_approval: boolean;
  inactivity_timeout_days?: number;
};
```

Example:

- `Students`: 5000 seats, `student` tier, no approval
- `Instructors`: 200 seats, `instructor` tier, approval required

The organization should not have to understand package rows, assignment rows,
grant rows, or bay routing.

## Key Design Decision: Explicit Managers

Site-license management should use an explicit list of manager accounts
attached to the site license.

Do not infer manager privileges from membership tier.

Reasons:

- A membership tier is an entitlement. It should answer "what resources does
  this account get?", not "what administrative authority does this account
  have?".
- Approval authority is organizational delegation and should be auditable.
- A campus may have IT staff who are not instructors but should approve
  instructor requests.
- Some instructors should not be able to approve other instructors.
- Explicit managers are easier to explain: "these people manage this license."

Recommended manager roles:

- `owner`: can edit pools, domains, caps, managers, and approval policies
- `manager`: can approve/reject requests, revoke seats, and view usage
- `viewer`: can view usage and export reports but cannot change state

Bootstrap:

- CoCalc admins create the site license and add the first `owner` manager.
- Site-license owners can add/remove managers for their own license.

## Data Model

### Site License Group

Add a logical site-license group. This can be a new table, or initially metadata
shared by multiple package rows. A real table is clearer for admin UI and
auditing.

Suggested table: `site_licenses`

Fields:

- `id`
- `name`
- `organization_name`
- `owner_account_id`
- `allowed_domains`
- `starts_at`
- `expires_at`
- `metadata`
- `created`
- `updated`

Multibay authority:

- The license should live on the owner account's home bay.
- Claim and approval operations must route to the authoritative bay for the
  site license/package.
- Launchpad is the one-bay special case.

### Seat Pools

Use `membership_packages` as the concrete seat-pool rows.

For each pool:

- `kind = "site"`
- `membership_class = <pool tier>`
- `seat_count = <pool cap>`
- `metadata.site_license_id = <site license id>`
- `metadata.pool_name = "Students" | "Instructors" | ...`
- `metadata.requires_approval = boolean`
- `metadata.inactivity_timeout_days = number | undefined`
- `metadata.allowed_domains = string[]`
- `starts_at` / `expires_at` inherited from, or constrained by, the site
  license

This keeps grants, assignments, package claims, billing integration, and
effective membership resolution tied to the existing package system.

### Managers

Suggested table: `site_license_managers`

Fields:

- `id`
- `site_license_id`
- `account_id`
- `role`: `owner | manager | viewer`
- `created_by_account_id`
- `created`
- `revoked_at`
- `metadata`

Rules:

- Only active managers for a site license can see its management dashboard.
- Manager actions are scoped to that site license.
- Every manager change is audited.

### Approval Requests

Suggested table: `site_license_pool_requests`

Fields:

- `id`
- `site_license_id`
- `package_id`
- `account_id`
- `matched_email_address`
- `canonical_identity`
- `requested_membership_class`
- `state`: `pending | approved | rejected | canceled | expired`
- `requester_note`
- `reviewer_account_id`
- `review_note`
- `requested_at`
- `reviewed_at`
- `expires_at`
- `metadata`

Rules:

- At most one active pending request per account per site-license pool.
- At most one active pending request per canonical institutional identity per
  site-license pool.
- Pending requests should not consume seats by default.
- Approval must recheck cap availability before creating the grant.
- Rejection should be final for the specific request but allow a new request
  after a cooldown or manager reset.

## Claim and Approval Flow

### Student / Baseline Pool

For a pool where `requires_approval = false`:

1. User verifies an email address at an allowed domain.
2. The claimable-membership API returns the pool as claimable if seats are
   available.
3. User claims the seat.
4. The existing package assignment and membership grant machinery creates the
   grant.
5. The canonical institutional identity prevents duplicate claims via email
   aliases or plus addressing.

Policy choice:

- For a single unambiguous baseline pool, auto-claiming on sign-in is
  reasonable, but a visible "Claim your University membership" button is less
  surprising.
- Start with explicit claim. Add auto-claim later only if the UX demands it.

### Instructor / Higher-Trust Pool

For a pool where `requires_approval = true`:

1. User verifies an email address at an allowed domain.
2. The UI shows "Request instructor access" rather than "Claim".
3. User submits a short request.
4. Site-license managers receive a notification/email.
5. A manager reviews and approves or rejects.
6. Approval creates the package assignment and membership grant if seats are
   still available.
7. Rejection records a reason visible to the requester.

Suggested request form fields:

- role/title
- department or unit
- course(s) or intended use
- expected number of students
- academic term
- optional note

Keep the form lightweight. Do not require uploads or sensitive documents in the
first implementation.

## User-Facing Manager Dashboard

Managers need a scoped dashboard for their site license.

Overview:

- organization name
- verified domains
- license expiration
- pool list with tier, cap, active seats, available seats, pending requests
- recent activity

Pending requests:

- requester name
- verified institutional email
- account age
- last active time
- requested pool/tier
- requester note
- approve/reject controls

Seat management:

- active users by pool
- search by name/email/account id
- revoke seat
- export CSV
- inactive-seat candidates

Audit:

- approvals
- rejections
- revocations
- manager changes
- pool/cap/domain changes

## Inactivity Release

Site-license seats should be reclaimable because academic populations change.

Do not immediately revoke seats on inactivity.

Recommended model:

1. A seat becomes an inactive candidate after `inactivity_timeout_days`.
2. The user and managers are notified.
3. A grace period starts, e.g. 30 days.
4. Managers can pin/extend the seat.
5. If no action occurs, the grant and claim identity are revoked/released.

Recommended defaults:

- Student pool: 365 inactive days, 30-day grace.
- Instructor pool: 540 inactive days, manager-reviewed release.

Use account-level activity first. Project-level or course-level activity can be
added later.

## Multiple Pools for One User

Default policy:

- One active site-license pool per site license per account.
- Higher-trust pools supersede lower-trust pools.

Example:

- A user first claims a student seat.
- The same user later receives instructor approval.
- The instructor grant becomes active.
- The student package assignment for the same site license is revoked or
  marked superseded.

This is simpler to explain and avoids double-counting seats.

If implementation pressure is high, an acceptable first implementation is:

- allow both grants to exist
- make effective membership resolution choose the higher tier
- still report the lower grant as superseded in manager UI

But the long-term model should avoid consuming two seats for one person in the
same site license.

## Project Invite and Course Implications

Effective membership should drive invite limits:

- Free/student: low collaborator caps, no or very limited system-sent invite
  email.
- Instructor: high course/project/collaborator quotas, higher invite email
  limits, course roster workflows.
- Pro/admin: separate from site-license instructor status.

This lets project invite safety depend on the organization's approval process:

- Anyone with a university email can get baseline resources.
- Only approved instructors get mass-invite/course-send capability.

## Security and Abuse Controls

Controls required from the start:

- No public account search or email enumeration is needed for site-license
  claims.
- Domain-based eligibility requires a verified email address.
- Approval-required pools never auto-grant from email domain alone.
- Manager actions are license-scoped and audited.
- Request creation is rate-limited per account, canonical identity, and site
  license.
- Pending request count is capped.
- Approval rechecks cap availability.
- Revoking a grant also releases or revokes the claim identity.
- Managers cannot approve themselves unless they already have `owner` role or
  a CoCalc admin explicitly allows it.

## APIs

User-facing APIs:

- list site-license pools claimable or requestable by the current account
- claim a no-approval pool
- request approval for an approval-required pool
- view my request status
- cancel my pending request

Manager APIs:

- list managed site licenses
- get license overview
- list pending requests
- approve request
- reject request
- list active seats
- revoke seat
- list/add/remove managers, owner-only
- export usage CSV

Admin APIs:

- create site license
- update domains
- create/update pool
- set pool cap
- set pool approval policy
- set inactivity timeout
- add initial owner manager

CLI:

- `cocalc membership site-license list`
- `cocalc membership site-license create`
- `cocalc membership site-license pool add`
- `cocalc membership site-license manager add`
- `cocalc membership site-license requests`
- `cocalc membership site-license approve`
- `cocalc membership site-license reject`

The CLI matters for enterprise onboarding, migrations, and scripted demos.

## Implementation Phases

### Phase 1: Schema and Types

- Add `site_licenses`.
- Add `site_license_managers`.
- Add `site_license_pool_requests`.
- Extend site-package metadata typing for:
  - `site_license_id`
  - `pool_name`
  - `requires_approval`
  - `inactivity_timeout_days`
  - `allowed_domains`
- Add shared TypeScript types in `@cocalc/util`.

### Phase 2: Admin Provisioning

- Extend existing site-package provisioning to create a site license plus one
  or more pool packages.
- Keep backward compatibility for existing single-pool `kind = "site"` package
  rows by treating each as a one-pool site license.
- Add admin API/CLI commands for creating pools and managers.

### Phase 3: Claimable and Requestable User Flow

- Update claimable-membership APIs to return:
  - immediately claimable pools
  - approval-required requestable pools
  - existing request status
- Keep existing no-approval claim path for baseline pools.
- Add request creation for approval-required pools.

### Phase 4: Manager Dashboard and Approval Flow

- Add manager-scoped APIs.
- Add manager dashboard.
- Add notifications for new requests and review outcomes.
- Approval creates assignment and grant through existing membership package
  machinery.
- Rejection records review state and reason.

### Phase 5: Seat Reconciliation

- Enforce one active pool per account per site license.
- Decide whether instructor approval revokes or supersedes student seat.
- Add reporting so managers can see superseded/revoked seats.

### Phase 6: Inactivity Release

- Add inactive-candidate query.
- Add notification/grace workflow.
- Add manager pin/extend controls.
- Add scheduled release job.

### Phase 7: Invite Limit Integration

- Define resource limits for the new `instructor` tier.
- Make project invite email quotas and collaborator caps depend on effective
  membership.
- Ensure course workflows use instructor limits.

### Phase 8: Tests and Validation

- Unit tests for claimable/requestable pool logic.
- Unit tests for approval/rejection and cap rechecks.
- Unit tests for canonical identity duplicate prevention.
- Unit tests for one-active-pool/supersede behavior.
- Inter-bay tests for license/package authority routing.
- Browser smoke test for:
  - student claim
  - instructor request
  - manager approval
  - effective tier upgrade
  - invite quota change

## Suggested Defaults

Student pool:

- tier: `student`
- requires approval: `false`
- inactivity timeout: 365 days
- invite email: disabled or very low
- collaborator/project caps: modest

Instructor pool:

- tier: `instructor`
- requires approval: `true`
- inactivity timeout: 540 days
- invite email: enabled with course-aware limits
- collaborator/project caps: higher than `member`, lower than `pro` unless the
  deal says otherwise

Request policy:

- one pending instructor request per account per site license
- one pending instructor request per canonical institutional identity per site
  license
- pending request expires after 30 days
- rejected request cooldown: 7 days unless manager resets it

Manager policy:

- explicit manager list
- CoCalc admin bootstraps first owner
- owners can delegate manager/viewer roles
- all manager actions audited

## Open Questions

- Should baseline student seats be auto-claimed on sign-in, or always require a
  click?
- Should pending approval requests reserve instructor seats?
- Should manager owners be allowed to approve their own instructor request?
- Should inactive release use account activity only, or also project/course
  activity?
- Should organization-verified SSO attributes eventually drive automatic
  instructor eligibility?

## Recommendation

Implement the first version with:

- explicit site-license managers
- one or more site-package-backed pools per site license
- auto-claimable baseline pool
- approval-required instructor pool
- no pending-seat reservation
- one active pool per account per site license
- account-activity-based inactivity candidates, with manager review before
  release

This is the least confusing model for campus admins, preserves the existing
membership package machinery, and gives CoCalc the trust boundary needed for
course/project invite limits.
