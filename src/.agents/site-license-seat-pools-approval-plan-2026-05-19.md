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

- Site-license records should live in the seed/global Postgres database, not on
  an arbitrary license-owner home bay.
- Site licenses are billing/contract-like global resources. Their most important
  invariants are global domain uniqueness, global claim discovery, and durable
  admin/support visibility.
- The license owner account is a manager/contact for the license, not the
  storage authority for the license.
- Account rehome must not move site-license records. Rehoming a manager account
  changes where that manager's account state lives, but the organization
  license stays in the seed/global authority.
- Claim and approval operations should route to the seed/global site-license
  service. Resulting user grants and grant side effects are then written or
  synchronized to the claiming user's home bay.
- Launchpad is the one-bay special case where the seed/global database and the
  only bay database are the same deployment.

This supersedes the earlier owner-home-bay design. The owner-home-bay design
made site-license placement arbitrary, forced claim discovery to scan all bays,
made global domain uniqueness difficult, and introduced account-rehome bugs
because site-license side tables were easy to omit from portable account state.

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

Important multibay correction:

- In the final architecture, site-license pools should be global/seed-backed.
  They can initially continue to use `membership_packages.kind = "site"` if that
  table is accessed through a seed-authoritative site-license service.
- Long term, it may be cleaner to split site-license pools into a dedicated
  `site_license_pools` table instead of overloading bay-local
  `membership_packages`. The important invariant is that the domain-to-pool
  lookup is seed/global, not bay-local.
- User-specific grant records remain on the user's home bay, because effective
  membership is account state and must move with account rehome.

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

## Seed/Global Site-License Architecture

Site licenses should be treated as seed/global control-plane state, similar to
billing and directory data, not as bay-local account state.

### Why Seed/Global Authority

Option 1, storing site licenses on an arbitrary owner account home bay, is not a
good architecture:

- the owner account's home bay is operationally arbitrary;
- claim discovery requires scanning every bay that might contain a matching
  domain;
- global domain uniqueness cannot be enforced by a local bay query;
- account rehome must copy or redirect site-license tables, requests, managers,
  audit logs, package rows, and side-effect rows;
- forgetting any one of those tables creates subtle production bugs;
- support and sales workflows become harder because the license may be anywhere.

Option 2, giving site licenses their own `owning_bay_id`, is cleaner than option
1, but it still creates a new rehome/move domain:

- a global `site_license_id -> owning_bay_id` directory is required;
- a global domain index is still required for uniqueness and discovery;
- site-license move/drain needs locks, routing, retries, repair, and CLI
  tooling;
- every new site-license table must be included in site-license move/backup
  semantics;
- this repeats the same class of rehome bugs already seen for accounts,
  projects, and hosts.

Option 3, seed/global authority, is the recommended model:

- one database enforces global domain uniqueness;
- claim discovery becomes a direct indexed lookup by verified email domain;
- there is no site-license rehome state machine;
- account rehome and bay drain do not move organization contracts;
- the seed database is the natural HA/durable location for billing-adjacent
  contract data;
- site-license volume should be bounded compared with projects, files,
  collaborators, and project-host state.

### Authoritative Tables

Seed/global Postgres should own these tables:

- `site_licenses`
- `site_license_domains`
- `site_license_pools` or seed-authoritative `membership_packages.kind = "site"`
  rows
- `site_license_managers`
- `site_license_pool_requests`
- `site_license_audit_log`
- site-license claim-directory rows for institutional identities, or a
  seed/global equivalent scoped by `site_license_id` and `exclusive_group`

Bay-local account Postgres should own:

- `membership_grants` for accounts homed on that bay
- account-facing grant projections and side effects
- any per-account notification state
- local cached/projection rows, if we later add them for performance

Do not store authoritative site-license state on the account home bay merely
because a manager or owner account is homed there.

### Domain Index

Add a seed/global `site_license_domains` table.

Suggested fields:

- `site_license_id`
- `domain`
- `starts_at`
- `expires_at`
- `created`
- `updated`

Rules:

- Domains are normalized to lowercase, with leading `@` removed.
- Active exact overlaps are forbidden.
- Active parent/child overlaps are forbidden, e.g. `example.edu` conflicts with
  `math.example.edu`.
- Expired licenses do not block new licenses.
- Multiple pools inside the same site license may share the same domain.
- The domain index is updated transactionally with site-license provisioning and
  domain edits.

