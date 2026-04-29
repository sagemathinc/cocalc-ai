# Membership And Usage Limits Release Spec

Status: updated first-release policy and implementation tracker as of
2026-04-29.

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
- [shared-host-stopping-eviction-spec-2026-04-29.md](/home/user/cocalc-ai/src/.agents/shared-host-stopping-eviction-spec-2026-04-29.md)

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

## Implementation Status Snapshot

The spec below is no longer a greenfield plan. It is now an implementation
tracker describing what has already landed and what remains for the first
release.

### Implemented

The following now exist and should be treated as part of shared-host v1:

1. Membership entitlements/resolver cleanup:
   - canonical `effective_limits`
   - owner-tier-driven project entitlement semantics
   - surfaced usage-limit fields in admin membership-tier editing
2. Per-project storage semantics and UX:
   - authoritative quota remains the real enforced filesystem metric
   - live usage uses `du`, not `dust`
   - retained snapshot/history data is shown as a derived estimate
   - storage UI, CLI, and history views use the same semantics
3. Total account storage:
   - centralized usage status
   - soft/hard enforcement
   - warning surfaces
4. Project-count enforcement:
   - central owned-project check on create paths
   - usage status and admin/user surfaces show current count and limits
5. Snapshot and backup limits as plan features:
   - membership-tier-driven caps
   - UI and maintenance flows use those caps
6. Shared-host managed egress v1:
   - rolling windows and blocking
   - managed-egress metering on the main shared-host paths
   - user-facing warnings and blocked-state UX
7. Historical egress observability:
   - first-class RPC
   - `cocalc-cli` support
   - account-scoped drilldown UI
   - project-scoped drilldown UI
   - admin-wide overview and history UI
8. Direct project-originated outbound attribution:
   - the current shared-host model is accepted as sufficiently good for v1
9. Operator/debug surfaces:
   - admin user search and admin egress inspection are materially better than
     the original spec assumed

### Partially Implemented

1. Central admin inspection and policy surfaces:
   - inspection is now substantially implemented
   - override controls are still missing
2. Dedicated-host egress policy:
   - product direction is decided
   - implementation and exposure are not fully closed out

### Not Finished

1. Central admin override controls.
2. Dedicated-host egress policy wiring and admin override integration.
3. Shared-host stopping/eviction policy, tracked in its own focused spec.
4. Managed-egress leased budgets, if we still decide they are operationally
   necessary.

## Current Release Position

The product/architecture decisions are now:

1. The storage model is frozen.
   - per-project quota includes snapshot-retained data
   - total account storage rolls up those real per-project quota-used bytes
2. Project-count enforcement is implemented and should be treated as done for
   v1.
3. Direct outbound egress attribution is accepted as good enough for v1.
   We do not need another attribution push before release.
4. Dedicated-host egress policy for GCP should match the same membership-level
   egress policy unless an explicit admin override says otherwise.
5. Shared-host stopping/eviction is a critical first-release blocker, but it is
   now tracked in a dedicated focused spec rather than inside this document.
6. Any internal memory-priority or memory-class work belongs to that
   stopping/eviction track, not to this limit-model spec.

## Remaining High-Priority Work

### 1. Shared-Host Stopping / Eviction Policy

This is a critical release blocker.

It is no longer specified in detail here. The focused design and implementation
tracker now lives in:

- [shared-host-stopping-eviction-spec-2026-04-29.md](/home/user/cocalc-ai/src/.agents/shared-host-stopping-eviction-spec-2026-04-29.md)

The important boundary is:

- this document defines the shared-host user-facing contract and limit model
- the stopping/eviction spec defines how a shared host stays stable under
  contention while respecting that contract

### 2. Central Admin Override Controls

This is now one of the most important remaining items.

We already have significantly better admin inspection, but we still need:

- explicit override controls for:
  - storage-related protection states
  - project-count exceptions
  - egress-related exceptions
- a clear record of active overrides and why they exist
- operator-facing explanation of which effective limits are coming from:
  - membership tier
  - default policy
  - admin override

### 3. Dedicated-Host Egress Policy Wiring

The product decision is now simple:

- if a dedicated host is on GCP, apply the same membership-level egress policy
  by default
