# Membership And Usage Limits Release Spec

Status: proposed first-release policy and architecture spec as of 2026-04-25.

This document defines the first-release model for user-facing limits and the
minimum multibay architecture needed to enforce them safely at public scale.

It is driven by three product requirements:

1. limits must be easy for users to understand
2. limits must protect CoCalc from abuse and runaway cost
3. shared infrastructure must stay burst-friendly rather than pretending to be
   dedicated hardware

This spec is intentionally conservative. It is for a scalable public release,
not a final forever pricing model.

Related documents:

- [scalable-architecture-release-checklist-2026-04-24.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-release-checklist-2026-04-24.md)
- [membership.md](/home/user/cocalc-ai/docs/membership.md)
- [project-disk-usage.md](/home/user/cocalc-ai/src/.agents/project-disk-usage.md)
- [app-server.md](/home/user/cocalc-ai/src/.agents/app-server.md)

## Strategic Decision

For shared-host CoCalc, do **not** present explicit CPU and RAM numbers as the
main contract.

Instead, the user-facing contract should be:

- shared compute is priority-based
- storage and project-count limits are explicit
- egress limits are explicit where provider cost risk exists
- users who need guaranteed more can rent a dedicated project host

This is a product simplification, not a technical shortcut. Shared compute is
inherently elastic and overcommitted. Pretending otherwise creates confusion,
support burden, and poor user expectations.

## Goals

1. Keep the pricing and membership story understandable in one screen.
2. Prevent individual users from causing disproportionate cost or resource
   exhaustion.
3. Let idle/shared capacity be used opportunistically when the system is quiet.
4. Keep first-release implementation compatible with multibay routing and
   account ownership.
5. Preserve a clear paid escape hatch for users who need stronger guarantees.

## Non-Goals

1. Precise per-user CPU accounting on shared hosts.
2. Explicit dedicated-style CPU/RAM promises on shared hosts.
3. Pay-as-you-go metering for normal users.
4. Perfect real-time global accounting for every limit.
5. A final enterprise billing and quota model.

## User-Facing Limit Model

The first public release should expose exactly these shared-host concepts.

### 1. Compute Priority

Users get a membership-defined shared compute priority, such as:

- `Basic`
- `Standard`
- `Pro`

This should be described in user-facing copy as:

- priority on shared compute
- burstable when the system is quiet
- higher memberships get better performance under contention

It should **not** be described as:

- exact CPU counts
- exact guaranteed RAM
- exact scheduler slices

Internally, projects may still have runtime defaults and safety limits, but the
product contract is priority, not dedicated hardware.

### 2. Per-Project Storage

Each project has a hard storage cap.

This is easy to understand and should remain explicit in user-facing surfaces.
It is the primary answer to:

- how much data can one project hold?

This limit is membership-derived at project start and enforced locally by the
project host.

### 3. Total Account Storage

Each account has a soft total-storage cap across all projects it owns.

This is the primary protection against a user creating many individually legal
projects that together consume excessive storage.

This should be explained as:

- total storage across all your projects

When exceeded, the system should warn clearly and progressively restrict actions
that would increase total storage further.

### 4. Project Count

Each account has a hard limit on the number of projects it may own.

This should be:

- generous
- simple
- checked centrally

This is not mainly a cost control. It is a safety and abuse guardrail.

### 5. Data Transfer

Each account has data-transfer limits for shared-host usage on metered-egress
providers.

The initial model should mirror the already successful LLM-limit pattern:

- a rolling `5-hour` window
- a rolling `7-day` window

This should be explained as:

- data transfer/download limits on shared infrastructure

The purpose is not user micro-billing. The purpose is preventing a single user
from generating catastrophic outbound-transfer cost.

### 6. Dedicated Host Escape Hatch

Every relevant limit/error surface should include the product answer:

- need more? rent a dedicated project host

That path is the explicit upgrade for users who need stronger compute or egress
behavior than shared infrastructure should promise.

## What Users Should See

The user-facing membership/limits page should present:

1. compute priority on shared hosts
2. per-project storage
3. total account storage
4. number of projects
5. data transfer
6. dedicated-host option

It should not require users to understand:

- bays
- host placement
- cloud provider differences
- control-plane topology
- exact CPU/RAM scheduler details

Provider-specific egress behavior can appear in explanatory copy, but the main
product model should stay membership-centric and simple.

## Enforcement Semantics

Not all limits should behave the same way.

### Compute Priority

Type:

- soft, scheduler-enforced

Behavior:

- all shared projects may burst when resources are idle
- under contention, higher-priority memberships win more CPU scheduling share
- internal host safety limits may still stop pathological overuse

User impact:

- performance degrades under contention rather than a hard CPU cap appearing

### Per-Project Storage

Type:

- hard

Behavior:

- enforced at the project-host level
- writes that would exceed quota fail

User impact:

- project shows explicit quota usage and clear failure reasons

### Total Account Storage

Type:

- soft, centrally aggregated

Behavior:

- usage is computed periodically, not necessarily on every write
- once over limit, the system warns and blocks storage-increasing operations

Initial blocked operations should include:

- creating new projects
- copying/importing/restoring projects
- increasing project storage settings
- other explicit storage-expanding workflows

Initial non-goals:

- abruptly killing running projects just because total account storage is over
  soft cap

### Project Count

Type:

- hard

Behavior:

- checked centrally on create/copy/import/undelete-style operations

### Data Transfer

Type:

- hard cost-protection limit

Behavior:

- enforced on shared-host traffic that creates real paid egress risk
- short-window breaches temporarily block further outbound transfer
- long-window breaches continue blocking until the window decays or an operator
  override occurs

Initial non-goals:

- charging users per GB
- shutting down compute just because download/export egress is blocked

