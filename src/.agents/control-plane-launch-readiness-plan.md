# Control Plane Launch Readiness Plan

This document is the working plan for making the project-host / Launchpad control plane robust enough to launch.

It incorporates product and architecture decisions made on March 20, 2026, including:

- snapshot restore is a required launch feature and is distinct from copying files from a snapshot,
- idle timeout should evolve into a priority-driven eviction model instead of hard-coded preemption windows,
- "distribute assignment to a class" is a first-class workflow to test and optimize,
- project move is primarily an admin operation and should optimize for staged, low-risk rebalancing,
- the rootfs image model is a major launch foundation and should be narrowed to two official image families plus snapshot-based reuse,
- the initial hosted-provider focus should be Nebius and GCP,
- the main site should assume long-lived non-spot hosts,
- worker splitting should be driven by measured bottlenecks, with conat routing as the most likely first split.

The dates in this document are useful for sequencing, but should not be treated as rigid. The real driver is whether the blockers are resolved and whether measured evidence says the system is stable enough to launch.

## Why This Plan Exists

The control plane does not need to be perfect. It does need to be trustworthy.

If users create projects, restart them, make snapshots, restore state, copy files between projects, or distribute assignments, and those workflows are flaky or unexpectedly slow, the resulting damage is not just technical. It directly affects retention, support load, reputation, and pricing credibility.

This plan is therefore aimed at five outcomes:

1. core workflows are correct,
2. latency is predictable,
3. overload degrades gracefully instead of randomly,
4. safe capacity is measured rather than guessed,
5. product packaging and pricing are tied to measured operational limits.

## Product Decisions To Lock In Now

These are not just engineering details. They change the launch plan and the test matrix.

### 1. Snapshot restore is a full-project restore workflow

There are two distinct user stories:

- copy files from a snapshot,
- restore the entire project to a prior snapshot state.

These must not be conflated.

Full snapshot restore should mean:

1. stop the project,
2. make a safety snapshot of current state,
3. restore one or more filesystem domains from the chosen snapshot,
4. start the project again.

Restore modes should support:

- restore rootfs only,
- restore `HOME=/root` only,
- restore both.

The UI must make it explicit that full restore is a total project-state operation, including chatrooms, codex threads, and any other project-resident state. Users wanting selective recovery should use the "copy files from a snapshot" path instead.

This is a launch blocker because:

- it is a core recovery feature,
- it belongs in the scenario matrix,
- it changes the operational model for snapshots,
- it should have first-class CLI support.

### 2. Idle timeout should become priority-driven eviction

The old hard-coded timeout model is too blunt for the hosted product.

The target model is:

- if capacity is plentiful, do not evict projects unnecessarily,
- when capacity is constrained, evict the lowest-priority projects first,
- higher membership tiers get meaningfully better survival and queue priority,
- the policy should be based on demand and priority, not arbitrary wall-clock punishment.

This should look more like priority-based cloud scheduling than the old fixed 30-minute / 2-hour / 1-day / infinity model.

Likely policy inputs:

- membership tier,
- whether the project is currently interactive,
- recent activity level,
- whether kernels/terminals are active,
- whether the project is running a high-priority operation,
- admin pinning or policy overrides,
- host pressure.

The launch plan must therefore measure not only raw capacity, but also how eviction and queuing policies affect user experience.

### 3. Assignment distribution is a first-class primitive

One of the most important real use cases is distributing a small assignment payload to many projects at once, e.g.:

- a 1 MB notebook,
- one or two small data files,
- delivery to 30 or more student projects.

This is effectively a one-to-many control-plane operation.

It is important because:

- it is common in teaching,
- it can often be optimized as local copy-on-write work on a single host,
- it is a realistic burst workload,
- it should likely become a named primitive in the system.

This needs dedicated scenarios and performance targets.

### 4. Project move is mostly an admin workflow

Users rarely have a reason to manually move projects between hosts. In practice, move is mainly for operators to rebalance the fleet, retire underused nodes, or shift projects away from expensive hardware.

This means the move design should optimize for:

- staged execution,
- safety over raw speed,
- preferring cold or idle projects first,
- optional "backup first, move later" workflows,
- auditability and rollback.

Project move still belongs in live canaries and scenario coverage, but it should be treated as an admin-grade workflow, not a common end-user click path.

### 5. Rootfs images are a major launch foundation

The broad "arbitrary glibc docker image" idea is too open-ended for launch.

The narrower and more useful initial model is:

- exactly two official Ubuntu-based image families:
  - non-GPU:
    - arm and x86,
    - standard CoCalc tooling such as build-essential, Jupyter, LaTeX, code-server, Julia, conda, `uv`, etc.
  - GPU:
    - x86 only,
    - same base plus GPU libraries such as PyTorch and TensorFlow
- images stored in R2 as btrfs streams,
- each project records image family and version,
- users may customize rootfs via package installs and other changes,
- users may snapshot their customized rootfs for reuse,
- admins may promote rootfs snapshots for global availability,
- normal users may publish their rootfs snapshots with a clear distinction from official images.

This is a major launch dependency because it is the basis for:

- efficient new project creation,
- reproducible environments,
- "configure once, reuse many times" workflows,
- operationally manageable host provisioning.

This should be treated as one of the largest unfinished launch features.

### 6. Hosted launch assumptions

For the main site, assume:

- no spot instances,
- stable, long-running hosts,
- emphasis on disk management, host lifecycle, and predictable costs,
- initial hosted-provider focus on:
  - Nebius,
  - GCP

Nebius is important because of pricing, growable disks, free bandwidth, GPU availability, and partnership terms.

GCP is important because of geography and broad regional coverage.

User-owned project hosts and spot-instance support are valuable, but they are not hard launch requirements.

## Launch Blockers

The system is not launch-ready until these blockers are either implemented or explicitly deferred out of launch scope.

### Blocker A: Full snapshot restore

Deliverables:

- control-plane workflow,
- CLI support,
- UI distinction from file-level restore,
- safety snapshot before destructive restore,
- test coverage for rootfs-only, home-only, and full restore modes.

### Blocker B: Rootfs image system

Deliverables:

- official image family model,
- image versioning,
- R2 btrfs stream distribution path,
- project metadata for selected image and version,
- rootfs snapshot export / import / promotion path,
- basic UI and CLI surfaces for selecting official images and snapshot-based images.

### Blocker C: Admission / eviction policy

Deliverables:

- host pressure model,
- project priority heuristic,
- eviction and queue policy,
- tier-aware behavior,
- visibility into why a project was stopped or spared.

### Blocker D: Host pricing and billing foundation

Deliverables:

- provider catalog ingestion sufficient for pricing,
- billing model for predictable providers,
- initial decision on whether GCP host resale is in or out of launch scope,
- user-visible pricing semantics.

## Core Questions This Plan Must Answer

### Reliability

- Can users consistently create, open, restart, snapshot, restore, copy, and distribute work?
- Does the system remain correct under retries, reconnects, host drains, and provider failures?
- Are all destructive operations either reversible or protected by safety snapshots / backups?

### Performance

- What are the p50, p95, and p99 latencies of the critical workflows?
- How much time is spent in central-hub mediation versus direct project-host work?
- Which workflows are provider-bound, filesystem-bound, routing-bound, or event-loop-bound?

### Capacity

- How many light, medium, and heavy projects fit safely on each host class?
- How many concurrent expensive operations can run without harming active projects?
- What is the right production safety margin?

### Architecture

- Is the current single Node.js process sufficient for launch load?
- If not, which subsystem should be split first?
- Does conat routing become the earliest bottleneck under terminal/chat/codex load?

### Packaging

- What operational guarantees should `$8`, `$20`, and `$200` imply?
- How should tier affect scheduling priority, eviction risk, and concurrency?

## Workflow Taxonomy

The plan and test matrix should use the following distinctions.

### Project lifecycle

- create project
- open project
- stop project
- start project
- restart project

### Snapshot and backup workflows