Implementation note: parent/child overlap cannot be fully enforced by a simple
unique index. The seed service should enforce it inside the same transaction
that updates the domain rows, ideally with an advisory lock around normalized
domain suffixes or a coarse site-license-domain lock. A simple transaction-level
service lock is acceptable for the first version because site-license writes are
low volume.

### Claim Discovery

Claim discovery should not scan bays.

Recommended flow:

1. The user's home bay reads the user's verified email addresses.
2. It extracts normalized domains from those email addresses.
3. It calls the seed/global site-license service with those domains and the
   account id.
4. The seed/global service returns claimable/requestable pools matching those
   domains, request status, custom terms/policy requirements, and current
   capacity.
5. The user's home bay displays that data in the account UI.

This is O(number of verified email domains + matching site licenses), not
O(number of bays).

### Claim, Request, and Approval Writes

Claim/request/approval should use seed/global site-license authority for the
license-side operation, and account-home authority for the resulting user grant.

Recommended direct-claim flow:

1. User on home bay asks to claim a seed/global site-license pool.
2. Home bay forwards verified emails and account id to the seed/global service.
3. Seed/global service validates domain eligibility, terms acceptance,
   capacity, exclusive-group claim identity, and active domain policy.
4. Seed/global service creates or reserves the site-license seat/assignment.
5. Seed/global service writes or queues the membership grant to the user's home
   bay.
6. The home bay resolves effective membership from the local grant.

Recommended approval-required flow:

1. User submits a request through the seed/global service.
2. Manager dashboard reads pending requests from seed/global state.
3. Manager approval rechecks capacity and claim identity on seed/global state.
4. Approval creates the seat/assignment and writes or queues the grant to the
   user's home bay.
5. If approval upgrades a user from a lower pool in the same exclusive group,
   seed/global state records the lower seat release and queues the corresponding
   grant revocation to the user's home bay.

The grant side effect must be idempotent. The seed/global service should be able
to retry grant upsert/revoke without duplicating grants or corrupting effective
membership.

### Rehome and Bay Drain Invariants

Account rehome:

- moves user account state and user grants;
- does not move site-license records, pools, requests, managers, or audit logs;
- must preserve enough grant metadata to route back to the seed/global
  site-license service for reverification, release, and manager reporting;
- must not require scanning former account home bays for site-license state.

Bay drain:

- can drain a bay containing users with site-license grants without moving the
  licenses themselves;
- only account grants/projections move with those users;
- seed/global site-license state remains stable.

Manager account rehome:

- does not change manager authority;
- `site_license_managers.account_id` remains the same;
- future manager actions authenticate on the manager's current home bay, then
  call the seed/global site-license service.

Seed/global restore:

- is high-value durable state and should run in the strongest available HA/backup
  mode;
- restoring it must be fenced because it contains billing-adjacent contract
  state and global domain ownership.

### Multibay Mistakes to Avoid

- Do not add site-license tables to account rehome portable state as the primary
  architecture. That preserves the wrong ownership model.
- Do not make claim discovery enumerate all bays in production.
- Do not enforce domain uniqueness with a bay-local query.
- Do not route by the license owner's current home bay.
- Do not couple a user's effective grant storage to the license storage
  location.
- Do not assume the seed service can directly mutate arbitrary bay-local account
  grants without an idempotent routed write or outbox.
- Do not let stale bay-local cached site-license data make authorization or
  claim decisions. Caches may accelerate UI reads only.

### Performance and Caching

The seed/global design is acceptable because site licenses are expected to be
bounded in count and low-write compared with project state.

If read load becomes noticeable:

- cache domain lookup results in the home bay with a short TTL;
- project claimable pools into per-bay read caches;
- invalidate caches from seed/global site-license update events;
- keep seed/global state authoritative for every write and every security
  decision.

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

### Phase 0: Correct Multibay Authority to Seed/Global

Before further feature polish, move site-license authority from owner-home-bay
state to seed/global state.

Goals:

- make seed/global Postgres the authoritative source for site licenses, pools,
  managers, requests, audit log, and domain ownership;
- remove the need to scan all bays for claimable site licenses;
- remove site-license state from account rehome semantics;
- keep user membership grants on the user's home bay;
- preserve Launchpad as the one-bay special case.

Implementation steps:

1. [x] Add a seed/global site-license data access layer.
   - It should use the seed/global Postgres connection explicitly, not
     `withAccountRehomeWriteFence`.
   - It should expose create/update/list/claim/request/review/reverification
     helpers that are clearly marked as seed-authoritative.
   - It should be the only write path for `site_licenses`,
     `site_license_managers`, `site_license_pool_requests`, site-license audit,
     site-license domain rows, and site-license pool rows.