## Multibay Architecture

The architecture should separate:

1. central entitlements
2. periodic global rollups
3. near-real-time cost-safe budget enforcement

### A. Central Entitlements

Authoritative account entitlements should stay centrally owned and include:

- compute priority class
- per-project storage default
- total account storage cap
- max owned project count
- egress caps
- dedicated-host-related feature flags

This should build on the existing membership resolver and tier system rather
than inventing a second entitlement mechanism.

### B. Project-Host Local Enforcement

Project hosts should remain responsible for:

- per-project hard storage enforcement
- local runtime scheduling and contention behavior
- local observation of egress-producing actions

This keeps hot-path enforcement near the resource being consumed.

### C. Periodic Global Rollups

The following are acceptable as periodic central rollups:

- total account storage usage
- owned project count materialization if needed for speed

These do not need sub-second perfect consistency.

They do need:

- one clear central source of truth
- predictable recomputation
- admin visibility when stale

### D. Leased Egress Budgets

Egress is the multibay-sensitive part and should not central-roundtrip every
download chunk.

The release architecture should use leased budgets:

1. a central authority maintains per-account rolling-window usage
2. each bay or project host acquires a small temporary budget lease for an
   account
3. local transfers spend from that lease without per-request hub roundtrips
4. when a lease is exhausted, the host requests another
5. once central policy says the account is at or near cap, no new lease is
   granted

This gives:

- low control-plane overhead
- bounded overshoot
- global cost safety
- multibay compatibility

This is the same architectural pattern that should be preferred for any future
global-but-hot usage limit.

## Provider Policy

The initial egress policy should be provider-aware.

### Metered-Egress Providers

Examples:

- GCP shared hosts

Policy:

- strict rolling-window egress limits
- stronger warnings
- stricter defaults

### Free-Or-Cheap-Egress Providers

Examples:

- Nebius
- R2-backed downloads where egress is effectively free

Policy:

- relaxed or zero egress caps where appropriate
- still keep abuse controls available

The user-facing product language should remain simple. Provider-specific rules
are an implementation detail unless they materially affect user expectations.

## Membership Data Model Direction

The current membership system already has:

- `project_defaults`
- `llm_limits`
- `features`

For release, add a first-class structured limits area rather than scattering
new usage policy across unrelated fields.

Suggested direction:

```ts
usage_limits: {
  shared_compute_priority: "basic" | "standard" | "pro";
  total_storage_bytes: number;
  max_projects: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  egress_policy?: "metered-only" | "all-shared-hosts" | "disabled";
}
```

Notes:

- per-project storage should continue living in `project_defaults` or equivalent
  project-start settings
- LLM limits should remain separate; their rolling-window model is the product
  precedent for egress limits

## Required User-Facing Copy Principles

Every limits surface should follow these rules:

1. say what the user gets, not how the scheduler works
2. say clearly whether a limit is per project or across the account
3. say whether a limit is hard or soft in normal-language terms
4. always show the “dedicated host” escape hatch where relevant
5. avoid cloud-provider jargon unless necessary for a warning

Examples:

- good: `Shared compute priority: Pro`
- bad: `You get 2 CPUs but may burst to 6`

- good: `Total storage across your account: 200 GB`
- bad: `Aggregate qgroup quota across all projects`

- good: `Data transfer: 20 GB / 5 hours, 200 GB / 7 days`
- bad: `Network egress throttling subject to provider billing`

## Admin And Ops Requirements

Before release, operators should have:

1. one place to inspect effective limits for an account
2. one place to inspect current usage for:
   - total account storage
   - project count
   - egress windows
3. one place to inspect whether a limit is currently blocking actions
4. an override path for support/emergency cases
5. enough logs/metrics to explain why an action was blocked

Without this, the limit model will generate support pain even if the backend
logic is correct.

## Release-Phase Build Order

This should be implemented in this order.

### Phase 1. Freeze The Product Contract

1. Approve the five user-facing shared-host limits.
2. Approve the dedicated-host escape hatch language.
3. Decide the initial membership-tier values.

### Phase 2. Finish The Cheap, Clear Limits

1. per-project storage hard limit
2. total account storage soft limit
3. project-count hard limit

These are easier to explain and implement than egress, and they already cover a
large fraction of real abuse/cost risk.

### Phase 3. Implement Egress Metering

1. define what counts as metered egress
2. implement central rolling-window usage storage
3. implement leased egress budgets
4. expose block reasons and remaining allowance in the UI/admin tools

### Phase 4. Integrate With Membership UI

1. show limits clearly on the membership/store surface
2. show current usage where it matters
3. ensure over-limit errors are understandable and actionable

## Open Questions

These should be answered during implementation, not before the spec is useful.

1. Which specific outbound paths count toward egress first release?
   - direct file download
   - project export/copy out
   - rustic backup traffic on metered hosts
   - app-server public traffic
2. Should dedicated hosts bypass shared-host egress caps entirely, or only
   when the user is clearly paying for the host?
3. How aggressive should total-account-storage restrictions be once over soft
   cap?
4. Do we need a visible “project size” concept in v1, or is compute priority
   plus storage enough?
5. Which limits need self-service UI, and which should be admin-only at first?

## Recommended Immediate Next Steps

1. Review and approve this spec as the release policy direction.
2. Add the missing limit category to the main release checklist if needed.
3. Choose initial tier numbers for:
   - compute priority
   - per-project storage
   - total account storage
   - project count
   - egress windows
4. Build the implementation tracker in the same order as the phases above.

The key discipline is:

- keep the user contract simple
- keep enforcement near the resource where possible
- keep global cost protection centralized where necessary
- do not reintroduce explicit shared-host CPU/RAM promises
