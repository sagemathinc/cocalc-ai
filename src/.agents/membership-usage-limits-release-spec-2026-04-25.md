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

Each account has both:

- a soft total-storage cap across all projects it owns
- a hard total-storage cap across all projects it owns

This is the primary protection against a user creating many individually legal
projects that together consume excessive storage.

This should be explained as:

- total storage across all your projects

The soft cap is the normal warning and degradation threshold.

The hard cap is the emergency safety threshold that prevents an account from
continuing to grow storage indefinitely.

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

The first release should not include general self-service limit tuning by end
users. The intended model is:

- your membership tier determines your shared-host limits
- support/admin tools can override or inspect limits when necessary

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

- soft + hard, centrally aggregated

Behavior:

- usage is computed periodically, not necessarily on every write
- once over soft limit, the system warns and blocks storage-increasing
  operations
- once over hard limit, the system enters an aggressive protection mode

Soft-cap blocked operations should include:

- creating new projects
- copying/importing/restoring projects
- increasing project storage settings
- other explicit storage-expanding workflows

Hard-cap behavior should be intentionally aggressive. Initial release guidance:

- allow downloading and deleting data
- block normal storage-increasing operations
- block UI actions that would predictably increase storage further
- do not depend on perfect real-time accuracy before acting conservatively

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

## Project Ownership And Membership Semantics

The first release should use one simple rule:

- the project owner's membership tier governs the project's entitlement class

This rule should determine:

- base shared-compute priority
- per-project storage defaults and caps
- project-count ownership semantics
- total-account-storage attribution
- the default egress policy applied to the project on shared infrastructure

Collaborators should not upgrade or downgrade the project's entitlement class by
starting or using the project.

However, collaborator activity should still count as real interactive usage for:

- recent-interactive-use signals
- eviction protection on shared hosts
- other host-local “someone is actively using this project” logic

This keeps the user-facing rule simple and avoids abuse patterns where low-tier
projects are silently upgraded by having a higher-tier collaborator start them.

## Shared-Host Project Stopping Policy

The first-release shared-host stopping policy should **not** be based on one
global fixed idle timeout.

Historically, simple fixed idle timeouts were easy to implement, but they are a
poor fit for a burstable shared system:

- they create pointless churn when the host is quiet
- they are easy for users to misinterpret as the real product contract
- they do not reflect membership priority
- they do not distinguish between recent interactive use and forgotten
  background projects

The release policy should instead be:

- no routine stopping when a shared host is quiet
- pressure-based stopping when a shared host is busy
- eviction order based on membership priority and recent interactive use
- a long backstop scavenger for ancient idle projects

### User-Facing Product Contract

The user-facing description should be simple:

- projects stay running while you are actively using them
- when shared hosts are busy, inactive lower-priority projects are paused first
- higher memberships keep projects running longer under contention
- dedicated hosts are not subject to shared-host pausing policy

This is a better product contract than:

- `projects stop after 30 minutes`
- `projects always stop after 2 hours`

Those statements are easy to understand but operationally wrong for a system
that should opportunistically use idle capacity.

### Main Triggers

Project stopping should be triggered primarily by host pressure, especially:

- memory pressure
- need to start another project and make room
- too many running projects on one host

CPU pressure alone should usually not be the main reason to stop projects.

Shared-host CPU contention should mostly be handled by scheduler priority.
Project stopping should mainly reclaim:

- memory
- process slots
- operational headroom

### Eviction Order

Each project host should compute an eviction score for stoppable projects.

The most important inputs should be:

- membership priority
- recent interactive usage
- whether a browser is currently attached
- number of active collaborators
- how recently the project was foregrounded

Secondary inputs may include:

- current memory footprint
- whether kernels/terminals/processes are running
- whether the project exposes a public app/service
- whether the project is on a dedicated host

Critical design rule:

- recent human interaction should outrank background compute activity

Otherwise, a runaway background job can keep a project alive indefinitely while
more valuable interactive work gets displaced.

### Minimum Protection Window

After meaningful interactive use, a project should receive a minimum temporary
protection window before it becomes evictable under normal host pressure.

The exact number can be tuned later, but the release design should assume a
short protection window such as:

- `15-30 minutes` after recent interactive use