2. [x] Add `site_license_domains`.
   - Local dev backfill was intentionally skipped; lite1b dev data should be
     deleted instead.
   - Exact and parent/child overlap are enforced in seed/global transactions
     using a seed-side domain index and transaction-scoped write lock.
   - Expired licenses do not block new domain ownership.

3. [x] Decide the pool storage shape.
   - Short-term acceptable: continue using `membership_packages.kind = "site"`
     rows, but ensure those rows are seed/global for site-license pools.
   - Long-term cleaner: introduce `site_license_pools` and make generic
     `membership_packages` stop carrying site-license pool authority.
   - If using `membership_packages` short term, add guardrails so bay-local
     membership package APIs cannot create or mutate site-license pools outside
     the seed/global service.

4. [x] Change provisioning.
   - Admin provisioning always writes to seed/global state.
   - `owner_account_id` remains the first manager/contact, but does not decide
     storage location.
   - Fresh-auth protection still applies at the API layer.
   - Domain overlap checks become seed/global and supersede bay-local checks.

5. [x] Change claim discovery.
   - Home bay gathers verified emails.
   - Home bay calls seed/global claim-discovery API with normalized domains and
     account id.
   - Seed/global returns matching pools and request status.
   - Remove static bay enumeration for site-license claim discovery.

6. [x] Change direct claim/request/review writes.
   - Seed/global validates eligibility, capacity, exclusive-group identity, and
     terms acceptance.
   - Seed/global records request/assignment/audit state.
   - Seed/global queues idempotent grant upsert/revoke effects to the user's
     home bay.
   - User home bay remains authoritative for effective membership resolution.

7. [x] Change reverification and release.
   - Seed/global finds seats due for reverification/release.
   - User-facing status can still be read from account-home grant metadata, but
     refresh/release decisions route through seed/global license state.
   - Release queues idempotent grant revocation to the user's home bay.

8. [x] Remove or constrain owner-home-bay assumptions.
   - Remove routing that sends site-license overview/provision/request/review to
     `owner_account_id` home bay.
   - Remove bay scans from `listClaimableMembershipPackagesAcrossCluster` for
     site-license pools.
   - Leave non-site membership package behavior unchanged.

9. [x] Account rehome audit.
   - Confirm account rehome still moves `membership_grants` for site-license
     users.
   - Confirm account rehome does not move site-license records or pools.
   - Confirm manager account rehome does not break manager authorization.
   - Confirm stale source bays cannot approve, revoke, or mutate site-license
     state after rehome.

10. [x] Local dev cleanup.
    - On the current lite1b dev install, delete all existing site-license data
      manually from the database before switching to the seed/global authority
      model.
    - Completed on lite1b dev seed database by deleting site-license packages,
      assignments, grants, claims, requests, managers, audit rows, domain index
      rows, outbox rows, and site-license rows.
    - Existing dev site-license rows do not matter and should not complicate the
      implementation.
    - A real production migration/backfill can be designed later if needed.

Validation:

- Creating two active site licenses with overlapping domains fails globally even
  if the managers/owners live on different bays.
- [x] Claim discovery for a user on bay-2 finds a license whose manager account is
      on bay-0 without scanning every bay.
- [x] Claiming a seed/global license creates the effective grant on the user's home
      bay.
- [x] Approving a request as a manager whose account was rehomed still works.
- [ ] Rehoming a user with a site-license grant preserves effective membership and
      does not move the license.
- [ ] Draining a non-seed bay with users and managers does not move site-license
      records.
- [x] Focused Conat/API tests cover seed routing for provisioning, overview,
      updates, requests, reviews, claim discovery, and affiliation refresh.
- [x] Repo-built CLI smoke validates seed-backed membership tier/site-license
      usage counts against the live hub environment.

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
      seed/global site-license service, with requester verified emails collected
      on the requester home bay.
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

- Full polished manager dashboard. The current UI is already usable and
  presentable enough for near-term testing, so backend notifications and admin
  editing are higher priority.
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
- [x] The legacy one-pool/simple site-license path has been removed. New
      site-license state is managed through `site_licenses` plus linked
      seed/global site pool packages.
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
- The legacy simple one-pool site-license path has been removed; site-license
  state now goes through `site_licenses` plus linked seed/global site pool
  packages.