- use admin overrides for exceptional users instead of inventing a new
  separate “high usage is fine” product path

What remains is mainly implementation and operator-surface cleanup, not policy
design.

### 4. Managed-Egress Leased Budgets

This remains conditional.

If the current shared-host managed-egress paths are operationally stable
without budget leases, we may not need to push this further before release.
This should be treated as an implementation question, not as a guaranteed
product blocker.

## Updated Track Status

### Track 1. Membership Entitlements And Resolver Cleanup

Status: implemented enough to count as done for v1.

Remaining:

- keep admin exposure coherent
- ensure future limit fields continue to flow through the canonical
  `effective_limits` object

### Track 2. Per-Project Storage Semantics And UX

Status: implemented enough to count as done for v1.

See:

- [project-storage-quota-snapshot-model-2026-04-28.md](/home/user/cocalc-ai/src/.agents/project-storage-quota-snapshot-model-2026-04-28.md)

Remaining:

- minor copy cleanup only

### Track 3. Total Account Storage

Status: implemented enough to count as done for v1.

Remaining:

- keep admin/operator explanation surfaces polished

### Track 4. Project Count

Status: implemented enough to count as done for v1.

Notes:

- central owned-project enforcement exists
- user/admin surfaces expose current count and limits

### Track 5. Snapshot And Backup Limits As Plan Features

Status: implemented enough to count as done for v1.

Remaining:

- continue tightening copy and product explanations

### Track 6. Shared-Host Scheduling And Stopping

Status: not finished.

This is now tracked in a dedicated focused spec and should be treated as a
critical release blocker rather than as a lingering subtask inside the
membership/limits document.

See:

- [shared-host-stopping-eviction-spec-2026-04-29.md](/home/user/cocalc-ai/src/.agents/shared-host-stopping-eviction-spec-2026-04-29.md)

### Track 7. Managed Egress Completion

Status: mostly implemented for v1.

Done:

- main managed-egress metering and blocking
- historical RPC/CLI/UI
- user/admin inspection surfaces

Remaining:

- leased budgets, if still required operationally

### Track 8. Direct Project-Originated Outbound Egress

Status: accepted as done enough for v1.

The current shared-host attribution model is now considered sufficiently good.
Do not reopen this unless production experience shows a concrete problem.

### Track 9. Central Rolling Windows, Overrides, And Policy Surfaces

Status: partially implemented.

Done:

- rolling windows
- central block state
- inspection surfaces

Remaining:

- explicit operator override controls
- clear override lifecycle and explanation

### Track 10. User And Operator Surfaces

Status: largely implemented.

Done:

- account/project/admin egress drilldown UI
- CLI support for historical egress
- admin inspection improvements
- clearer storage/account-usage surfaces

Remaining:

- override controls in admin
- continued copy cleanup

### Track 11. Rollout And Safety

Status: mostly resolved by implementation order already completed.

The key remaining discipline is:

- do not reopen the storage metric model
- do not reopen direct-outbound attribution unless production data forces it
- keep overrides explicit and inspectable

## Open Questions

The main open questions are now narrower:

1. What exact user-facing label should we standardize on for the derived
   retained snapshot/history storage number?
2. What first-release membership-tier defaults do we want for:
   - `max_snapshots_per_project`
   - `max_backups_per_project`
3. How should admin overrides be presented and audited in `/admin`?

Stopping/eviction-specific open questions now live in the focused eviction
spec, not here.

## Recommended Immediate Next Steps

1. Finish the focused shared-host stopping/eviction spec and implement the
   minimum release-blocking host policy from it.
2. Treat central admin override controls as the main remaining limits/policy
   blocker inside this document's scope.
3. Wire the dedicated-host egress policy to the decided default:
   - same membership-level egress policy on GCP
   - admin overrides for exceptions
4. Decide whether managed-egress leased budgets are still operationally needed.
5. Keep this document focused on the limit model and user/operator contract,
   not host-local eviction mechanics.

The key discipline remains:

- keep the user contract simple
- keep enforcement aligned with the real backend metric
- make hidden limits explicit plan features
- keep global cost protection centralized where necessary
- do not reintroduce explicit shared-host CPU/RAM promises
