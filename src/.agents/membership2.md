# Membership / Billing / Dedicated Hosts V1 Plan

## Status

This is the corrected V1 plan after re-checking the actual multi-bay
architecture.

The earlier version of this document got the product model mostly right, but it
did not fully account for where billing and entitlement state must live in a
real multi-bay cluster.

This version treats:

- multi-bay as the real architecture
- one-bay as a special case of that architecture
- account home bay, project owning bay, and seed-global state as separate
  authorities with explicit responsibilities

## Purpose

This plan covers the remaining major user-visible release work in `cocalc-ai`:

- personal memberships
- student pay
- instructor-paid course seats
- team seats
- domain / site licenses
- dedicated host pricing and billing

The goal is to implement these correctly inside the existing multi-bay control
plane instead of building a one-bay billing system that would have to be
rewritten later.

## Core Product Goals

1. Memberships are account-wide, not project-scoped.
2. Billing and limits are understandable to users.
3. Course / teaching workflows do not bill or throttle instructors for student
   usage.
4. Domain / site licensing has a non-SSO transition path.
5. Dedicated hosts are competitive and explicit about pricing.
6. The implementation is correct under multi-bay routing and account rehome.

## Non-Negotiable Architecture Invariants

These are the invariants this plan must satisfy.

### 1. One architecture

The real architecture is multi-bay.

One-bay deployments are only the degenerate case where:

- account home bay
- project owning bay
- seed/global authority

all happen to collapse to one bay.

### 2. Account-facing billing state is home-bay authoritative

All account-scoped billing and entitlement state belongs to the account home
bay.

This includes:

- purchases
- subscriptions
- statements
- account balance and quota state
- account billing settings and payment-provider references
- membership grants where the account is the beneficiary
- membership packages where the account is the payer / owner
- membership package assignments for packages owned by that account

This supports:

- data locality
- scalability
- account rehome as a first-class workflow

### 3. Project-specific course state is project-owning-bay authoritative

Anything tied to the project row itself remains on the project owning bay.

This includes:

- course `payInfo`
- course student-project metadata
- `projects.usage_account_id`
- project usage measurements

### 4. Seed/global state is only for cluster-global facts

Seed-global authoritative state is allowed only for facts that are inherently
cluster-wide and not naturally owned by one account home bay.

This includes:

- cluster account directory
- institutional claim scopes for domain / site licensing
- canonical claim-identity dedupe records
- provider pricing catalog for dedicated hosts

### 5. Cross-bay discovery uses directories or projections, not scans

No purchase, claim, or entitlement flow may depend on:

- scanning every bay
- querying arbitrary remote bays until something matches
- assuming the seed has a full copy of account-home-bay billing tables

Cross-bay discovery must go through explicit cluster-global directories or
projections.

### 6. Account rehome must move all home-bay billing state

If account-facing billing state belongs to the home bay, then account rehome
must move it.

This is not optional.

The current rehome workflow only copies small portable projection/session state.
That is not enough for purchases, subscriptions, statements, or owned
membership packages.

## What Already Exists

### Memberships and entitlements

- membership resolution is already account-based in
  `src/packages/server/membership/resolve.ts`
- tiers are already admin-configurable in
  `src/packages/server/membership/tiers.ts`
- account-wide membership UI already exists

### Usage limits and throttling

- `projects.usage_account_id` was already introduced as the correct basis for
  course/student attribution
- storage / snapshot / backup / managed-egress logic already started moving in
  that direction

### Course / package foundations

- `membership_grants`
- `membership_packages`
- `membership_package_assignments`

already exist in code and schema.

### Current architecture gap

The current implementation is not yet multi-bay-correct:

- browser transport now routes new package calls to the account home bay
- but backend package/billing code still does direct local DB reads and writes
- there is no seed-global package / assignment directory
- account rehome does not copy purchases, subscriptions, statements, grants, or
  packages

This document addresses that gap directly.

## State Ownership Model

There are four relevant state classes.

## A. Account Home Bay Authoritative State

This state is written and read on the account home bay.