- Add admin API/CLI commands for creating pools and managers.
  - Current CLI supports provisioning a site license with initial pools and
    owner manager.
  - [x] Existing frontend pool edit actions route to the seed/global
        site-license service, require writable site-license manager authority,
        update seat count/expiry/domains, rebuild the seed domain index, and
        record `pool-updated` audit events.
  - [x] Existing dashboard can edit top-level license settings and active
        managers after creation. Those writes also route through the seed/global
        service and record site-license audit events.
- [x] The admin panel for deleting membership tiers blocks deleting a tier that
      has active subscriptions or active site-license pool usage, and shows an
      active site-license count per tier.

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
- [ ] Add polished manager dashboard. Deferred for now because the current
      manager UI is usable and backend correctness, notifications, and editing
      are higher priority.
- [x] Add notifications for new requests and review outcomes.
- Approval creates assignment and grant through existing membership package
  machinery.
- Rejection records review state and reason.

Implementation note: request creation now creates account-notice notifications
for active owner/manager targets, and request approval/rejection creates
account-notice notifications for the requester. Notification target home bays
are resolved through the cluster account directory so this works when managers
or requesters live off the seed bay.

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

- [x] Store `affiliation_verified_at` and the verifying institutional identity on
      site-license grants or claim metadata.
- [x] Store the verification policy that was satisfied.
- [x] Add pending-affiliation-reverification query.
- [x] Add user notification/grace workflow.
- [x] Clear pending release when the user re-verifies institutional email.
- [ ] Clear pending release when the user has a fresh qualifying SSO assertion.
      Deferred until SSO affiliation enforcement is implemented.
- [x] Add release path for seats that miss the grace deadline.
- [x] Add scheduled job to invoke grace-expired seat release.

Implementation note: active site-license seats now carry affiliation metadata
for direct claims and manager approvals. The backend reverification query
classifies seats as current, pending reverification, or grace expired using
pool-level reverification and grace settings.
The release helper revokes grace-expired seats through the existing membership
package revoke path and records a `seat-released-after-reverification-grace`
audit event.
The email-domain refresh helper lets an active site-license seat recover from
pending reverification or grace-expired status when the signed-in account has a
fresh verified allowed-domain email. It updates affiliation metadata and records
a `seat-affiliation-reverified` audit event without changing claim-directory
ownership.
The scheduled release maintenance loop runs from the Conat backend maintenance
startup path and invokes the system release helper for active site licenses with
reverification-enabled pools. It releases only grace-expired seats, batches work
per tick, and records `seat-released-after-reverification-grace` with
maintenance metadata.
The user-facing backend contract now exposes a signed-in account's
reverification status from account-home grant metadata and a refresh RPC that
routes to the seed/global site-license service using grant routing metadata.
The maintenance pass now sends account-notice notifications at the start of the
reverification grace period, about 14 days before release, about 3 days before
release, and after automatic release. Notification state is recorded per
assignment and grace deadline so daily maintenance does not spam users.
Email transport for these account notices is deferred.

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

- [x] Unit tests for claimable/requestable pool logic.
- [x] Unit tests for approval/rejection and cap rechecks.
- [x] Unit tests for canonical identity duplicate prevention.
- [x] Unit tests for one-active-pool/revoke-on-upgrade behavior.
- [x] Unit tests for verification-policy enforcement.
- [x] Unit tests for custom terms acceptance metadata.
- [x] Unit tests for reverification grace/release behavior.
- [ ] Unit tests for site-license term expiration and renewal extension behavior.
      Deferred; term fields exist, but full renewal behavior is not part of the
      current critical path.
- [x] Inter-bay tests for license/package authority routing.
- Browser smoke test for:
  - student claim
  - instructor request
  - manager approval
  - effective tier upgrade
  - invite quota change

Current validation status:

- [x] Focused site-license server test suite passes.
- [x] Focused Conat purchases routing test suite passes.
- [x] Dangerous RPC fresh-auth registry test passes.
- [x] Full repo TypeScript build passes.
- [x] Live repo-built CLI smoke for `admin membership-tiers` passes against the
      refreshed hub environment.
- [ ] Full browser smoke pass for the complete claim/request/approve/tier-upgrade
      flow remains manual.

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
- Site licenses are seed/global contract state, not owner-home-bay account
  state. The license owner account is a manager/contact, not the storage
  authority.
- Site-license claim discovery must not scan all bays in production. It should
  use seed/global domain lookup and route writes through the seed/global
  site-license service.
- Account rehome moves user grants and account state, but not site-license
  records, pools, requests, managers, audit logs, or domain ownership.
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

- seed/global site-license authority
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
