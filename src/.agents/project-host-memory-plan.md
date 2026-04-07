# Project Host Memory Policy Plan

Last refreshed: April 6, 2026

Status: active design note and implementation roadmap.

This note records the current direction for project-host memory management in
Launchpad / CoCalc project hosts. It focuses on:

- keeping the host itself alive under memory pressure
- degrading or killing project workloads before host-critical services
- defining the host classes we expect to support
- capturing what is already finished, what is implemented in source, and what
  remains follow-up work

This is intentionally a practical operations note, not a generic Linux tuning
essay.

## Executive Summary

The main policy decision is:

- protect the host first
- degrade project workloads before the host wedges
- prefer degraded service over immediate rejection when projects are sticky to a
  host and moving them is expensive
- postpone aggressive admission control until we have better load data and
  ejection policies

The near-term memory strategy is:

1. protect host-critical services from OOM kill selection
2. enforce a hard aggregate memory cap for the whole project workload pool
3. add per-project soft memory pressure with `memory.high` and
   `memory_reservation`
4. add tier-aware and idleness-aware ejection under sustained pressure
5. revisit admission and rebalancing later, informed by load testing

## Why This Is Needed

The failure mode we observed on live project hosts was not always a clean OOM
kill. In at least one real incident, the host became mostly unresponsive while
still pinging and later recovered on its own. The serial console showed blocked
writeback/reclaim activity rather than a clean kill path.

That distinction matters:

- `oom_score_adj` helps when the kernel is choosing what to kill
- it does not solve reclaim/writeback stalls by itself
- aggregate cgroup caps and per-project soft pressure target the stall case more
  directly

Our goal is therefore not only "kill the right process on OOM", but also:

- reduce the chance that project workloads drag the whole host into global
  reclaim or writeback distress

## Constraints Unique to CoCalc Project Hosts

CoCalc project hosts are not stateless compute workers.

Important constraints:

- a project is assigned to a host
- project data is local to that host
- moving a project is invasive and can take minutes
- short demand spikes should usually cause degraded project behavior rather than
  immediate rejection or forced project moves
- later, low-tier and idle projects can be ejected first as part of explicit
  product policy

This means memory admission is more delicate than in a stateless scheduler.

## Host Classes

We should treat memory policy as a host-level profile, not one global setting.

### `high_density_shared`

Goal:

- maximize the number of simultaneously running projects

Typical workload:

- many light student projects
- notebook kernels that are idle much of the time
- small interactive workloads

Acceptable failure mode:

- user kernels die
- low-tier users are ejected
- performance degrades under pressure

Not acceptable:

- host becomes unreachable
- project-host or sshd dies

Likely tuning direction:

- tighter aggregate project pool cap
- stronger per-project throttling
- later: more aggressive ejection of low-tier and idle projects
- swap or zram may make sense on some providers

### `shared_pro`

Goal:

- shared host economics with materially better behavior for paying users

Typical workload:

- mixed casual and serious projects
- some heavier compute, but still multi-tenant

Acceptable failure mode:

- low-tier or idle projects are degraded or ejected first
- bursts may slow projects down

Not acceptable:

- host instability
- broad random project failure when one project misbehaves

Likely tuning direction:

- larger reserve than `high_density_shared`
- softer overcommit
- more conservative ejection policy

### `dedicated_private`

Goal:

- predictable single-tenant or near-single-tenant behavior

Typical workload:

- one customer or one admin using the whole host
- heavy development, testing, package installs, local services

Acceptable failure mode:

- the customer's own project slows down or gets killed if it exceeds policy

Not acceptable:

- losing `project-host`, ssh access, or host control because one project used
  too much RAM

Likely tuning direction:

- large host reserve
- little or no admission pressure
- strong host protection
- optional provider-specific swap policy for large local-SSD hosts

## Failure Modes To Distinguish

### Clean OOM kill

This is the classic case:

- memory is exhausted
- the kernel picks a victim
- the victim is killed

Desired outcome:

- project processes or project containers die first
- `project-host`, sshd, and similar services survive

### Reclaim / writeback stall

This is the more dangerous case we have already seen:

- memory pressure rises
- the kernel keeps trying to reclaim pages or flush dirty memory
- processes block in the kernel for a long time
- the machine may ping but ssh and control-plane operations become unusable

Desired outcome:

- project workloads feel pressure earlier, before the host reaches this state

## What Is Already Finished

These items are already done as part of this round of work.

### 1. Host-critical OOM protection

Implemented:

- `project-host` is now started through a root-owned helper that applies a
  strong negative `oom_score_adj`
- `ssh.service`, `sshd.service`, and `cocalc-cloudflared.service` receive
  `OOMScoreAdjust=-900` via bootstrap-managed drop-ins

Important note:

- there was one follow-up fix to correct the default sign for `project-host`
  OOM bias after live verification showed it had initially landed as `+900`

What this buys us:

- in a true OOM victim-selection path, host-critical services should now be much
  less likely to die before project workloads

What it does not buy us:

- it does not by itself prevent reclaim/writeback stalls

### 2. Live evidence that project-side pressure can now lose first

