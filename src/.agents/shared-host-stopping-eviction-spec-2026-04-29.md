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
- that every project stays running indefinitely

Stopping under contention is part of the shared-host and dedicated-host product
contract and should be treated as such.

## Core Architectural Decisions

### 1. The Stop Controller Runs On `project-host`

The stop controller must live on `project-host`, not in the bay or hub.

That is the correct boundary because:

1. the failure is local to the host, so the survival loop belongs with the host
2. bays are expensive and should not own a high-frequency host pressure loop
3. `project-host` already has a real control plane, local sqlite, and local
   start/stop authority
4. the Kubernetes analogue is node-local eviction, not centralized scheduling

The hub remains the source of truth for durable policy and activity metadata.
The host mirrors the minimum subset of that metadata and makes local decisions.

### 2. There Must Be Exactly One Automatic Stop Mechanism

For first release, automatic project stopping must come from one policy family
only: host-local pressure control on `project-host`.

We should not ship two unrelated automatic stop mechanisms:

1. legacy idle-timeout stopping in the hub
2. new pressure-based stopping on the host

That would be hard to reason about, hard to explain, and hard to debug.

### 3. `always_running` Is Removed As A Product And Runtime Concept

`always_running` belonged to an older model where only direct human action
started projects. That is no longer true. Incoming HTTP, SSH, and other
triggers can now start projects automatically.

For first release:

1. `always_running` must not influence runtime behavior
2. no automatic start loop should exist because of `always_running`
3. no automatic stop exemption should exist because of `always_running`
4. user-facing quota or settings UI should not expose `always_running`

### 4. `idle_timeout` Is Removed As A Product And Runtime Concept

`idle_timeout` as a separate product knob is incompatible with a clean,
host-pressure-driven design.

`last_edited` remains useful as a ranking signal. `idle_timeout` does not
remain as a separate enforcement mechanism.

## First-Release Enforcement Model

### 1. Pressure Signals

The first release must at least respond to memory pressure.

CPU pressure matters, but memory pressure is the hard-failure mode that kills
hosts. The v1 design therefore uses:

1. memory pressure as the mandatory stop trigger family
2. CPU/load pressure as an input to pressure classification, escalation, and
   operator visibility

The host should have:

1. a normal operating zone
2. an observe zone
3. a pressure zone
4. an emergency zone

The exact thresholds remain an implementation choice, but they must be explicit
and operator-visible.

### 2. Victim Selection Order

The first-release ordering should be simple and defensible.

At a high level:

1. prefer stopping lower shared-compute-priority projects before higher ones
2. among equal priority, prefer stopping less-recently-active projects first
3. among equally idle candidates, prefer stopping older-running projects first
4. among otherwise similar candidates, prefer stopping the project likely to
   relieve pressure fastest
5. on dedicated hosts, rank only within that dedicated host's own projects

### 3. Activity Protection

The host should distinguish between:

- recently active interactive projects
- idle or abandoned projects

For first release, the authoritative minimum activity signal is
`projects.last_edited` mirrored from the hub onto the host. Later host-local
activity hints can be added, but they should not be required for v1.

### 4. Startup Protection

Newly started projects need an explicit protection window. Without that,
pressure control will feel random and hostile.

The host therefore tracks a local `last_started_ms` and applies a configurable
startup protection window before a newly started project becomes a normal stop
candidate.

### 5. Stop Phases

The first release uses phased behavior:

1. observe pressure
2. rank candidates
3. stop a small number of victims
4. wait for a settle window
5. re-evaluate pressure
6. escalate only if the host is still unsafe

### 6. Cooldown And Churn Protection

After a project is stopped due to host pressure, the host should avoid
immediately selecting the same project again in a useless loop.

Similarly, if a host has just taken stop action, it should not keep making
identical decisions every second without checking whether pressure actually
improved.

## Exact Policy And Activity Mirroring Onto `project-host`

This is the critical architectural piece. The host-local controller is only
correct if the host has the right data locally.

### 1. Source Of Truth

The authoritative sources remain central:

1. `projects.last_edited` in Postgres for user activity
2. membership resolution for `shared_compute_priority`
3. future admin override state for temporary protect/deprioritize decisions
4. host placement from the central projects table

The host mirrors only the minimum fields needed for stop decisions.

### 2. Mirror Transport Pattern