- create snapshot
- list snapshots
- copy files from snapshot
- full snapshot restore
- create backup
- list backups
- restore backup

### Cross-project workflows

- copy-path one-to-one
- assignment distribution one-to-many

### Host / admin workflows

- staged move
- host drain
- rebalance
- host retirement

## Launch SLO Framework

Every critical workflow needs:

- success-rate target,
- p95 target,
- p99 target,
- timeout budget,
- stuck-operation budget,
- degraded-mode behavior.

Initial critical workflow table:

| Workflow                 | Outcome                                  | Notes                                                 |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------- |
| create project           | new project is usable                    | should account for image selection and host placement |
| open existing project    | project is usable                        | warm and cold open should be separate                 |
| restart project          | project comes back cleanly               | central-hub vs direct-host latency should be measured |
| create snapshot          | snapshot is durable and visible          |                                                       |
| copy files from snapshot | selected content appears in destination  | this is not full restore                              |
| full snapshot restore    | project returns to prior state correctly | must be explicit and safe                             |
| create backup            | backup exists and is selectable          |                                                       |
| restore backup           | project data is restored correctly       |                                                       |
| copy-path                | content appears in destination project   | small and medium cases                                |
| assignment distribution  | content appears across many projects     | one-to-many, should test CoW optimization             |
| staged move              | project is relocated safely              | mostly admin-facing                                   |

Separate SLO tracking should exist for:

- warm host / warm project,
- cold project on existing host,
- host creation path,
- degraded provider path.

## Scenario Inventory

### Single-user core scenarios

- create a project from the default non-GPU image and open it
- create a project from a promoted custom rootfs image and open it
- open an idle project
- restart an active project
- create a snapshot
- copy selected files from a snapshot
- restore full project from a snapshot using each restore mode
- create and restore a backup
- copy a small file between two projects
- copy a medium directory tree between two projects
- open editor, terminal, Jupyter, and codex in one project
- disconnect browser during an active operation and reconnect

### Teaching / distribution scenarios

- distribute a small assignment to 30 projects on one host
- distribute a small assignment to 30 projects spread across multiple hosts
- update an assignment and fan it out again
- run assignment distribution while many students are already active

### Admin scenarios

- staged move of an idle project
- staged move of a recently active project
- drain a host by moving or stopping low-priority projects first
- retire an underused GPU node

### Failure scenarios

- provider host creation is slow
- provider host creation fails transiently
- central control hub adds latency or becomes unavailable
- websocket / conat disconnect between components
- file-server stalls or restarts
- persist server stalls or restarts
- conat router is saturated by high terminal output
- project-host process restarts mid-operation
- disk approaches full
- host becomes unreachable during a move or restore

### Soak scenarios

- 24h mixed interactive load on one host class
- 24h mixed interactive plus control-plane load on multiple hosts
- 24h with codex app-server usage included

## Metrics and Telemetry

The goal is not just to export metrics somewhere. The goal is to make them operationally useful and easy to query through the system itself.

### Control-plane metrics

- operation count by type and state
- queue depth by operation type
- operation wait time vs execution time
- timeout count by workflow
- retry count by workflow
- stuck-operation count
- orphaned-operation count
- reconciliation actions and success rate

### Central-hub dependency metrics

- latency added by the central control hub for start/stop/restart flows
- percentage of end-to-end latency spent in central mediation versus direct host work
- queue depth and processing latency inside the control hub for project lifecycle operations

### Project-host process metrics

- RSS
- CPU usage
- event loop lag
- GC behavior
- per-subsystem request latency
- websocket count
- queue depth

### Host metrics

- CPU saturation
- RAM saturation
- disk usage
- disk IO and latency
- network throughput
- running project count
- active kernel count
- active terminal count
- active codex app-server count
- expensive-operation count

### Conat / routing metrics

- routing throughput
- message fanout volume
- compression/decompression cost
- auth-check cost
- latency impact under heavy terminal output

### Codex metrics

- codex app-server instance count
- RAM and CPU usage by codex services
- queueing or backpressure behavior
- impact of codex load on unrelated project workflows