On a live host after the OOM hardening landed, a deliberately memory-hungry
Python workload inside a project was killed while the host itself remained
reachable and usable.

This is not full proof that all host-memory failure modes are solved, but it is
strong evidence that the OOM victim-selection path is now behaving better.

## What Is Implemented In Source But Still Needs Rollout / Validation

### 3. Aggregate project workload cgroup cap

Implemented in source:

- bootstrap now creates and manages a dedicated aggregate workload cgroup
- that cgroup is capped at:
  - total host RAM minus a configurable reserve
- default reserve:
  - `3072 MB`

Current defaults written into `project-host.env`:

- `COCALC_PROJECT_POOL_CGROUP=/sys/fs/cgroup/cocalc-project-pool`
- `COCALC_PROJECT_POOL_MEMORY_RESERVE_MB=3072`

Important design detail:

- under the current rootless Podman `cgroupfs` fallback path, project container
  processes inherit the daemon's cgroup
- because of that, moving `project-host` and running project processes into one
  dedicated capped cgroup is a practical way to enforce an aggregate host
  reserve without relying on fragile per-container `--cgroup-parent`

What this is meant to buy us:

- no matter how many projects collectively misbehave, the project workload pool
  cannot consume the host's last reserve of memory

Why this is preferred over admission as the immediate next step:

- project placement is sticky
- moving projects is expensive
- degraded experience is often better than immediate refusal to start

## What We Intentionally Are Not Doing First

### Immediate strict admission control

We are intentionally not making host admission the first line of defense.

Reason:

- projects are tied to hosts
- load spikes are often temporary
- rejecting a start can be worse than allowing degraded performance for a short
  period
- long-term admission should be informed by telemetry, idleness, tiers, and
  eventual automated load testing

Admission is still important later, but it is not the next step.

## Recommended Next Technical Steps

### Phase 1: Roll out and validate the aggregate pool cap

Tasks:

1. deploy the aggregate cgroup cap changes broadly
2. verify on live hosts that project container processes land in the capped pool
3. verify that the host remains responsive under combined project memory stress

Success criteria:

- host-critical services remain reachable
- project workloads slow down or die before the host becomes unusable

### Phase 2: Add per-project soft pressure

Add these per-container controls:

- `--memory-reservation`
- `memory.high` via Podman `--cgroup-conf`

Purpose:

- a project should start feeling pressure before it reaches its hard memory cap
- a runaway project should slow down and be reclaimed earlier instead of pushing
  the whole host into global distress

This is the highest-value follow-up after the aggregate pool cap.

### Phase 3: Tier-aware and idleness-aware ejection

When sustained pressure exists, the system should intentionally eject projects
instead of waiting for the kernel to pick random victims.

Policy direction:

- lowest tier users first
- longest idle projects first
- small projects are often easier to move or eject

This matches the planned product direction and business model better than pure
kernel-level memory fairness.

### Phase 4: Admission informed by real load data

Only after the above layers are in place should we make admission more
aggressive.

Possible later inputs:

- `memory_request`
- recent host pressure history
- project tier
- project idleness
- time-of-day demand patterns
- learned behavior from automated load testing

## Candidate Host-Level Policy Knobs

These should eventually be explicit host settings, not implicit magic constants.

### Reserve and cgroup pool

- `project_pool_memory_reserve_mb`
- `project_pool_cgroup`

### Per-project memory behavior

- `project_memory_high_ratio`
- `project_memory_reservation_ratio`
- optional per-profile swappiness or provider-specific swap policy

### Pressure and ejection

- `pressure_eject_enabled`
- `pressure_eject_idle_minutes`
- `pressure_eject_lowest_tier_first`

### Profile selection

- `memory_profile = high_density_shared | shared_pro | dedicated_private`

## Planned Load Testing

We already know that a large dedicated host and a dense student-lab host should
not be tuned the same way.

The eventual plan should include automated load testing that measures:

- how many projects of a given pattern fit on a host
- how reclaim and stall behavior changes by workload mix
- how much safety margin is needed for control-plane services
- when ejection should start relative to pressure signals

Until that exists, the policy should optimize for:

- host survival
- understandable degraded behavior
- low operational surprise

## Current Recommended Ordering

If work resumes later, the preferred order is:

1. keep the host-critical OOM protections in place
2. roll out and validate the aggregate project workload cap
3. add per-project `memory.high` and `memory_reservation`
4. add pressure-driven ejection based on tier and idleness
5. revisit admission and rebalancing after real telemetry and load tests exist

## Open Questions

### Swap and zram

No global decision has been made yet.

Current view:

- swap may be appropriate on some providers and host classes
- especially where large local SSD is available
- but it should not be assumed for every project host

### Exact reserve size

`3072 MB` is the current default for the aggregate pool reserve, but the right
number may vary by:

- host RAM size
- whether the host is shared or dedicated
- whether provider-local swap exists
- how much other control-plane software is running on the host

### Relationship between kernel policy and product policy

Kernel and cgroup settings should keep the host alive.

CoCalc policy should decide:

- which users get degraded first
- which projects get ejected first
- when to move or rebalance instead of just squeezing the host harder

Both layers are required.