We should copy the existing project-user sync model in
`src/packages/server/conat/host-registry.ts` and
`src/packages/project-host/master.ts`.

Do not invent a one-off polling mechanism in the bay. Add a dedicated host
registry sync surface for stop-policy rows:

1. `listProjectStopPolicyDeltas({ host_id, since_ms, limit })`
2. `listProjectStopPolicyReconcile({ host_id, limit, recent_days })`

This gives us:

1. fast delta propagation for frequently changing activity
2. periodic reconcile for correctness and drift repair
3. the same scaling and failure properties as the existing user mirror

### 3. Mirrored Row Shape

Each mirrored stop-policy row should contain exactly:

1. `project_id`
2. `owner_account_id`
3. `shared_compute_priority`
4. `authoritative_last_edited_ms`
5. `policy_updated_ms`
6. `stop_override`

`stop_override` is reserved for the broader admin override work and should use a
small explicit enum:

1. `default`
2. `protect`
3. `deprioritize`

The host must not need to re-resolve memberships or inspect the central users
map to rank projects.

### 4. Local SQLite Layout

Do not overload the existing `projects` sqlite row with every new concern.
Keep runtime state and stop-policy state separate.

Add two new local sqlite tables on `project-host`:

#### `project_stop_policy`

Hub-mirrored inputs:

1. `project_id TEXT PRIMARY KEY`
2. `owner_account_id TEXT`
3. `shared_compute_priority INTEGER NOT NULL`
4. `authoritative_last_edited_ms INTEGER`
5. `policy_updated_ms INTEGER NOT NULL`
6. `stop_override TEXT NOT NULL`
7. `updated_at INTEGER NOT NULL`

#### `project_stop_state`

Host-local controller state:

1. `project_id TEXT PRIMARY KEY`
2. `last_started_ms INTEGER`
3. `last_pressure_stop_ms INTEGER`
4. `pressure_cooldown_until_ms INTEGER`
5. `last_ranked_ms INTEGER`
6. `last_decision_reason TEXT`
7. `last_decision_pressure_zone TEXT`
8. `updated_at INTEGER NOT NULL`

Why two tables instead of shoving everything into `sqlite/projects.ts`:

1. it keeps the data model explainable
2. mirrored hub policy and host-local controller state evolve independently
3. runtime/project metadata stays small and purpose-specific

### 5. Delta Semantics

The delta feed should be optimized for the fast-moving field:
`authoritative_last_edited_ms`.

For first release, a delta row means:

1. this project's central activity or stop-policy row changed
2. overwrite the mirrored `project_stop_policy` row locally
3. advance the local cursor to `policy_updated_ms`

Membership priority and admin overrides may change less frequently than
`last_edited`. That is fine. The reconcile pass exists to refresh everything.

### 6. Reconcile Semantics

The reconcile pass should return:

1. all running or starting projects on the host
2. recently active projects on the host
3. full recomputed stop-policy rows for those projects

This catches:

1. missed deltas
2. host restarts
3. membership changes
4. override changes
5. local sqlite corruption or drift

### 7. Sync Cadence

Initial recommended cadence:

1. delta sync every 10 seconds
2. reconcile every 5 minutes
3. forced reconcile on host startup before the stop controller becomes armed
4. forced reconcile after any prolonged master disconnect

The stop controller may run using the last mirrored state while the hub is
temporarily unreachable. That is a feature, not a bug.

### 8. Missing-Policy Behavior

The host must be able to survive even if a project lacks a fresh mirrored
policy row.

Fallback rules:

1. if a cached local policy exists, use it
2. if no policy exists, treat the project as `shared_compute_priority = 0`
3. log `policy_missing` in the candidate explanation
4. do not block host survival waiting on the bay

This keeps the failure domain local, which is the whole point of this design.

## Exact Controller Placement And Boundaries

### 1. Controller Module

Add a dedicated host-local controller module under `src/packages/project-host/`,
for example:

- `src/packages/project-host/stop-controller.ts`

This module owns:

1. pressure classification
2. candidate ranking
3. cooldown and startup protection
4. stop execution orchestration
5. reason-code logging

It should not own:

1. membership resolution
2. central project activity truth
3. hub-side policy storage

### 2. Controller Start-Up Sequence

The controller should start from `src/packages/project-host/master.ts` only
after:

1. master conat client is ready
2. host metrics collector is running
3. reconciler is running
4. initial stop-policy reconcile has completed

That prevents the host from making pressure decisions against an empty policy
mirror during boot.

### 3. Stop Execution Path

The controller should stop projects through the same local stop implementation
already used by `project-host`, not by RPCing back through the hub.

Practically, that means:

1. call the local `project-host` stop path
2. let the existing local state reporting path publish the resulting state
3. record stop-controller reason codes locally before the stop begins

### 4. Candidate Inputs

For first release, every candidate ranking should use exactly these inputs:

1. `shared_compute_priority`
2. `authoritative_last_edited_ms`
3. `last_started_ms`
4. current local project state (`running`, `starting`, etc.)
5. current host pressure zone
6. `pressure_cooldown_until_ms`
7. optional `stop_override`

Do not add weak heuristics just because they are available.

### 5. Recommended First Ranking Function

The first ranking function should be lexicographic and inspectable:

1. exclude non-running projects
2. exclude projects inside startup protection unless the host is in emergency
3. apply `stop_override`
4. sort by lower `shared_compute_priority` first
5. then older `authoritative_last_edited_ms`
6. then older `last_started_ms`
7. then any available "likely to free pressure" hint

This is not perfect. It is explainable, which matters more for v1.

## Pressure Threshold Model

Exact values should be chosen in implementation, but the model should be:

### Normal

No action.

### Observe

The host is trending hot. Record snapshots and rankings, but do not stop yet.
CPU/load can matter here.

### Pressure

The host is materially unsafe and should stop one candidate, wait for a settle
window, then re-evaluate.

### Emergency

The host is at serious risk of collapse and may:

1. ignore some startup protection
2. stop more than one candidate per cycle
3. shorten the settle window

For v1, memory pressure must be part of entering `pressure` or `emergency`.
CPU pressure should still be logged and surfaced, and it can contribute to
entering `observe`.

## Operator And User Requirements

Before release, operators should be able to answer:

1. why did this host start stopping projects?
2. which projects were considered candidates?
3. why was this project chosen?
4. was the decision driven by:
   - priority
   - idleness
   - startup protection bypass
   - memory pressure
   - CPU pressure
   - override
5. did stopping the project actually reduce pressure?

Users do not need all internals, but the system should be able to tell them, in
plain language:

1. this project was stopped because the host was under pressure
2. host-local pressure protection ranks projects by priority and recent activity
3. active or recently started work is protected where possible

## Complete Legacy Removal Plan

This design is not clean until the old mechanisms are deleted.

### 1. Remove Legacy Idle Timeout Wiring Completely

Delete:

1. `src/packages/server/projects/control/stop-idle-projects.ts`
2. `src/packages/server/projects/control/stop-idle-projects.test.ts`

Remove wiring from:

1. `src/packages/hub/hub.ts`

Specifically, remove the `initIdleTimeout` import and startup call entirely.

### 2. Remove Legacy `always_running` Startup Wiring Completely

Delete:

1. `src/packages/database/postgres/project/always-running.ts`

Remove wiring from:

1. `src/packages/hub/hub.ts`

Specifically, remove the `init_start_always_running_projects` import and
startup call entirely.

### 3. Remove `always_running` And `idle_timeout` From Product Surfaces

These must stop existing as configurable runtime features.

That includes removing them from:

1. project settings UI
2. membership/project defaults
3. quota uptime helpers
4. pricing and product copy
5. any purchase or entitlement flow that still emits them as active options

The release should ship with one automatic stop model only: host-local pressure
control.

### 4. Compatibility Strategy

We may still encounter old JSON containing `always_running` or `idle_timeout`.
That does not justify preserving runtime behavior.

The compatibility rule is:

1. stale stored keys may be scrubbed by migration or cleanup
2. runtime behavior must not branch on them
3. new writes must not emit them

## Detailed Phased Implementation Plan

### Phase 1: Local Data Model And Sync Surface

Goal: give `project-host` the exact policy/activity fields it needs.

Changes:

1. add `project_stop_policy` sqlite table on `project-host`
2. add `project_stop_state` sqlite table on `project-host`
3. extend `src/packages/server/conat/host-registry.ts` with:
   - `listProjectStopPolicyDeltas`
   - `listProjectStopPolicyReconcile`
