# Shared-Host Stopping And Eviction Release Spec

Status: focused first-release blocker spec as of 2026-04-29.

This document defines the minimum host-local stopping and eviction policy
required for the first public release on both shared and dedicated project
hosts.

It is intentionally separate from:

- [membership-usage-limits-release-spec-2026-04-25.md](/home/user/cocalc-ai/src/.agents/membership-usage-limits-release-spec-2026-04-25.md)

That document defines the user-facing limit model and membership contract. This
document defines what a project host does when it is under pressure and must
choose which projects to stop.

## Why This Is Separate

The membership/usage spec is already good enough to invite endless new work.
That is dangerous.

Stopping and eviction are critical, but they are a different problem:

1. host-local stability under pressure
2. prioritization between live projects
3. operator visibility into why the host stopped something

This deserves a focused spec with a smaller denominator.

## Release Position

Host-local stopping/eviction is a critical release blocker.

We do not need a perfect scheduler before release. We do need a host-local
policy that:

1. keeps the host alive under pressure
2. respects shared compute priority
3. prefers stopping less-important and less-active work first
4. is explainable to operators and users afterward

## Goals

1. Prevent project hosts from collapsing under memory or resource pressure.
2. Preserve the user-facing product contract that higher memberships get better
   behavior under contention.
3. Prefer stopping idle or lower-priority projects before active or
   higher-priority projects.
4. Make every stop decision inspectable after the fact.
5. Avoid churn loops where the host repeatedly stops and restarts the same work
   without improving stability.

## Non-Goals

1. Perfect cluster-global scheduling.
2. Exact CPU or RAM billing.
3. Precise per-user fairness.
4. A final forever policy for all future host types.
5. A replacement for explicit storage or egress enforcement.

## Scope Boundary

This spec is only about host-local project stopping/eviction.

It is not about:

- storage quotas
- total account storage caps
- project-count enforcement
- managed egress blocking
  Those are separate controls. This spec answers a narrower question:

- when a project host itself is under pressure, what running projects should it
  stop first?

## First-Release Product Contract

The user-facing promise remains:

- shared compute is priority-based
- bursting is opportunistic
- contention means lower-priority or less-active work may be stopped sooner
- dedicated hosts still protect themselves locally so one project does not break
  the whole host for collaborators

We should not promise:

- exact dedicated-style CPU counts
- exact guaranteed RAM
- that every project stays running indefinitely on a shared host

Stopping under contention is part of the shared-host contract and should be
treated as such.

## First-Release Enforcement Model

### 1. Host-Local, Not Cluster-Global

The first release should make stop decisions locally on each project host.

This keeps the implementation tractable and is enough to get robust behavior
into production. It also aligns with the actual operational problem: the host
must survive local pressure right now.

### 2. Pressure Signals

The first release must at least respond to memory pressure.

CPU-only contention is important, but memory pressure is the hard-failure mode
that kills hosts. If scope must be trimmed, memory-based stopping is mandatory
and CPU-based stopping is secondary.

The host should have:

1. a normal operating zone
2. a pressure zone where the host begins choosing victims
3. an emergency zone where the host stops projects aggressively until it
   returns to safety

Exact thresholds remain an implementation choice, but they must be explicit and
operator-visible.

### 3. Victim Selection Order

The first-release ordering should be simple and defensible.

At a high level:

1. prefer stopping lower shared-compute-priority projects before higher ones
2. among equal priority, prefer stopping less-recently-active projects first
3. among equally idle candidates, prefer stopping projects that free more
   pressure sooner
4. on dedicated hosts, rank only within that dedicated host's own projects

This is enough to align technical behavior with the product contract.

### 4. Activity Protection

The host should distinguish between:

- recently active interactive projects
- idle or abandoned projects

The first release does not need perfect activity classification. It does need a
clear and conservative signal for "recently active" so that obviously active
projects are not treated the same as long-idle ones.

### 5. Stop Phases

The first release should use phased behavior:

1. observe pressure
2. select a small number of stop candidates
3. wait briefly for pressure relief
4. escalate only if the host is still unsafe

This reduces churn and makes the policy more understandable than a one-shot
panic stop.

### 6. Cooldown / Churn Protection

After a project is stopped due to host pressure, the host should avoid
immediately selecting the same project again in a useless loop.

Similarly, if a host has just taken stop action, it should not keep making
identical decisions every second without checking whether pressure actually
improved.

## Minimum Data The Host Needs

The first release should base decisions on a small, explicit set of facts:

1. shared compute priority for the project owner
2. recent activity signal for the project
3. current host pressure metrics
4. recent stop history for the host
5. the project's approximate contribution to current pressure, where available

We should resist adding a long tail of weak heuristics before the simple model
is proven.

## Operator Requirements

Before release, operators should be able to answer:

1. why did this host start stopping projects?
2. which projects were considered candidates?
3. why was this project chosen?
4. was the decision driven by:
   - priority
   - idleness
   - emergency pressure
   - manual action
5. did stopping the project actually reduce pressure?

That implies at least:

1. recent host-pressure history
2. recent stop decisions with reason codes
3. visible candidate ranking inputs
4. a clear distinction between automated stops and manual/operator actions

## User-Facing Requirements

Users do not need to see all internals, but the system should be able to tell
them, in plain language:

1. this project was stopped because the shared host was under pressure
2. shared-host priority and recent activity affect which projects are stopped
3. if they need stronger guarantees than a protected multi-project host can
   offer, they should use a different deployment model

The explanation should not invent precise scheduler claims we do not actually
make elsewhere.

## Relationship To Admin Overrides

Admin overrides are still part of the broader membership/limits story, but
stopping/eviction needs a narrow operational interpretation:

- operators may need a temporary way to protect or deprioritize a project or
  account during an incident

That should remain explicit, auditable, and narrow in scope. It should not turn
into hidden product policy.

## First-Release Completion Criteria

This track is done enough for release when:

1. shared and dedicated project hosts can survive realistic pressure without
   collapsing
2. the stop order clearly reflects membership priority and recent activity
3. operators can inspect why a stop happened
4. users can get a coherent explanation after a stop
5. the behavior is stable enough in dogfood that it does not feel random

## Open Questions

1. What exact signals should define "recently active" for first release?
2. What exact host-local pressure thresholds should trigger the observe,
   pressure, and emergency phases?
3. Should CPU-only pressure trigger automated stopping in first release, or
   should v1 focus on memory pressure only?
4. Do we need any explicit host-local protection window for newly started
   projects?
5. Do we need any internal memory-priority or memory-class distinction beyond
   priority plus idleness for v1?

## Recommended Immediate Next Steps

1. Pick the exact host-local pressure signals and thresholds for v1.
2. Define the first concrete victim-ranking algorithm in code-level terms.
3. Define the minimal operator-visible reason codes and logs.
4. Dogfood it under controlled pressure and adjust only what is needed for
   robustness.
5. Keep this track focused. Do not let it expand back into the whole
   membership/limits program.