This prevents the user experience from feeling random or hostile when a person
has just used a project and briefly steps away.

### Long Idle Scavenger

Separate from pressure-based eviction, there should be a very long backstop
scavenger for truly stale projects.

This is not the main policy. It is just operational cleanup.

Release guidance:

- if a project has been totally inactive for multiple days, it can be stopped
  even without immediate host pressure

This protects against silent shared-host accumulation without making the main
product promise depend on a short fixed timeout.

### Dedicated Hosts

Projects on dedicated hosts should not be governed by the shared-host stopping
policy.

Dedicated hosts may still have explicit local admin policies, but they should
not be treated as part of the shared-host eviction pool.

### Multibay Architecture For Stopping

The stop decision should be host-local, not global.

Central state should provide:

- account membership priority
- dedicated-host-related entitlements or exemptions
- any account-level policy knobs that materially affect eviction

But the actual stop decision should happen on the project host using local
pressure and recent project activity signals.

This keeps the system:

- responsive
- scalable
- consistent with the multibay architecture

### Membership Policy Direction

The first release should keep the membership-side knobs small.

Recommended internal policy shape:

- `shared_compute_priority`
- `idle_protection_window`
- optional dedicated-host exemption

Do not expose all of these internal knobs directly to users.

The user-facing story should remain:

- better memberships get better shared-host priority
- recently active projects are favored over forgotten inactive ones

### Recommended Immediate Product Rule

For first release, the stopping rule should be summarized internally as:

1. do not stop projects just because a short fixed idle timer expired
2. stop projects when host pressure requires it
3. evict lower-priority, less-recently-interactive projects first
4. keep a short post-interaction protection window
5. keep a long stale-project scavenger
6. exempt dedicated hosts from this shared-host policy

This is the correct release posture for a burstable, priority-based shared
compute system.

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

Egress is the multibay-sensitive part, but not all egress is the same.

The release design should split egress into two traffic classes with different
authoritative meters.

#### Managed Egress

Managed egress is traffic that leaves CoCalc through a CoCalc-controlled proxy
or service path.

Examples:

- direct file downloads
- app-server public traffic
- inbound SSH sessions where the user copies data out via `scp`, `sftp`, or
  `rsync`

For this traffic class:

- the proxy/service meter is authoritative
- the system may use leased budgets to avoid central-roundtripping every chunk

Recommended architecture:

1. a central authority maintains per-account rolling-window usage
2. each bay or project host acquires a small temporary egress budget lease for
   an account
3. local managed transfers spend from that lease without per-request hub
   roundtrips
4. when a lease is exhausted, the host requests another
5. once central policy says the account is at or near cap, no new lease is
   granted

This gives:

- low control-plane overhead
- bounded overshoot
- global cost safety
- multibay compatibility

#### Direct Project-Originated Egress

Direct project-originated egress is traffic initiated from inside the project to
the outside world.

Examples:

- outbound SSH from the project
- S3 uploads
- API/database writes
- arbitrary TCP/HTTP traffic from user code

For this traffic class:

- app-level proxy accounting is not sufficient
- project-container total interface TX bytes are not authoritative, because they
  overlap with managed traffic that may already be counted elsewhere
- the authoritative meter must come from host-local flow or socket attribution
  for traffic initiated by the project toward the public network

The first release does not need billing-grade precision here. It does need
credible cost protection.

#### Non-Authoritative Sanity Signals

Raw per-container or per-network-namespace byte counters are still useful, but
only as:

- anomaly detection
- coarse sanity checks
- operator/debugging signals

They should not be the final authoritative egress cap number, because they can
double-count traffic that first flows from project container to host proxy and
then from host proxy to the internet.

#### Practical Implementation Direction

Release guidance:

- meter managed traffic exactly at known proxy/service boundaries
- separately attribute direct project-originated outbound traffic at the host
  level
- roll both classes up centrally under the same account-level windows
- do not add the same bytes twice

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

### Dedicated Hosts

Dedicated hosts should not automatically be treated as uncapped.

First-release policy:

- if a dedicated-host offering has explicit paid or otherwise approved egress
  treatment, shared-host egress caps may be bypassed there
- otherwise, a dedicated host should continue to use conservative caps or
  temporary protections until dedicated-host egress metering and pricing are
  implemented clearly

