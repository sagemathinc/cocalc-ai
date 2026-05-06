# Membership / Billing / Dedicated Hosts V1 Plan

## Purpose

This document is the concrete V1 plan for the last major user-visible release
blocker in `cocalc-ai`:

- individual memberships
- student pay
- instructor-paid course access
- team licenses
- domain / site licenses
- dedicated host pricing and billing

The plan is grounded in the current `cocalc-ai` codebase and is explicitly
trying to avoid a large architectural rewrite.

## Core Product Goals

1. Memberships must be account-wide, not project-scoped.
2. Billing and limits must be easy for users to understand.
3. Course / teaching workflows must not unfairly bill or throttle instructors
   for student activity.
4. Dedicated hosts must be useful and competitive, especially for spot-backed
   research / Codex / long-running compute workflows.
5. The implementation must leverage existing membership, purchases, statement,
   and throttling infrastructure instead of inventing a second system.

## What Already Exists

### Memberships and entitlements

- Membership resolution is already account-based in
  `src/packages/server/membership/resolve.ts`.
- Membership tiers are already admin-configurable in
  `src/packages/server/membership/tiers.ts` and
  `src/packages/util/membership-tier-templates.ts`.
- Membership store checkout already exists in
  `src/packages/server/purchases/purchase-shopping-cart-item.ts` and
  `src/packages/server/purchases/shopping-cart-checkout.ts`.

### Usage limits and throttling

- Storage / project-count accounting is currently owner-based in
  `src/packages/server/membership/usage-status.ts`.
- Snapshot / backup limits are currently owner-based in
  `src/packages/server/membership/project-limits.ts`.
- Managed egress fallback attribution is currently owner-based in
  `src/packages/server/membership/managed-egress.ts`.

### Student pay

- Course projects already carry student identity in
  `src/packages/util/db-schema/projects.ts` via `course.account_id` and
  `course.email_address`.
- Student pay already exists in
  `src/packages/server/purchases/student-pay.ts`.
- The current implementation creates a purchase and marks `course.paid`, but it
  does **not** grant a membership tier.

### Statements and monthly billing

- Statements already exist in `src/packages/server/purchases/statements/*`.
- Monthly statement generation already exists in
  `src/packages/server/purchases/statements/create-statements.ts`.
- Emailing and browsing statements already exists in
  `src/packages/server/purchases/statements/email-statement.ts`.
- There is existing Stripe collection machinery, but the product model should
  remain statement- and purchase-based, not Stripe-subscription-driven.

### Dedicated hosts

- Host creation gating already exists in
  `src/packages/server/conat/api/hosts.ts`.
- Host placement entitlement checks already exist in
  `src/packages/server/project-host/placement.ts`.
- Dedicated VM / disk catalog and retail pricing helpers already exist in
  `src/packages/util/upgrades/dedicated.ts` and
  `src/packages/util/purchases/quota/dedicated-price.ts`.
- What does **not** exist yet is a complete dedicated-host billing model,
  provider price sync, or host charge ledger.

## Decisions Locked In

These decisions are the basis of the implementation plan.

### 1. Memberships are account-wide

This is non-negotiable. We are not going back to project-scoped paid upgrades.

Consequences:

- `student pay` grants an account-wide `student` membership for the course term.
- team / domain / site access grants account-wide memberships.
- membership resolution stays account-based.

This is far easier for users to understand and aligns with the current
resolver and tier code.

### 2. Add `projects.usage_account_id`

We need a first-class way to say which account's limits a project consumes.

Without this, course and sponsored collaboration workflows remain confusing and
unfair.

Resolution rule for project usage attribution:

1. `projects.usage_account_id`, if set
2. otherwise `course.account_id` for `course.type == "student"`
3. otherwise project owner

This resolved usage account must drive:

- storage accounting
- project-count accounting
- snapshot / backup limits
- project-level background egress attribution

### 3. No separate egress fee for dedicated hosts

Dedicated-host network usage is **not** billed separately.

Instead:

- egress policy / caps are part of the user's membership
- `cocalc-ai` is not positioning itself as generic public web hosting
- this keeps costs predictable for users

### 4. Dedicated hosts are billed to the host owner

Not the project owner, not collaborators, not the usage account.

This keeps the dedicated-host product simple:

- one host has one billing owner
- one monthly statement shows membership + host charges

### 5. Dedicated hosts are not prepaid-balance-gated

The `cocalc.com` prepaid-only model is not the right product model here.

Instead:

- membership tier unlocks dedicated-host eligibility and a monthly spend limit
- usage is billed monthly with a single statement / invoice flow
- account trust is membership-gated and admin-overridable