### Provider / cost metrics

- host create latency
- host bootstrap latency
- host delete latency
- disk growth behavior
- provider API error rate
- rate-limit events
- price observability quality by provider

### Presentation strategy

Prometheus may still be useful, but the main requirement is that host metrics should also be queryable and explorable through CoCalc-native tools and eventually visible in the UI, similar to existing project metrics.

The plan should assume:

- host metrics accessible through `cocalc` CLI,
- host metrics stored in a queryable internal form,
- dashboards or plots visible in the product for operators.

## Admission Control and Priority-Driven Eviction

The hosted system should prefer queueing and selective eviction to indiscriminate hard timeouts.

### Required controls

- max running projects per host
- max concurrent expensive operations per host
- max concurrent expensive operations per user
- queue priority classes for interactive vs background work
- host pressure thresholds
- stale-operation reconciliation

### Target policy

- if capacity is available, do not evict projects just because time elapsed,
- when capacity is constrained, stop or move the lowest-priority eligible projects first,
- preserve higher-tier and actively used projects whenever possible,
- prefer evicting idle, low-priority, cold projects before anything interactive.

### Likely priority inputs

- membership tier
- current interactive activity
- recent activity history
- current heavy operation status
- admin pinning
- host pressure

### Test outcomes needed

- verify which projects get evicted under pressure,
- verify that higher priority actually wins,
- verify that eviction decisions are legible and explainable,
- verify that operator rebalancing and automatic eviction do not fight each other.

## Load and Stress Testing Program

The goal is to find safe sustained operating points, not heroic peaks.

### Workload profiles

- light:
  - editor,
  - shell,
  - occasional file operations
- medium:
  - editor,
  - terminal,
  - light Jupyter activity
- heavy:
  - active kernels,
  - filesystem churn,
  - snapshots, backups, or copy operations
- routing-heavy:
  - multiple terminals with high output volume
- codex-heavy:
  - active codex app-server usage

### Host classes to test

Test the host classes you actually expect to run in production:

- small shared host
- medium shared host
- larger premium host
- at least one GPU-capable host class

### Provider focus

Initial hosted stress testing should focus on:

- Nebius
- GCP

This is enough to answer the launch questions. Broader provider work can come later.

### Special scenarios to benchmark

- many projects opening at once
- many restarts at once
- assignment distribution to a class
- background snapshots / backups during interactive use
- routing-heavy terminal fanout
- codex-heavy mixed usage
- admin drain / staged move under moderate background load

### Output of each sweep

Each sweep should produce:

- provider
- host class
- workload mix
- admitted concurrency
- p50 / p95 / p99 by workflow
- CPU / RAM / disk / network usage
- event loop lag
- conat routing load
- failure modes observed
- recommended safe cap
- recommended production cap with headroom

Production limits should sit materially below the knee.

## Architecture Decision: Single Process vs Worker Split

Do not split everything because the architecture allows it. Split when measurement says the single process is the limiting factor.

### Default assumption

Launch with the single process if all of the following are true under realistic load:

- event loop lag remains acceptable,
- core workflows meet p95 / p99 targets,
- one hot subsystem does not poison unrelated work,
- memory growth remains controlled,
- Node.js process tuning is sufficient,
- operational simplicity is clearly better than added worker complexity.

### Things to audit before deciding

- how much latency is added by central control hub mediation,
- whether direct host paths can replace hub-mediated paths in common operations,
- Node.js process parameter tuning such as max RSS or memory limits,
- which subsystem dominates CPU under mixed load.

### Most likely first split candidate

The most likely first split is conat routing.

Reason:

- high-output terminals create heavy pub/sub pressure,
- routing involves compression, decompression, auth checks, and fanout,
- it can plausibly saturate one Node.js process before filesystem or persistence work does.

### Next split candidates

If the data shows they matter:

- file-server worker
- conat persist / coordination worker

### Decision criteria

- event loop lag under routing-heavy load
- control-plane latency under routing-heavy load
- CPU profile by subsystem
- failure isolation benefit
- operational complexity cost

