# Site-License Seat Pools and Approval Plan

Date: 2026-05-19

Status: implementation started. Email-token collaboration invites are
functionally complete as of 2026-05-20, with remaining work limited to edge-case
validation and observability. This site-license plan is now the next major
implementation track.

## Problem

CoCalc site licensing needs to support real academic and enterprise deals where
one organization has multiple classes of users:

- a broad, low-risk student or baseline user population
- a smaller, higher-trust instructor/faculty/admin population with higher
  resource limits and higher abuse potential
- a research population with different compute, storage, and network
  expectations from both students and instructors

The current site-license model is effectively one pool:

- a set of verified email domains
- one seat cap
- one membership tier

That is not enough for campus licenses. A university may buy, for example,
5000 student seats, 200 instructor seats, and 500 researcher seats. Those seats
should have different tiers, different limits, and different claim/approval
rules.

This directly affects project invites and course workflows. Instructors need
larger project, collaborator, and email-invite quotas; students should not get
the same mass-email or course-management capabilities just because they have an
institutional email address.

## Go-To-Market Framing

The first version should support a low-friction expansion path that feels
normal to campus departments and procurement:

1. A department already paying for CoCalc receives a broader campus-wide trial
   or first-year site license at a compelling price.
2. The first-year license uses verified institutional email domains as a simple
   onboarding mechanism. This should be described as "domain-based onboarding",
   not as strong identity proof.
3. If the license becomes popular across campus, the renewal conversation moves
   to procurement/IT with negotiated terms, custom policy links, SOC-2/security
   review, formal seat caps, and SSO integration.
4. SSO affiliation becomes the stronger long-term verification mechanism once
   the license is formalized.

This is viable because it minimizes year-one friction while creating a clear
upgrade path to the more standard enterprise model.

Language matters. User and licensee-facing copy should avoid sounding like
CoCalc is policing affiliation. Preferred framing:

> Your institution funds this membership for currently affiliated users.
> CoCalc periodically confirms eligibility using the verification method
> configured by your institution.

Avoid harsh words like "revoked" in user-facing messages. Prefer:

- "institution-funded membership ended"
- "seat released"
- "university membership no longer applies"
- "your CoCalc account and projects remain available"

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
  name: string; // e.g. "Students", "Instructors"
  membership_class: string; // e.g. "student", "instructor"
  seat_count: number;
  requires_approval: boolean;
  verification_policy: "email-domain" | "sso-affiliation" | "manager-approval";
  exclusive_group?: string; // e.g. "teaching", "research"; defaults to tier
  affiliation_reverification_days?: number;
  affiliation_reverification_grace_days?: number;
};
```

Example:

- `Students`: 5000 seats, `student` tier, no approval
- `Instructors`: 200 seats, `instructor` tier, approval required
- `Researchers`: 500 seats, `researcher` tier, approval required or SSO-backed
  eligibility

`exclusive_group` controls deduplication and upgrade behavior. For example,
`Students` and `Instructors` should usually share `exclusive_group =
"teaching"`, so instructor approval releases a lower student teaching seat.
`Researchers` should use `exclusive_group = "research"`, so a professor can
hold a teaching seat and a research seat, potentially on separate CoCalc
accounts using plus-address aliases.

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
- `custom_terms_url`
- `custom_policy_url`
- `terms_version_label`
- `renewal_policy`
- `overage_policy`
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
- `metadata.pool_name = "Students" | "Instructors" | "Researchers" | ...`
- `metadata.requires_approval = boolean`
- `metadata.verification_policy = "email-domain" | "sso-affiliation" | "manager-approval"`
- `metadata.exclusive_group = "teaching" | "research" | ...`
- `metadata.affiliation_reverification_days = number | undefined`
- `metadata.affiliation_reverification_grace_days = number | undefined`
- `metadata.allowed_domains = string[]`
- `metadata.claim_scope_key = "site-license:<id>:group:<exclusive_group>"`
- `metadata.claim_scope_kind = "site-license-exclusive-group"`
- `starts_at` / `expires_at` inherited from, or constrained by, the site
  license

This keeps grants, assignments, package claims, billing integration, and
effective membership resolution tied to the existing package system.

### Custom Terms and Policies

Some organizations require users to see negotiated site-specific terms or
policies before accepting institution-funded membership.

Support optional URLs on the site license:

- `custom_terms_url`
- `custom_policy_url`

If configured, the claim/request UI should show links before the user claims a
student seat or submits an instructor request. The user must explicitly accept
that they reviewed the linked terms/policies before the site-license membership
is granted or requested.

Rules:

- CoCalc hosts only the link and acceptance record, not the custom legal text.
- Accepted terms should be recorded in grant/request metadata with URL and
  timestamp.
- Updating a custom URL should not silently invalidate existing grants in the
  first implementation. If an organization needs re-acceptance, add that as an
  explicit later policy.
- The acceptance record should include account id, URL, version label if
  configured, timestamp, and request metadata such as IP/user agent if already
  available in the surrounding request context.

## Contract Term, Renewal, and Overage

Procurement and IT will expect normal contract-term behavior.

Default model:

- A site license has `starts_at` and `expires_at`.
- Every pool is constrained by the site-license term.
- Renewing a license extends the site license and its pool packages.
- If the license is renewed before expiration, existing active grants continue
  without user action unless a pool's verification policy requires
  reverification.
- If the whole license expires and is not renewed, institution-funded
  memberships end after the configured license-expiration grace period.
- Regular CoCalc accounts and projects remain available after site-license
  membership ends.

Negotiable parameters:

- site-license term dates
- pool caps
- pool tiers and resource limits
- verification policy per pool
- reverification interval and grace period
- license-expiration grace period
- overage behavior

Recommended first overage policy:

- Use hard caps for self-service claiming and instructor approval.
- Expose clear counts for active, pending-reverification, pending-approval, and
  available seats.
- If an organization wants soft overages or true-up billing, treat that as an
  explicit negotiated `overage_policy` later.

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

- At most one active pending request per account per site-license exclusive
  group.
- At most one active pending request per canonical institutional identity per
  site-license exclusive group.
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

- For a single unambiguous baseline pool, auto-claiming after verified
  eligibility is technically possible, but a visible "Claim your University
  membership" button is less surprising.
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
- custom terms/policy links, if configured
- license expiration
- pool list with tier, cap, active seats, available seats, pending requests
- active, pending-reverification, and recently released seat counts
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
- aggregate affiliation-reverification status and recent releases
- role source for each seat, e.g. domain claim, manager approval, or SSO
  assertion

Audit:

- approvals
- rejections
- revocations
- manager changes
- pool/cap/domain changes
- custom terms/policy URL changes

## Verification Policies

Each pool has a `verification_policy`.

Supported policies:

- `email-domain`: the user must verify an email address at an allowed domain.
- `sso-affiliation`: the user must sign in through an organization SSO flow
  that asserts current affiliation or role.
- `manager-approval`: a delegated site-license manager must approve the user.

The first implementation can support `email-domain` and `manager-approval`.
The important design point is that `sso-affiliation` is built into the model
now, because email-domain control is not always a reliable affiliation signal.
Some universities provide alumni email access or lifetime forwarding, so SSO
affiliation is the stronger long-term proof.

Policies can be combined at the pool level by using both `requires_approval`
and `verification_policy`:

- Student year-one default: `verification_policy = "email-domain"`,
  `requires_approval = false`.
- Instructor year-one default: `verification_policy = "email-domain"`,
  `requires_approval = true`.
- Future stricter instructor default: `verification_policy =
"sso-affiliation"` plus approval, or SSO role assertion without manager
  approval if the organization provides reliable role data.

## Fresh Affiliation Verification

Site-license seats should be reclaimable because academic populations change.
The important signal is not whether the CoCalc account is active. The important
signal is whether the user still controls a verified email address at the
licensed institution, or has an equivalent current SSO affiliation assertion.

This replaces a generic inactivity-release system. A user who still wants the
site-license membership must periodically renew their institutional
affiliation.

Recommended model:

1. A site-license grant stores `affiliation_verified_at` and the verified
   institutional email or SSO subject that established eligibility.
   It also stores the `verification_policy` that was satisfied.
2. After `affiliation_reverification_days`, the seat enters
   `pending_affiliation_reverification`.
3. The user is notified by email/in-app notification: "Re-verify your
   institutional email to continue this membership."
4. A grace period starts, e.g. 30 days. The user gets warning notifications at
   the start of the grace period, about 14 days before release, about 3 days
   before release, and after release.
5. If the user re-satisfies the pool's verification policy, the pending
   release is canceled and `affiliation_verified_at` is updated.
6. If the user does not re-verify during the grace period, the site-license
   grant and claim identity are revoked/released.
7. Managers can see aggregate status and recent releases, but are not expected
   to review individual users.

Recommended defaults:

- Student pool: reverify every 180 days, 30-day grace.
- Instructor pool: reverify every 365 days, 45-day grace.
- SSO-backed pool: a fresh SSO assertion that includes current institutional
  affiliation satisfies reverification automatically.

Seats in the grace period still count against the pool cap. Manager dashboards
should expose active, pending-reverification, and recently released counts so
licensees understand why seats are temporarily unavailable.

Regular CoCalc account access is unaffected. Only the site-license membership
is released if affiliation cannot be reverified.

## Multiple Pools for One User

Default policy:

- One active site-license pool per site license per account.
- Higher-trust pools replace lower-trust pools.

Example:

- A user first claims a student seat.
- The same user later receives instructor approval.
- The instructor grant becomes active.
- The student package assignment for the same site license is revoked.

This is simpler to explain and avoids double-counting seats.

If implementation pressure is high, an acceptable temporary implementation is:

- allow both grants to exist
- make effective membership resolution choose the higher tier
- still report the lower grant as temporarily ignored in manager UI

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
- Site-license seats require periodic fresh affiliation verification.
- Reverification emails are rate-limited per account, email, and site license,
  and contain no user-controlled content.
- Reverification must require a current CoCalc login plus proof of the
  institutional email or SSO affiliation. Email-token proof alone must not
  silently transfer a site-license seat to a different signed-in account.
- Manager actions are license-scoped and audited.
- Request creation is rate-limited per account, canonical identity, and site
  license.
- Pending request count is capped.
- Approval rechecks cap availability.
- Revoking a grant also releases or revokes the claim identity.
- Managers cannot approve themselves unless they already have `owner` role or
  a CoCalc admin explicitly allows it.
- If the user changes their primary CoCalc email, that does not reset
  affiliation verification unless they verify an allowed-domain email or
  satisfy the pool's SSO policy.
- Downgrade/release messages should be clear: the CoCalc account and projects
  remain available, but the institution-funded membership no longer applies.

## Licensee-Facing Policy Summary

Each site-license manager dashboard should show a plain policy summary:

- domains covered
- site-license term dates and renewal status
- pool caps and tiers
- active, pending approval, pending reverification, recently released, and
  available seat counts
- verification policy per pool
- reverification interval and grace period per pool
- whether approval is required
- custom terms/policy URLs
- overage policy
- warning cadence before seat release
- whether SSO is configured and what attributes satisfy affiliation

This avoids surprises and makes the rules visible to the licensee before
students or instructors hit them.

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
- update custom terms/policy URLs
- update term dates, renewal status, and overage policy
- create/update pool
- set pool cap
- set pool approval policy
- set pool verification policy
- set affiliation reverification interval and grace period
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

### Phase 1 Vertical Slice: Ship the Core Invariant

The first implementation should be a small complete path, not the whole
procurement/admin surface. It should prove the core invariant:

> A site license has named seat pools; users claim or request exactly one
> appropriate pool; approval-required pools are reviewed by delegated managers;
> grants are auditable, revocable, and reflected in effective membership.

Scope:

- [x] Add the `site_licenses`, `site_license_managers`, and
      `site_license_pool_requests` schema.
- [x] Represent pools as `membership_packages.kind = "site"` rows linked by
      `metadata.site_license_id`.
- [x] Add shared TypeScript types for site licenses, managers, pools, requests,
      verification policy, terms links, and overage/renewal policy.
- [x] Add admin API provisioning for one site license with one or more pools,
      e.g. `Students`, `Instructors`, and `Researchers`.
- [x] Add CLI commands for provisioning, overview, requesting, and reviewing.
- [x] Route site-license provisioning, overview, request, and review APIs to the
      site-license owner's home bay, with requester verified emails collected on
      the requester home bay.
- [x] Add an explicit manager list with `owner`, `manager`, and `viewer` roles.
- [x] Keep baseline student claim as explicit click-to-claim using verified
      institutional email and current package assignment machinery.
- [x] Add instructor request creation for approval-required pools.
- [x] Add manager approval/rejection APIs that recheck cap availability and create
      the package assignment/grant through existing membership package machinery.
- [x] Enforce one active pool per account per site-license exclusive group;
      instructor approval replaces a lower student teaching grant, while a
      separate research grant can coexist.
- [x] Record custom terms/policy acceptance metadata when URLs are configured.
- [x] Add minimal manager overview data: pool cap, active count, pending request
      count, available seats, and recent approvals/rejections.
- [x] Add a minimal user-facing account UI for verified-domain users to claim
      no-approval pools or request manager approval for approval-required pools.
- [x] Add a minimal manager-facing account UI for reviewing pending
      site-license pool requests.
- [x] Add full audit records or structured metadata for manager changes,
      revocations, and CLI/API actor context.
- [x] Add structured metadata for requests,
      approvals, rejections, and revocations.

Explicitly out of the first slice:

- Full polished manager dashboard.
- CSV export.
- Scheduled affiliation reverification jobs.
- SSO affiliation enforcement beyond storing `verification_policy =
"sso-affiliation"` as a future-supported policy.
- Soft overages or true-up billing.
- Automatic student auto-claim.

Acceptance criteria:

- [x] CoCalc admin can create a site license with an arbitrary nonempty list of
      named pools and add an initial owner manager.
- [x] A verified-domain user can claim a student seat.
- [x] A verified-domain user can request instructor access.
- [x] A site-license manager can approve or reject the instructor request.
- [x] Approval upgrades effective membership to the instructor tier and releases
      the student seat for the same site license.
- [x] Cap checks prevent claiming or approval past the pool limit.
- [x] Custom terms/policy links, if configured, are shown before claim/request and
      acceptance is recorded.
- [x] Existing one-pool site packages still resolve as before or are treated as
      backward-compatible single-pool licenses.
- [x] Focused tests cover claim, request, approval, rejection, cap recheck,
      one-active-pool upgrade, manager authorization, and custom terms metadata.

### Phase 1: Schema and Types

- Add `site_licenses`.
- Add `site_license_managers`.
- Add `site_license_pool_requests`.
- Extend site-package metadata typing for:
  - `site_license_id`
  - `pool_name`
  - `requires_approval`
  - `verification_policy`
  - `affiliation_reverification_days`
  - `affiliation_reverification_grace_days`
  - `allowed_domains`
- Add site-license metadata for:
  - `custom_terms_url`
  - `custom_policy_url`
  - `terms_version_label`
  - `renewal_policy`
  - `overage_policy`
- Add shared TypeScript types in `@cocalc/util`.

### Phase 2: Admin Provisioning

- Extend existing site-package provisioning to create a site license plus one
  or more pool packages.
- Keep backward compatibility for existing single-pool `kind = "site"` package
  rows by treating each as a one-pool site license.
- Add admin API/CLI commands for creating pools and managers.
  - Current CLI supports provisioning a site license with initial pools and
    owner manager. Editing managers/pools after creation is still future
    polished admin tooling.
- The admin panel for deleting membership tiers already blocks deleting a tier
  that has claims/users. It should also block deleting a tier that is attached
  to a site license, and ideally show how many site licenses use that tier.

### Phase 3: Claimable and Requestable User Flow

- [x] Update claimable-membership APIs to return:
  - immediately claimable pools
  - approval-required requestable pools
  - existing request status
- [x] Include custom terms/policy URLs and whether the user must accept them before
      claiming/requesting.
- [x] Keep existing no-approval claim path for baseline pools.
- [x] Add request creation for approval-required pools.
- [x] Add minimal account UI actions for claimable and requestable pools.

### Phase 4: Manager Dashboard and Approval Flow

- [x] Add manager-scoped APIs.
- [x] Add minimal manager review panel in the account membership package manager.
- [ ] Add polished manager dashboard.
- Add notifications for new requests and review outcomes.
- Approval creates assignment and grant through existing membership package
  machinery.
- Rejection records review state and reason.

### Phase 5: Seat Reconciliation

- [x] Enforce one active pool per account per site-license exclusive group.
- [x] Instructor approval revokes the lower student seat in the same teaching group
      for simplicity and to avoid confusion.
- [x] Researcher seats can coexist with teaching seats when they use a distinct
      `exclusive_group`.
- [x] Add reporting so managers can see seats revoked due to upgrades.

Implementation note: approval already records `seat-released-for-upgrade`
audit events. Direct no-approval claims now hide and reject other active pools
in the same site-license `exclusive_group`, while still allowing claims in
distinct groups such as `research`.

### Phase 6: Fresh Affiliation Reverification

- Store `affiliation_verified_at` and the verifying institutional identity on
  site-license grants or claim metadata.
- Store the verification policy that was satisfied.
- Add pending-affiliation-reverification query.
- Add user notification/grace workflow.
- Clear pending release when the user re-verifies institutional email or has a
  fresh qualifying SSO assertion.
- Add scheduled release job for seats that miss the grace deadline.

### Phase 7: Invite Limit Integration

- [x] Define resource limits for the new `instructor` and `researcher` tiers.
- [x] Make project invite email quotas and collaborator caps depend on effective
      membership.
- [x] Ensure course workflows use instructor limits.

Implementation note: course email invites now enforce both per-course pending
email invite limits and total course student-plus-pending-invite caps from the
effective membership limits. The count uses persisted student-project course
metadata plus pending course invite rows, so it does not depend on client-side
course state.

### Phase 8: Tests and Validation

- Unit tests for claimable/requestable pool logic.
- Unit tests for approval/rejection and cap rechecks.
- Unit tests for canonical identity duplicate prevention.
- Unit tests for one-active-pool/revoke-on-upgrade behavior.
- Unit tests for verification-policy enforcement.
- Unit tests for custom terms acceptance metadata.
- Unit tests for reverification grace/release behavior.
- Unit tests for site-license term expiration and renewal extension behavior.
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
- verification policy: `email-domain`
- affiliation reverification: every 180 days, 30-day grace
- invite email: disabled or very low
- collaborator/project caps: modest

Instructor pool:

- tier: `instructor`
- requires approval: `true`
- verification policy: `email-domain` for year one, with planned support for
  `sso-affiliation`
- affiliation reverification: every 365 days, 45-day grace
- invite email: enabled with course-aware limits
- collaborator/project caps: higher than `member`, lower than `pro` unless the
  deal says otherwise

Terms/policy links:

- optional per site license
- shown before claim/request if configured
- acceptance recorded with URL and timestamp

Contract defaults:

- annual term
- hard seat caps
- no automatic overage
- renewal extends the site license and pool packages
- non-renewal ends institution-funded memberships after the negotiated
  expiration grace period

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

## Resolved Decisions

- Baseline student seats require a click, but the claim UI should be very
  discoverable and clear. The click ensures users know they received something
  extra.
- Pending approval requests eventually should reserve instructor seats, but the
  first version can recheck cap availability at approval time and error if the
  pool has filled.
- Site-license owners can approve their own instructor request. This avoids
  unnecessary CoCalc-admin work.
- Site-license seats use fresh affiliation verification instead of generic
  inactivity release. Signing in is not enough to keep a site-license seat.
- Organization-verified SSO attributes should eventually drive automatic
  instructor eligibility, and can also satisfy periodic affiliation
  reverification.
- Each pool has a verification policy. Year one can be generous with
  email-domain verification, while the model explicitly supports stricter SSO
  affiliation policies later.
- Site licenses can include custom negotiated terms/policy URLs that users see
  and accept before claiming or requesting membership.
- Site licenses use standard contract-term semantics: start date, expiration
  date, renewal, hard caps by default, and negotiated overage/grace parameters.

## Recommendation

Implement the first version with:

- explicit site-license managers
- one or more site-package-backed pools per site license
- click-to-claim baseline pool
- approval-required instructor pool
- per-pool verification policy
- optional custom site-license terms/policy links
- standard term/renewal/overage policy fields
- no pending-seat reservation
- one active pool per account per site-license exclusive group
- periodic fresh affiliation reverification, with automatic release when the
  user cannot reverify during the grace period

This is the least confusing model for campus admins, preserves the existing
membership package machinery, and gives CoCalc the trust boundary needed for
course/project invite limits.