### 6. Dedicated host spot pricing cannot be frozen for long periods

On-demand pricing is relatively stable and can be snapshotted.

Spot pricing is different:

- provider spot prices can change significantly
- those changes can be large enough that freezing prices for long periods is
  operationally unsafe

Therefore:

- we need provider price sync
- spot-backed hosts must be billed from a local synced provider catalog
- host billing must be based on discrete rate-change events over time

This does **not** mean live cloud pricing APIs in the user request path.
It means background synchronization into our own local pricing catalog.

## V1 Architecture

## Entitlements

Use one shared entitlement model for all non-personal membership sources.

### New table: `membership_grants`

One row per active or historical account-level grant.

Suggested fields:

- `id`
- `account_id`
- `membership_class`
- `source`
  - `student-pay`
  - `course-seat`
  - `team-seat`
  - `domain-license`
  - `site-license`
  - `admin` can remain in the legacy table for now
- `package_id` nullable
- `purchase_id` nullable
- `granted_by_account_id` nullable
- `starts_at`
- `expires_at`
- `revoked_at`
- `metadata`

### New table: `membership_packages`

One row per seat pool / license package owned by a paying account or created by
sales / admins.

Suggested fields:

- `id`
- `owner_account_id`
- `kind`
  - `course`
  - `team`
  - `domain`
  - `site`
- `membership_class`
- `seat_count`
- `starts_at`
- `expires_at`
- `purchase_id`
- `metadata`

### Package amendments

Course and team packages must support seat-count increases during the active
term.

V1 rule:

- a package can be expanded by buying additional seats
- the added seats use the same per-seat price for that package / term
- there is no prorating logic
- there is no retroactive recalculation of earlier seats

Implementation-wise, this can be represented either by:

- increasing `seat_count` on the package and attaching another purchase, or
- a small `membership_package_adjustments` table

The important product rule is simpler than the storage model:

- "add 5 more students"
- charge 5 more seats at the ordinary package seat price
- do not introduce prorated complexity

### New table: `membership_package_assignments`

This is needed to support reserved seats before the recipient account exists and
to cleanly manage course / domain / team seat assignment.

Suggested fields:

- `id`
- `package_id`
- `account_id` nullable
- `email_address` nullable
- `project_id` nullable
- `grant_id` nullable
- `assigned_by_account_id`
- `assigned_at`
- `revoked_at`
- `metadata`

This table is the bridge between:

- a package with capacity
- a known or not-yet-known user
- an actual `membership_grant`

### Keep `admin_assigned_memberships` for now

Do **not** migrate or replace it before release.

Instead:

- keep the current admin override path
- extend the resolver to read both admin assignments and grants

### Membership resolver update

`src/packages/server/membership/resolve.ts` must resolve membership candidates
from:

- active personal membership subscription
- active admin assignment
- active membership grants
- free tier fallback

Selection rule:

- highest tier priority wins
- source is mainly descriptive
- source-specific tie-breaking should only matter for display, not for
  semantics

## Usage attribution

### New field: `projects.usage_account_id`

Add a nullable `usage_account_id` to `projects`.

Use it in:

- `src/packages/server/membership/usage-status.ts`
- `src/packages/server/membership/project-limits.ts`
- `src/packages/server/membership/managed-egress.ts`

### Attribution rules

#### Project-level limits

The resolved usage account controls:

- total storage limits
- total project count
- backup limit per project
- snapshot limit per project

#### Egress attribution

Split this into two cases:

1. user-attributable egress
   - charge to the acting account when known
2. project/background egress
   - charge to the resolved usage account

Examples:

- student downloading or proxying from a course project:
  - student account
- backup upload from a course project:
  - project usage account, which should be the student

This fixes the current unfair instructor attribution problem.

## User-visible product model

## Personal memberships

These remain very close to what already exists:

- personal paid memberships are bought through the existing store and shopping
  cart flow
- the selected membership tier remains account-wide

The key changes are:

- more explicit tier messaging
- new tier fields for dedicated-host financial limits
- clearer display of why the user has a given tier

## Student pay

### Product behavior

When a student pays a course fee:

1. create the purchase
2. mark `course.paid`
3. grant the student an account-wide `student` membership for the course term
4. ensure `projects.usage_account_id` points at the student

### Implementation surface

Backend:

- update `src/packages/server/purchases/student-pay.ts`

Frontend:

- keep `src/packages/frontend/purchases/student-pay/*`
- change the copy to make the result explicit:
  - paying the course fee activates a student membership for the course term