### Billing ledger

- `purchases`
- `subscriptions`
- `statements`
- account balance / quota state
- account automatic-payment / billing preference state
- payment-provider references tied to the account

### Membership state for the account

- `membership_grants` where `account_id` is the beneficiary

### Owned package state

- `membership_packages` where `owner_account_id` is this account
- `membership_package_assignments` for those packages
- frozen package seat pricing / package metadata used for future seat expansion

### Why this belongs here

- it is account-scoped
- it is privacy-sensitive
- it must move cleanly on account rehome
- it scales by distributing users across bays

## B. Project Owning Bay Authoritative State

This state is tied to project ownership, not account billing.

- course `payInfo`
- course project metadata
- student project metadata
- `projects.usage_account_id`
- project storage usage
- project backup / snapshot counts
- background project egress attribution inputs

### Why this belongs here

- it is part of the project row and project lifecycle
- project move already has its own workflow
- account rehome must not imply project move

## C. Seed / Global Authoritative State

This state is cluster-global by nature.

### Cluster account directory

Already exists and remains the authority for:

- `account_id -> home_bay_id`
- email / account lookup for routing

### Institutional claim scopes

Needed for `domain` and `site` licensing.

These records define the institutional scope that multiple packages may belong
to, for example:

- `example.edu`
- `university-x-site-license-2026`

### Canonical institutional claim identities

Needed to prevent one person from claiming multiple institutional memberships
using `+alias` emails.

For example:

- `foo@example.edu`
- `foo+1@example.edu`
- `foo+lab@example.edu`

must map to one canonical institutional identity for claim purposes.

### Dedicated-host provider price catalog

The synced provider price catalog is cluster-global and not naturally account
local.

## D. Seed / Global Projection State

These are not billing source-of-truth tables. They exist for routing and
cross-bay discovery.

### Package directory projection

One row per package, with enough metadata to discover:

- package kind
- owner account
- owner home bay
- active term
- seat capacity summary
- claim scope, if any

### Assignment / reservation directory projection

One row per active assignment or reservation, with enough metadata to discover:

- package id
- owner home bay
- assigned account id, if known
- reserved email address, if present
- claim scope / canonical identity key, if present
- revoked status

### Why projections instead of global authority

The package itself is paid for by a specific account and belongs on that
account's home bay. The seed only needs enough replicated information to route
cross-bay claim and assignment flows.

## Product Decisions That Still Stand

These earlier decisions remain correct.

### Memberships are account-wide

- `student pay` grants account-wide `student`
- team/site/domain seats grant account-wide memberships
- no return to project-scoped paid upgrades

### `projects.usage_account_id` is required

Usage attribution remains:

1. `projects.usage_account_id`
2. otherwise `course.account_id` for student course projects
3. otherwise project owner

### Dedicated-host egress is not billed separately

Egress remains part of the membership / entitlement model, not a separate
dedicated-host per-GB line item.

### Dedicated hosts are billed to the host owner

Not to collaborators or to the project owner unless that is the same account.

### Dedicated hosts are billed monthly, not prepaid-balance-gated

Membership tier and admin overrides control rolling risk limits.

The key limits should be:

- a rolling 5-hour spend limit
- a rolling 7-day spend limit

Monthly statements remain the main collection model.

## Data Model Corrections

The existing local tables stay, but their ownership semantics change.

## Home-Bay Authoritative Tables

These remain bay-local and account-owned:

- `membership_grants`
- `membership_packages`
- `membership_package_assignments`
- `purchases`
- `subscriptions`
- `statements`

## New Seed-Global Authoritative Tables

### `membership_claim_scopes`

Defines cluster-global institutional claim scopes.

Suggested fields:

- `id`
- `kind`
  - `domain`
  - `site`
- `scope_key`
  - e.g. `example.edu`
  - or internal site-license identifier
- `metadata`
- `created`
- `updated`

### `membership_claim_identities`

Defines the canonical institutional identity that currently holds a claim
within a scope.

Suggested fields:

- `claim_scope_id`
- `canonical_identity_key`
- `account_id`
- `assignment_id` nullable
- `claimed_at`
- `revoked_at`
- `metadata`

Uniqueness rule:

- at most one active claim per `(claim_scope_id, canonical_identity_key)`

## New Seed-Global Projection Tables

### `cluster_membership_package_directory`

Suggested fields:

- `package_id`
- `owner_account_id`
- `owner_home_bay_id`
- `kind`
- `membership_class`
- `seat_count`
- `active_assignment_count`
- `starts_at`
- `expires_at`
- `claim_scope_id` nullable
- `metadata_summary`
- `updated_at`

### `cluster_membership_assignment_directory`

Suggested fields:

- `assignment_id`
- `package_id`
- `owner_account_id`
- `owner_home_bay_id`
- `account_id` nullable
- `email_address` nullable
- `canonical_identity_key` nullable
- `claim_scope_id` nullable
- `revoked_at`
- `metadata_summary`
- `updated_at`

## Canonical Identity Rules

This applies only to institutional claim dedupe, not to account creation or
login identity.

### V1 canonicalization

For `domain` / `site` claim scopes:

- lowercase domain
- lowercase local part
- strip `+suffix` from the local part

Examples:

- `foo@example.edu`
- `foo+1@example.edu`
- `foo+lab@example.edu`

all canonicalize to one institutional identity key.

### Important limitation

This does not merge accounts.

Multiple CoCalc accounts can still exist. The rule is only:

- one active institutional claim per canonical identity within a claim scope

### Long-term upgrade path

SSO subject identifiers should eventually become the stronger claim identity
when available.

## Routing Rules

These flows must be explicit.

## Browser to Home Bay

All account membership / billing UI is served from the account home bay.

That includes:

- package purchase
- package management
- seat assignment
- claim flow
- billing history
- statements

## Home Bay to Project Owning Bay

Used when account-scoped billing actions depend on project-owned state.

Examples:

- quoting or purchasing a `course` package requires reading course `payInfo`
- course seat assignment requires updating `projects.usage_account_id`
- student pay requires marking course payment state on the course project

## Home Bay to Seed

Used for cluster-global discovery or uniqueness checks.

Examples:

- domain / site claim discovery
- `+alias` canonical-identity dedupe
- package / assignment directory reads
- provider pricing catalog reads

## Home Bay to Another Account Home Bay

Used when a package owned by one account grants membership to another account.

Examples:

- team seat assignment to an existing account
- course seat assignment once the student account is known
- claiming a reserved email assignment
- claiming a domain / site seat

The owner home bay remains authoritative for:

- seat capacity
- assignment existence
- package term and pricing

The beneficiary home bay remains authoritative for:

- the beneficiary's local `membership_grants`
- local membership resolution

## Correct Product Flows

## Personal memberships

Personal membership purchase remains home-bay-local.

No seed/global logic is needed beyond any cluster-wide payment-provider support
already in place.

## Student pay

Correct multi-bay flow:

1. browser calls the student's account home bay
2. student home bay resolves the course project owning bay
3. student home bay fetches current course `payInfo` from the project owning bay
4. student home bay creates the purchase and grant locally
5. student home bay calls the project owning bay to mark payment state and set
   `usage_account_id`

This keeps:

- billing with the student
- project state with the project

## Instructor-paid course packages

Correct multi-bay flow:

1. instructor buys the package on the instructor home bay
2. instructor home bay validates course info via the project owning bay
3. package and purchase are created on instructor home bay
4. package directory projection is published to seed
5. seat assignment:
   - owner home bay creates local assignment
   - seed projection is updated
   - student home bay gets the grant when the student account is known
   - project owning bay gets `usage_account_id` update

## Team packages

Correct multi-bay flow:

1. owner buys package on owner home bay
2. owner home bay creates package and purchase locally
3. owner home bay publishes package directory projection
4. assigning a seat to an existing account:
   - owner home bay creates local assignment
   - owner home bay routes grant creation to beneficiary home bay
   - seed assignment projection is updated