## Pricing, Billing, and Membership Translation

Do not define memberships from intuition. Define them from measured capacity and explicit policy.

Fixed price points:

- `$8`
- `$20`
- `$200`

### What each tier should express

- guaranteed RAM
- guaranteed CPU share or reservation
- max concurrent active projects
- max concurrent heavy operations
- queue / eviction priority
- degree of isolation from noisy neighbors

### Likely interpretation

- `$8`:
  - shared and best-effort,
  - lowest priority,
  - tight concurrency limits
- `$20`:
  - better interactivity and lower eviction risk,
  - more concurrency,
  - higher queue priority
- `$200`:
  - materially stronger guarantees,
  - much lower eviction risk,
  - likely access to larger or more isolated capacity

### Billing caveats

Host pricing and billing are not fully implemented yet.

Implications:

- pricing work is itself a launch requirement if user-owned or user-selected host types are in scope,
- Nebius and other predictable-price providers are easier to expose cleanly,
- GCP bandwidth pricing is especially annoying and may be too opaque for launch resale,
- user-owned project hosts are valuable but not a hard launch requirement.

The initial hosted launch can succeed even if host resale is limited or disabled, provided internal costing and capacity policy are solid.

## Continuous Live Canaries

Critical canaries should run continuously on the actual providers and host classes that matter for launch.

Required canaries:

- create/open project
- restart project
- create snapshot
- copy files from snapshot
- backup-snapshot
- copy-path
- assignment distribution
- staged move

Each canary should produce:

- artifact directory
- summary
- step ledger
- duration
- cleanup result

Alerting should fire on:

- repeated failures
- cleanup leaks
- rising latency
- growing stuck-op count

## Execution Order

The plan should be executed in priority order, not on a rigid calendar.

### Priority 0: Close the obvious feature gaps

- implement full snapshot restore
- define and begin implementing the rootfs image model
- define the initial admission / eviction policy

These are more important than broad stress testing because they directly determine what needs to be tested.

### Priority 1: Add observability and audit critical paths

- add the missing host and routing metrics
- add codex usage metrics
- audit central-hub dependency for project lifecycle flows
- identify direct-to-host paths that could remove avoidable latency

### Priority 2: Stabilize and expand live canaries

- keep GCP and Nebius critical workflow canaries green
- add snapshot-file-copy and assignment-distribution canaries
- add admin move canaries oriented around staged operation

### Priority 3: Capacity sweeps and pressure-policy testing

- run host-class capacity sweeps
- validate queueing and eviction behavior
- measure routing-heavy and codex-heavy loads

### Priority 4: Soak, operator safety, and launch packaging

- 24h / 48h soak tests
- operator runbooks
- kill switches
- pricing-to-capacity mapping

## Launch Gates

The system is ready for launch only if:

- full snapshot restore exists and is safe,
- the rootfs image foundation is sufficiently implemented for new-project provisioning,
- core workflows meet SLOs on Nebius and GCP,
- live canaries are stable,
- admission / eviction policy is implemented and tested,
- safe host capacity numbers exist,
- routing-heavy loads do not destabilize the system,
- operators have host-level metrics, runbooks, and kill switches,
- pricing / membership semantics are tied to measured policy and capacity.

## Immediate Next Actions

1. Implement full snapshot restore with explicit restore modes and CLI support.
2. Turn the rootfs image model into a concrete implementation plan and start the minimal launch path.
3. Define the first version of the priority-driven eviction heuristic.
4. Audit start / stop / restart latency to quantify how much the central control hub contributes.
5. Add host, routing, and codex metrics that are queryable through CoCalc-native tools.
6. Add assignment-distribution scenarios and canaries.
7. Use the resulting data to decide whether conat routing must be split before launch.

## Principle

The launch decision should not be based on whether the system feels good in ad hoc testing.

It should be based on evidence that:

- the missing core features are actually implemented,
- the important workflows are correct,
- the tails are acceptable,
- overload is controlled,
- the safe operating region is known,
- the pricing and membership model matches that operating region.