### Important note

`student` remains a hidden tier in the general store.

It is granted through:

- student pay
- instructor-paid course seats
- possibly site arrangements

It is not a normal self-serve public tier.

## Instructor-paid courses

Use `membership_packages` and `membership_package_assignments`.

### Product behavior

An instructor or institution buys a `course` package:

- package kind: `course`
- membership class: usually `student`
- seat count: number of students
- term: course duration

If enrollment grows later, they can buy more seats for the same package without
any prorating logic.

Then the instructor assigns seats to course student projects.

Assignment creates:

- a package assignment
- a membership grant once the student account is known
- `usage_account_id` on the student project

### Important compatibility point

We already have:

- `course.account_id`
- `course.email_address`
- `course.project_id`
- `course.path`

These are enough to integrate course seats without inventing a whole new course
billing model.

## Team licenses

This should use the same package / assignment / grant machinery.

### Product behavior

A paying account buys a `team` package:

- fixed seat count
- fixed membership class, likely `member` or `pro`

If the team grows, the owner can add more seats later at the same seat price
without prorating.

Then they assign seats to specific accounts.

Each active assignment yields an active grant.

### V1 constraints

Do not build a full organization model before release.

V1 only needs:

- buy seats
- assign seats
- revoke seats
- show who currently has them

## Domain / site licenses

This should also use packages + assignments + grants, but **not** be fully
self-serve before release.

### Product behavior

Sales / admins create a package:

- `domain` or `site`
- seat count / policy
- membership class
- list of allowed verified domains in metadata

Users can then:

- be assigned manually, or
- claim a seat if they have a matching verified domain

Claiming or assignment creates the grant.

### Release scope

Do not build a full campus procurement or self-serve institution flow before
release.

Admin / sales-assisted setup is acceptable and probably preferable.

## Dedicated hosts

Dedicated hosts are a separate billing problem from memberships.

Memberships decide whether a user may use dedicated hosts and how much monthly
risk / spend we are willing to extend to them by default.

### Membership tie-in

Each membership tier should include:

- whether host creation is allowed
- allowed project-host tier
- default dedicated-host monthly spend limit

The first two already exist conceptually via:

- `features.create_hosts`
- `features.project_host_tier`

We should add a new limit in membership usage or feature data, e.g.:

- `dedicated_host_monthly_spend_limit_usd`

This is a product / risk control parameter, not a compute resource limit.

Admins must be able to override it for specific customers.

## Dedicated host pricing model

### High-level model

The user sees:

- one membership charge per month
- one charge line per dedicated host per month
- line-item detail in the host drawer explaining how that charge was computed

There is **no** separate egress fee.

### Retail catalog

We should expose only a curated public catalog of dedicated host options.

Reasons:

- simpler UI
- simpler support
- lower pricing-sync complexity
- lower financial risk from spot volatility

The current all-of-GCP-style surface from legacy CoCalc is overkill for
`cocalc-ai`.

### Provider pricing sync

We need background jobs to sync provider price data into a local pricing
catalog.

Especially for:

- GCP spot pricing
- Nebius pricing, where applicable

This sync is not on the user request path.

Instead:

- sync provider prices periodically into local tables or cached records
- host creation / resize reads from that local catalog

### New table: `cloud_provider_prices`

One local synced catalog for the small supported machine / disk set.

Suggested fields:

- `provider`
- `region`
- `sku_type`
  - `vm-on-demand`
  - `vm-spot`
  - `disk`
- `spec_key`
- `price_hourly_usd` or `price_monthly_usd`
- `effective_at`
- `observed_at`
- `metadata`

This table is authoritative for host pricing decisions inside `cocalc-ai`.

### New table: `project_host_rate_events`

We need a history of rate changes per host.

Suggested fields:

- `id`
- `host_id`
- `effective_at`
- `reason`
  - `create`
  - `resize`
  - `disk-grow`
  - `pricing-model-change`
  - `provider-price-sync`
  - `spot-to-standard`
  - `standard-to-spot`
- `requested_pricing_model`
- `effective_pricing_model`
- `vm_spec`
- `disk_spec`
- `vm_hourly_usd`
- `disk_hourly_usd`
- `lower_bound_hourly_usd` nullable
- `upper_bound_hourly_usd` nullable
- `metadata`

This is the core of the billing model. We do **not** want to recover host
charges by replaying cloud history heuristically from current host metadata.

### What gets charged

For each host, charges come from time segments between `project_host_rate_events`.

The charge basis is:

- VM charges while the VM is in a billable running state
- disk charges while the dedicated disk exists

This means:

- stopped VM can still have disk charges
- resizing disk or VM creates a new rate event

### Spot pricing

Spot pricing is the hard part.

We should not oversimplify it away. Dedicated-host users are exactly the users
who care about this.

#### Policy

1. Pure on-demand host
   - price can be snapshotted from the local catalog until config change
2. Pure spot host
   - price follows the synced local spot catalog over time
   - upstream spot price changes create new `project_host_rate_events`
3. Spot-to-standard strategy
   - user explicitly opts in
   - UI shows lower and upper spend bounds
   - user configures an additional bound such as max standard time per month

#### Why this is necessary

Spot price changes can be large enough that freezing spot pricing for long
periods is financially unsafe.

At the same time, charging the user arbitrary emergency standard fallback rates
without explicit UX would be unacceptable.

Therefore the system must be explicit:

- show the user the pricing mode
- show the possible spend range
- record discrete rate-change events

### Spend limit policy

Each membership tier gets a default monthly dedicated-host spend limit.

Examples:

- small membership: no dedicated host
- medium membership: small experimentation allowance
- high membership: much larger default monthly host budget

This is **not** a prepaid balance.

It is a default allowed monthly exposure level.

Before create / start / upward resize:

- compute projected monthly spend for the chosen host configuration
- compare against the account's dedicated-host monthly limit

For variable spot strategies:

- use the explicit upper-bound model shown to the user

Admins can override these limits for important accounts.

### Monthly billing model

The product model is:

- one monthly statement
- one monthly charge collection
- line items for memberships and each dedicated host

We should reuse the existing purchase and statement system in:

- `src/packages/server/purchases/statements/*`
- the existing invoice / collection path that already supports monthly billing

Strategically:

- do not expand reliance on Stripe-native subscription semantics
- keep CoCalc's own purchase / statement ledger authoritative

### Host drawer UX

The host drawer should show:

- current pricing mode
- current effective hourly / monthly rate
- if variable, lower and upper bound
- current month's accrued cost so far
- detailed rate-change history
- exact explanation of why the monthly line item is what it is

This is critical for trust.

## What We Are Explicitly Not Doing Before Release

- no return to project-scoped upgrade licenses
- no separate dedicated-host egress billing
- no full institution self-serve procurement flow
- no giant public dedicated-host machine catalog
- no attempt to make `software_licenses` serve hosted memberships

## Implementation Plan

## Phase 1: entitlement foundation

1. add `membership_grants`
2. add `membership_packages`
3. add `membership_package_assignments`
4. extend `src/packages/server/membership/resolve.ts`
5. extend `src/packages/conat/hub/api/purchases.ts`

## Phase 2: usage attribution fix

1. add `projects.usage_account_id`
2. implement shared project usage-account resolver
3. update:
   - `src/packages/server/membership/usage-status.ts`
   - `src/packages/server/membership/project-limits.ts`
   - `src/packages/server/membership/managed-egress.ts`

This phase is required before course / team / site flows are truly correct.

## Phase 3: student pay

1. update `src/packages/server/purchases/student-pay.ts`
2. grant `student` membership for course term
3. update student pay UI copy
4. show membership source clearly in the account UI

## Phase 4: instructor-paid courses

1. add course package purchase flow
2. add seat assignment UI bound to course projects
3. set / maintain `usage_account_id`
4. grant / revoke course student memberships

## Phase 5: team and domain/site licenses

1. add team package flow
2. add admin / sales-assisted domain / site package flow
3. add seat claim / assignment UI
4. add account page to show why a grant is active

## Phase 6: dedicated host billing

1. add local provider pricing sync
2. add `project_host_rate_events`
3. add host charge generation worker
4. integrate host charges into monthly statements
5. add host drawer pricing / charge breakdown UI
6. add membership-tier dedicated-host spend limits and admin overrides

## Questions Deferred Until After Release

- exact seat-claim automation for verified domains
- whether course packages need special bundle pricing beyond ordinary seat math
- long-term shape of institution / department admin UX
- whether to keep or retire legacy Stripe usage-based subscription helpers
- whether dedicated-host spend limits should eventually become more risk-based
  per provider / per pricing model

## Summary

The smallest coherent V1 is:

- account-wide memberships
- `projects.usage_account_id`
- one grants/packages model for student / course / team / site access
- dedicated hosts billed monthly as metered infrastructure, with a local synced
  provider catalog and explicit rate-change history

This keeps the system understandable for users, fits the existing codebase, and
does not require a large rewrite.