5. reserving by email:
   - owner home bay creates local assignment
   - seed assignment projection is updated
6. later claim:
   - claimant home bay discovers the reservation through the seed projection
   - claimant home bay calls owner home bay to consume the reservation
   - owner home bay calls claimant home bay to create the grant

## Domain / site licenses

Correct multi-bay flow:

1. institutional package is still paid for and owned on some account home bay
2. a seed-global `claim_scope` is created for the institution
3. package directory projection links the package to that scope
4. claimant home bay:
   - reads verified emails locally
   - asks seed for matching claimable scope/package information
   - checks canonical identity uniqueness
5. claim is routed to the owner home bay
6. owner home bay allocates capacity and records assignment
7. beneficiary home bay receives the actual grant

This is the correct split:

- account-owned billing state stays local to the payer
- institution-wide uniqueness and discovery live in seed-global state

## Rehome Semantics

## Account rehome must move billing state

The current rehome portable-state copy is insufficient.

It currently moves only:

- account projections
- auth/session state
- account API keys

It must be expanded to move all home-bay-authoritative billing data.

### Must move on account rehome

- `purchases` where `account_id` matches
- `subscriptions` where `account_id` matches
- `statements` where `account_id` matches
- account billing settings / payment-provider references
- `membership_grants` where `account_id` matches
- `membership_packages` where `owner_account_id` matches
- `membership_package_assignments` for those owned packages
- any future dedicated-host billing cursors or account-scoped host charge state

### Does not move on account rehome

- project rows
- project hosts
- project usage measurements
- seed-global claim scopes
- seed-global claim identity rows
- seed-global package / assignment directory projections

### Important nuance

If an account has a team/site/domain membership granted from someone else's
package:

- the owner-side package and assignment stay with the owner's home bay
- the beneficiary's local grant row must move with the beneficiary account

### Implementation requirement

The current `loadPortableState` and `copyRehomeState` flow must be expanded or
complemented by a dedicated account-billing-state copy phase.

Because purchase history can be large, this should be:

- batched
- replayable
- fenced
- not one huge JSON aggregate blob

## Package owner rehome

When the package owner account rehomes:

- the package rows move
- the owner-side assignment rows move
- the seed package / assignment directory updates `owner_home_bay_id`

Beneficiary grant rows do not move unless those beneficiary accounts themselves
rehome.

## Dedicated host billing under multi-bay

Dedicated-host billing also needs the same split.

### Account-home-bay state

- monthly host charge purchases
- statement inclusion
- account-level rolling host spend-limit settings
  - 5-hour window
  - 7-day window

### Seed/global state

- provider pricing catalog

### Host-owning or control-bay state

- raw host lifecycle observations
- rate-change triggers
- host metering intervals

### Correct billing flow

1. host lifecycle/rate events are produced where host control is authoritative
2. a worker computes billable intervals
3. before posting a charge, it resolves the owner's current home bay
4. the charge is created as a purchase on the owner's home bay
5. monthly statements on the home bay include that charge

This allows account rehome without moving raw host-control history.

### Dedicated-host risk policy

Dedicated-host admission should check projected and realized spend against
rolling windows, not only against a monthly ceiling.

The default policy should be:

- membership tier config sets default 5-hour and 7-day host spend limits
- admins can override those limits per account
- host create/start/resize is denied if it would violate either window
- the 5-hour window exists mainly to limit burst abuse and compromised-account
  spend
- the 7-day window exists to cap medium-term exposure without waiting for the
  monthly invoice cycle

## Implementation Plan

## Phase 0: lock the multi-bay billing invariants

1. update this plan
2. write one short release-invariants note that explicitly replaces
   `seed-owned purchases` with:
   - account-home-bay billing authority
   - seed-global institutional registry only
3. stop further membership/billing implementation until all new code follows
   those invariants

## Phase 1: explicit routing and write fences

1. audit all membership/purchase/package codepaths
2. require explicit home-bay assertions for account-owned billing writes
3. add or use `withAccountRehomeWriteFence` for billing mutations
4. ensure course-dependent purchase flows route through project-owning-bay APIs
   instead of local SQL assumptions