This avoids creating a silent cost hole just because a workload moved from a
shared host to a dedicated host.

### Excluded First-Release Traffic

The following should not count toward user-facing egress caps in the first
release:

- rustic backup traffic

That traffic is treated as part of the storage/backups product behavior, not a
separate user-visible transfer allowance.

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
  shared_compute_priority: number; // 1 = lowest priority, larger = higher
  total_storage_soft_bytes: number;
  total_storage_hard_bytes?: number;
  max_projects: number;
  egress_5h_bytes?: number;
  egress_7d_bytes?: number;
  egress_policy?: "metered-shared-hosts" | "all-shared-hosts" | "disabled";
  dedicated_host_egress_policy?: "tier-capped" | "meter-and-bill" | "disabled";
}
```

Notes:

- per-project storage should continue living in `project_defaults` or equivalent
  project-start settings
- there is no need to hard-code specific tier numbers in this spec now; the
  important thing is agreeing on field semantics and units
- LLM limits should remain separate; their rolling-window model is the product
  precedent for egress limits
- user-facing copy may still present named classes such as `Basic`,
  `Standard`, and `Pro`, even if the internal entitlement value is numeric
- these fields should be owned by membership tiers and backend policy, not by
  ad hoc self-service per-project limit editing

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

User Search on the `/admin` page is one place that must have the above. Some project-host specific information could also be available on project hosts in their UI (under /hosts).

## Release-Phase Build Order

This should be implemented in this order.

### Phase 1. Freeze The Product Contract

1. Approve the five user-facing shared-host limits.
2. Approve the dedicated-host escape hatch language.
3. Approve the field semantics and units that membership tiers will carry.

### Phase 2. Finish The Cheap, Clear Limits

1. per-project storage hard limit (NOTE: this is mostly or completely finished)
2. total account storage soft limit (NOTE: nothing implemented yet here)
3. project-count hard limit (NOTE: nothing implemented here)

These are easier to explain and implement than egress, and they already cover a
large fraction of real abuse/cost risk.

### Phase 3. Implement Egress Metering

1. define the traffic classes that count as metered egress
2. implement central rolling-window usage storage
3. implement managed-egress proxy meters
4. implement direct project-originated outbound attribution on project hosts
5. implement leased budgets for managed traffic where appropriate
6. expose block reasons and remaining allowance in the UI/admin tools

Status:

- not done yet in a coherent way
- app servers already expose some usage metrics and can be reused
- file-server download paths and SSH proxy paths are obvious early candidates
- do not assume cgroups or Podman stats alone are sufficient for authoritative
  accounting, especially with rootless `pasta` networking

This does not have to be perfect. The goal is avoiding abuse or accidents that
cost a lot of money.

### Phase 4. Integrate With Membership UI

1. show limits clearly on the membership/store surface
2. show current usage where it matters
3. ensure over-limit errors are understandable and actionable

This phase also includes extending membership-tier configuration with the
structured limit fields needed by the release model.

## Open Questions

These are the main questions still worth resolving during implementation.

1. Which exact service paths count as managed egress in the first release?
   - direct file downloads: yes
   - app-server public traffic: yes
   - inbound SSH copy-out paths: yes
   - rustic backup traffic: no
2. What is the concrete host-level attribution mechanism for direct
   project-originated outbound traffic?
   - eBPF
   - nftables/conntrack with project tagging
   - other per-project flow attribution
3. Do we need an internal memory-priority or memory-class concept in addition to
   shared compute priority, even if it stays out of user-facing copy?
4. What is the least confusing dedicated-host egress policy for first release
   while dedicated-host pay-as-you-go egress is still unfinished?

## Detailed Implementation Plan

This plan is ordered to maximize release safety and minimize expensive
re-architecture.

### Track 1. Membership Entitlements And Resolver

1. Extend the membership tier schema with structured usage-limit fields:
   - `shared_compute_priority`
   - `total_storage_soft_bytes`
   - `total_storage_hard_bytes`
   - `max_projects`
   - `egress_5h_bytes`
   - `egress_7d_bytes`
   - `egress_policy`
   - `dedicated_host_egress_policy`
2. Update the existing membership resolver/backend code so each account has one
   clear effective limits object.
3. Make the project owner’s resolved tier the authoritative project
   entitlement source.
4. Expose the effective limits object through an internal admin API and the
   `/admin` user search surface.

### Track 2. Total Account Storage

1. Define the central rollup table or materialized usage source for
   per-account total storage.
2. Periodically aggregate storage across all owned projects.
3. Store both soft-cap and hard-cap comparisons centrally.
4. Enforce soft-cap degradation:
   - block new project creation
   - block import/copy/restore
   - block quota-increasing actions
5. Enforce hard-cap protection mode:
   - allow download and delete
   - block actions that increase storage
6. Expose current usage and block state in admin tools.

### Track 3. Project Count

1. Add a central owned-project count check to create/copy/import/undelete
   workflows.
2. Make the count semantics explicit:
   - ownership counts
   - collaboration does not
3. Expose current count and max count in admin tools and user-facing limits UI.

### Track 4. Shared-Host Scheduling And Stopping

1. Implement host-local eviction scoring using:
   - project owner priority
   - recent interactive usage
   - active browser/collaborator signals
   - optional memory footprint and app-service hints
2. Add a short post-interaction protection window.
3. Add a long stale-project scavenger.
4. Ensure dedicated hosts bypass this shared-host eviction pool.
5. Keep the stop decision host-local; do not centralize hot-path eviction
   decisions.

### Track 5. Managed Egress Metering

1. Enumerate and instrument all managed egress paths:
   - file-server downloads
   - app-server public traffic
   - SSH proxy copy-out traffic
2. Attribute managed egress to:
   - project
   - owner account
   - host/provider
3. Write managed egress deltas into central rolling-window usage storage.
4. Implement optional leased budgets for the highest-volume managed paths.
5. Surface remaining allowance and block reasons to operators and users.

### Track 6. Direct Project-Originated Outbound Egress

1. Choose a host-local attribution mechanism that can identify traffic initiated
   from a project container toward the public network.
2. Do not rely on raw Podman stats or simple per-container TX totals as the
   authoritative meter.
3. Build a host-local sampler/accountant that reports direct outbound deltas per
   project/account.
4. Feed those deltas into the same central rolling windows used for managed
   egress.
5. When an account is over cap, apply a conservative protection action on
   shared hosts, such as blocking new outbound flows or otherwise disabling
   further egress-heavy actions for the project/account.

### Track 7. Central Rolling Windows, Overrides, And Policy

1. Reuse the LLM-limits model where possible:
   - rolling `5-hour` window
   - rolling `7-day` window
2. Keep one central source of truth for:
   - current usage
   - current block state
   - active operator overrides
3. Log every block/unblock decision with enough detail to explain it later.
4. Ensure the policy distinguishes:
   - shared hosts on metered providers
   - shared hosts on cheap/free-egress providers
   - dedicated hosts with special egress policy

### Track 8. User And Operator Surfaces

1. Membership/store page:
   - show limits clearly
   - avoid infrastructure jargon
2. Project/start/storage/download errors:
   - explain which limit blocked the action
   - point to the dedicated-host escape hatch where relevant
3. `/admin`:
   - effective limits
   - current storage/project-count/egress usage
   - active block reasons
   - override controls
4. Optional project-host `/hosts` surfaces:
   - local observations
   - host-local block or pressure state

### Track 9. Rollout And Safety

1. Ship storage and project-count enforcement before ambitious egress work.
2. Start egress in observe-only mode where possible.
3. Compare observed counters against known traffic paths before hard blocking.
4. Use conservative defaults on metered providers first.
5. Treat “stops catastrophic spend” as more important than “perfectly fair
   accounting” for v1.

## Recommended Immediate Next Steps

1. Approve this spec as the release policy direction.
2. Freeze the field semantics and units in the membership tier model.
3. Build an implementation tracker from the tracks above.
4. Start with:
   - membership entitlement schema
   - total account storage rollup
   - project-count enforcement
5. In parallel, spike the direct project-originated outbound attribution
   mechanism on one project host and decide whether the v1 path is:
   - good enough to ship
   - or requires temporary restrictions on arbitrary outbound networking

The key discipline is:

- keep the user contract simple
- keep enforcement near the resource where possible
- keep global cost protection centralized where necessary
- do not reintroduce explicit shared-host CPU/RAM promises