4. extend `src/packages/project-host/master.ts` with a stop-policy delta loop and
   reconcile loop, patterned after existing project-user sync

Validation:

1. host boot with empty sqlite performs initial reconcile successfully
2. subsequent deltas update `authoritative_last_edited_ms`
3. a changed membership priority is visible after reconcile

### Phase 2: Controller State Plumbing

Goal: track local facts that the hub should not own.

Changes:

1. record `last_started_ms` locally whenever a project transitions into
   `starting` or `running`
2. record `last_pressure_stop_ms` and `pressure_cooldown_until_ms` locally when
   the controller stops a project
3. add explicit helper functions for reading candidate inputs and updating stop
   state

Validation:

1. restarting `project-host` preserves local stop state
2. startup protection survives ordinary restarts
3. cooldown is visible in local sqlite and logs

### Phase 3: Observe-Only Controller

Goal: prove the ranking logic before it starts stopping work.

Changes:

1. add the host-local stop controller module
2. classify pressure into `normal`, `observe`, `pressure`, `emergency`
3. compute candidate rankings and reason codes
4. log candidate lists and chosen victim in observe-only mode
5. do not stop projects yet

Validation:

1. synthetic pressure produces stable rankings
2. active projects rank behind stale low-priority ones
3. newly started projects are protected
4. dedicated hosts rank only among their own projects

### Phase 4: Enforced Pressure Stops

Goal: turn the controller into the real automatic stop path.

Changes:

1. enable one-project stop in `pressure`
2. use settle-window recheck before escalation
3. allow more aggressive behavior in `emergency`
4. report reason codes and outcomes locally and through normal state reporting

Validation:

1. host survives realistic pressure without collapse
2. pressure relief is visible after stop decisions
3. controller does not thrash under sustained pressure

### Phase 5: Cut Over Completely

Goal: eliminate the old world so there is only one automatic stopping system.

Changes:

1. remove idle-timeout startup wiring from `src/packages/hub/hub.ts`
2. delete `src/packages/server/projects/control/stop-idle-projects.ts`
3. remove always-running startup wiring from `src/packages/hub/hub.ts`
4. delete `src/packages/database/postgres/project/always-running.ts`

Validation:

1. no automatic stop path remains in the hub
2. no automatic start path remains because of `always_running`
3. pressure controller is the only runtime stop mechanism

### Phase 6: Product Cleanup

Goal: make the user-facing model match the runtime model.

Changes:

1. remove `always_running` and `idle_timeout` from settings UI and copy
2. remove them from membership defaults and quota helpers
3. remove pricing/product references
4. stop writing them anywhere in new data

Validation:

1. no user-visible surface presents these controls
2. no active runtime code branches on these fields
3. docs explain one stop model only

### Phase 7: Dogfood, Threshold Tuning, And Release Hardening

Goal: tune behavior without reopening architecture.

Changes:

1. adjust thresholds
2. adjust settle windows and cooldown
3. refine reason codes and operator visibility

Non-goal for this phase:

1. do not redesign the architecture again
2. do not add speculative heuristics unless dogfood proves a real need

## Resolved Design Decisions

1. "Recently active" for v1 must at least use the central `last_edited` field.
2. CPU pressure matters and should be visible in classification and logging.
3. Newly started projects need an explicit protection window.
4. We do not need memory classes for v1; there is no swap-driven class system
   worth introducing yet.
5. Shared and dedicated hosts use the same host-local protection framework;
   they differ only in the candidate pool they rank.

## Remaining Implementation Questions

These are implementation questions, not architectural uncertainty:

1. what exact numeric thresholds define `observe`, `pressure`, and `emergency`?
2. what exact settle window should follow a stop before re-evaluation?
3. what exact cooldown should apply after a pressure stop?
4. do we want a small "likely to free pressure" hint in v1, or defer that
   until after observe-only dogfood?

## First-Release Completion Criteria

This track is done enough for release when:

1. shared and dedicated hosts can survive realistic pressure without collapsing
2. the stop order clearly reflects priority, recent activity, and startup
   protection
3. the stop controller runs entirely on `project-host`
4. the host can operate on mirrored policy while temporarily disconnected from
   the bay
5. `always_running` and the old idle-timeout mechanism are gone completely
6. operators can inspect why a stop happened
7. users can get a coherent explanation after a stop