## Phase 2: seed-global institutional registries and projections

1. add `membership_claim_scopes`
2. add `membership_claim_identities`
3. add package directory projection
4. add assignment directory projection
5. add canonical-identity logic for domain/site claim scopes

## Phase 3: correct account-home-bay package and grant flows

1. keep packages and purchases on owner home bay
2. route grant creation/revocation to beneficiary home bay
3. route course `usage_account_id` writes to project owning bay
4. route claim discovery through the seed projections

## Phase 4: rehome-safe billing state

1. add account billing-state copy workflow
2. move purchases / subscriptions / statements on rehome
3. move grants / owned packages / owned assignments on rehome
4. update seed package directory ownership pointers after package-owner rehome
5. add rehome tests for:
   - account with purchases/subscriptions/statements
   - account owning team packages
   - account receiving grants from another user's package

## Phase 5: finish user-visible purchase flows on the corrected architecture

1. student pay on correct cross-bay routing
2. instructor-paid course seats on correct cross-bay routing
3. team seats on correct cross-bay routing
4. domain/site claim flow on seed projections + canonical claim identity

## Phase 6: dedicated hosts on the corrected architecture

1. seed/global provider pricing catalog
2. host rate-event history
3. host-charge posting to owner home bay
4. monthly statement integration
5. host drawer pricing / charge explanation UI

## Validation Requirements

This plan is not complete without explicit multi-bay validation.

### Required scenarios

1. package owner on bay A assigns seat to user on bay B
2. user on bay B claims reserved email seat from package on bay A
3. domain/site claimant on bay B claims institutional seat from package on bay A
4. student on bay B pays for course project owned on bay C
5. account with purchases and owned packages rehomes from bay A to bay B
6. beneficiary account with received grant rehomes from bay A to bay B
7. active dedicated host continues billing correctly after owner account rehome

## Abuse and Safety Requirements

The membership and billing plan also needs explicit abuse-control design.

This is not secondary work.

Once accounts can:

- buy memberships
- receive institutional entitlements
- create dedicated hosts
- spend money on compute

the abuse surface includes both account creation fraud and account takeover.

### Threat classes

The main classes of abuse are:

1. signup and free-trial abuse
2. payment abuse
3. entitlement abuse
4. account takeover
5. infrastructure abuse
6. operator and auditability gaps

### 1. Signup and free-trial abuse

The system should assume that any free-trial path will be abused if it is cheap
to automate.

V1 controls:

- email verification must work reliably
- signup and payment-intent creation must be rate limited by IP, account, and
  device/session signals
- free-trial eligibility must not be keyed only by email address
- reCAPTCHA is an abuse-mitigation control, not a commercialization feature
- reCAPTCHA should be enabled if and only if keys are configured

Design principle:

- do not grant meaningful compute, host access, or institutional claim power to
  an unverified or low-trust account just because it created an account first

### 2. Payment abuse

Stripe Radar should be part of the standard toolbox.

The key mistake to avoid is treating a just-created payment intent as proof that
an account is trustworthy.

V1 controls:

- payment-provider risk signals should be stored in local billing state
- membership/package activation should happen only after trusted payment success
- high-risk or review-required payments should not automatically mint grants,
  seats, or dedicated-host eligibility
- repeated failed payment attempts and card-testing patterns should rate limit
  further purchase attempts
- refunds and chargebacks must be able to revoke or suspend the entitlements
  they funded

Design principle:

- money movement and entitlement activation must be linked, reversible, and
  auditable

### 3. Entitlement abuse

The new seat/package model has its own abuse surface:

- one person trying to claim multiple institutional seats
- package owners assigning seats to burner accounts
- reusing `+alias` email variants to evade one-seat-per-person rules
- manipulating course/team flows to move usage onto the wrong account

V1 controls:

- institutional claims must use canonical identity dedupe
- `domain` / `site` claims should be unique per
  `(claim_scope_id, canonical_identity_key)`
- package assignment, revocation, reservation, and claim all need durable audit
  records
- `projects.usage_account_id` changes must only happen through explicit package
  or course flows, not arbitrary user edits
- `projects.usage_account_id` changes should be logged with actor, reason, old
  value, and new value

Design principle:

- entitlement state should always answer who granted what, to whom, why, and
  from which bay

### 4. Account takeover

This is now high priority.

Because paid compute and dedicated hosts can consume real money, compromised
accounts are valuable.

There does not currently appear to be a real 2FA / MFA implementation in this
codebase.

That should move near the top of the release queue.

V1 controls:

- add 2FA for accounts that can buy or operate paid compute
- require a fresh authentication checkpoint for dangerous billing actions
- require a stronger identity signal before:
  - adding or changing payment methods
  - buying memberships or seat packages above a threshold
  - creating or resizing dedicated hosts
  - changing invoice or payout-critical account settings
  - transferring or reclaiming institutional entitlements

The first practical version can be TOTP-based 2FA.

Passkeys/WebAuthn can be a later improvement, but the release should not ship
paid compute without some second-factor path.

Design principle:

- a verified password alone is not a strong enough proof of identity for
  dangerous actions in a paid-compute product

### 5. Infrastructure abuse

Dedicated hosts and project compute create the classic abuse vectors:

- crypto mining
- proxy/VPN resale
- credential stuffing and post-compromise spend
- mass host creation using stolen cards

V1 controls:

- dedicated-host eligibility should be gated by membership tier and trust level
- new accounts should not immediately get broad host-spend rights
- host spend limits should be rolling-window based and admin-configurable
  - 5-hour window
  - 7-day window
- host creation/start/resize should record who did it and under what trust state
- risk review and emergency suspension must be possible without corrupting the
  billing ledger

Design principle:

- the product should prefer reviewable throttling and suspension over silent
  overexposure

### 6. Operator and auditability requirements

Abuse handling fails if operators cannot see cluster-wide state quickly.

V1 should include:

- account risk flags
- package risk flags
- payment risk flags
- ability to suspend:
  - purchases
  - claims
  - dedicated-host creation
  - package assignment
- cluster-visible audit trails for:
  - grant creation/revocation
  - package purchase/expansion
  - institutional claim/release
  - `usage_account_id` changes
  - dangerous billing and host actions

Design principle:

- abuse controls must work across bays, not only within one account home bay

### Recommended release priorities

From the abuse/safety point of view, the near-term order should be:

1. ensure payment maintenance and entitlement activation are trustworthy
2. implement 2FA and fresh-auth checkpoints for dangerous actions
3. finish email verification and reCAPTCHA support
4. add canonical institutional claim dedupe
5. add operator risk flags and suspension controls
6. add dedicated-host trust gating before broader host rollout

## Summary

The correct V1 split is:

- account-owned billing history and owned packages live on the account home bay
- project-specific course and usage state live on the project owning bay
- institution-wide claim scopes and canonical identity dedupe live on seed/global
- cross-bay discovery uses seed-global projections, not scans

This is more work than the earlier one-bay-assuming version of the plan, but it
is the correct architecture and avoids building billing state that would break
under the real multi-bay deployment.

## Further TODO

- [ ] update the master release plan to remove the obsolete `seed-owned purchases/billing authority for first release` assumption
- [ ] implement canonical `+alias` identity dedupe for domain/site claims
      [ ] ensure that subscription maintenance, statements, payment-intent processing, and automatic payments DO run. Right now gated behind kucalc and commercial flags.
- [ ] add Cloudflare Email Service support for verification and notifications
- [ ] add `cocalc-cli` operator/testing support for package, claim, and rehome flows
- [ ] abuse mitigation:
  - [ ] 2FA / MFA for paid-compute accounts
  - [ ] fresh-auth checkpoints for dangerous billing and host actions
  - [ ] captcha -- finish implementing support
  - [ ] Stripe Radar integration and payment-risk handling policy
  - [ ] chargeback/refund-driven entitlement suspension policy
  - [ ] operator risk flags and cluster-wide abuse audit surfaces
