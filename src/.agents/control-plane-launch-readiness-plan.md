# Control Plane Launch Readiness Plan

This document is the working plan for making the project-host / Launchpad control plane robust enough to go live in roughly two weeks.

Target launch window:

- start of plan: March 20, 2026
- target go-live decision: April 3, 2026

This plan is intentionally operational. It is not a product vision document. It defines what must be true before launch, how to measure it, and what work should happen between now and the launch decision.

## Context

The risk is not that one operation fails in isolation. The risk is that under real user load:

- projects become slow or flaky,
- control-plane operations wedge or time out,
- host pressure causes unrelated projects to degrade,
- operator confidence is low because the system lacks hard limits and clean signals,
- pricing is set from intuition instead of measured safe capacity.

The launch goal is therefore:

1. user-visible core workflows are correct and predictably fast,
2. overload causes queueing or refusal, not random breakage,
3. safe per-host capacity is known for each main machine class,
4. membership tiers map to measured resource budgets rather than guesses.

## Non-Negotiables

The control plane is not launch-ready unless all of the following are true:

- no known stuck or corrupting core workflow remains unresolved,
- all critical workflows have explicit SLO targets,
- live canaries continuously exercise critical workflows on real providers,
- per-host and per-user admission control exists for expensive operations,
- there is a way to detect and reconcile orphaned or wedged operations,
- safe sustained concurrency is measured for the main host classes,
- launch rollback and kill-switch procedures are documented and tested.

## Core Questions This Plan Must Answer

### Reliability

- Can users consistently create, open, restart, move, snapshot, restore, and copy data between projects?
- Does the system remain correct under retries, reconnects, and host churn?
- Do operations either complete, fail cleanly, or reconcile later?

### Performance

- What are the p50, p95, and p99 latencies for the critical workflows?
- Which workflows are bottlenecked by provider APIs, host bootstrap, filesystem work, or the project-host process itself?
- How much headroom exists before tail latency bends badly?

### Capacity

- How many light, medium, and heavy projects can safely run at once on each host class?
- How many expensive control-plane operations can be admitted concurrently without harming active interactive sessions?
- What is the right safety margin for production limits?

### Architecture

- Is the current single process for project-host acceptable at the required load?
- If not, which components should move first into worker processes?
- What metrics justify that split, and what failure isolation does it buy?

### Packaging

- What should `$8`, `$20`, and `$200` memberships actually guarantee?
- Which limits are best-effort vs guaranteed?
- How much queue priority or isolation should each tier provide?

## Launch SLO Framework

Every critical workflow must have:

- success-rate target,
- p95 latency target,
- p99 latency target,
- timeout budget,
- stuck-operation budget,
- degraded-mode behavior.

Initial control-plane SLO categories:

| Workflow              | User-visible outcome                 | Notes                                       |
| --------------------- | ------------------------------------ | ------------------------------------------- |
| create project        | new project is usable                | includes host placement and first readiness |
| open existing project | project is usable                    | warm vs cold should be separated            |
| restart project       | project returns cleanly              | includes reconnect behavior                 |
| stop/start project    | project stops or resumes predictably |                                             |
| snapshot create       | snapshot is created and listed       |                                             |
| snapshot restore      | prior state is restored correctly    | correctness matters more than raw speed     |
| copy-path             | file/tree appears at destination     | small-file and large-tree variants          |
| move project          | project moves without corruption     | includes cutover correctness                |
| list backups          | backups are visible                  |                                             |
| backup restore        | restored content matches source      |                                             |

Separate SLOs should exist for:

- warm host / warm project,
- cold project on existing host,
- host creation path,
- degraded provider conditions.

## Scenario Inventory

The test program must cover the following scenarios.

### Single-user core scenarios

- create a project and open it
- open an existing idle project
- restart an active project
- stop and start a project
- create a snapshot, list it, restore it
- create a backup, select it, restore it
- copy a small file between two projects
- copy a medium directory tree between two projects
- move a project to another host
- open editor, terminal, and Jupyter together in one project
- disconnect browser during an active operation and reconnect

### Multi-user realistic scenarios

- many users opening projects at the same time
- many users restarting projects at the same time
- background snapshots/backups while interactive sessions remain active
- many cross-project copy-path operations
- mixed light and heavy projects on the same host
- project moves during peak interactive load

### Failure scenarios

- provider host creation is slow
- provider host creation fails transiently
- provider API returns errors or rate limits
- websocket/conat disconnect between control-plane components
- file-server stalls or restarts
- persist server stalls or restarts
- project-host process restarts mid-operation
- disk fills or approaches limit
- host becomes unreachable or drains during active use

### Soak scenarios

- 24-hour mixed-load run on one host class
- 24-hour mixed-load run across multiple hosts/providers
- long-running low-level background operations while users continue interacting

## Metrics and Telemetry

At minimum, instrument and dashboard the following.

### Control-plane metrics

- operation count by type and state
- queue depth by operation type
- operation wait time vs execution time
- retry count by workflow
- timeout count by workflow
- orphaned operation count
- reconciliation actions and success rate

### Project-host process metrics

- RSS
- CPU usage
- event loop lag
- GC pause behavior
- open websocket count
- internal queue depth
- request latency for file, persist, and op-control paths

### Host metrics

- CPU saturation
- RAM saturation
- disk IO and latency
- network throughput
- running project count
- active kernel count
- terminal count
- expensive operation count

### Provider metrics

- host create latency
- host bootstrap latency
- host delete latency
- provider API failure rate
- rate-limit events

## Admission Control and Safety Limits

Before launch, the system should prefer explicit refusal or queueing to soft overload.

Required controls:

- max running projects per host
- max concurrent expensive operations per host
- max concurrent expensive operations per user
- queue priority classes for interactive vs background work
- timeout policies per workflow
- kill switches for risky workflows
- reconciliation of stale running operations

Recommended priority order:

1. keep already-active projects responsive,
2. admit lightweight interactive actions,
3. queue heavy background operations,
4. reject or defer work when host safety limits are hit.

The system should never enter a state where a storm of snapshots or moves makes existing interactive projects effectively unusable.

## Load and Stress Testing Program

The goal is to find safe sustained operating points, not theoretical maxima.

### Workload profiles

Define at least these project profiles:

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
  - snapshots or copies
- ops-heavy:
  - many control-plane actions,
  - less interactive compute

### Host classes to test

Test the host classes you are likely to sell against or depend on operationally. At minimum:

- small baseline host
- medium shared host
- large host for higher-tier users

For each class, run increasing concurrency until at least one of the following bends:

- p95 latency,
- p99 latency,
- timeout rate,
- stuck-op rate,
- event loop lag,
- memory pressure,
- filesystem latency.

### Output of each capacity sweep

Each sweep should produce:

- host class,
- workload mix,
- admitted concurrency,
- p50/p95/p99 by workflow,
- CPU/RAM/IO usage,
- failure modes observed,
- recommended safe cap,
- recommended production cap with headroom.

Production caps should sit well below the knee, ideally with 30% to 50% headroom.

## Architecture Decision: Single Process vs Worker Split

Do not split the project-host architecture preemptively unless measurement shows it is necessary.

### Default recommendation

Keep the single-process design if all of the following remain true under target load:

- event loop lag is acceptable,
- p95/p99 of control-plane workflows stay within target,
- one hot subsystem does not poison unrelated work,
- memory growth is controlled,
- crash risk is low enough,
- operational simplicity is materially better.

### Split into workers when one or more are true

- file-serving load degrades unrelated control-plane latency,
- persist/conat work degrades unrelated control-plane latency,
- one subsystem has very different scaling or restart behavior,
- crash isolation becomes necessary,
- event loop lag shows one busy subsystem is harming everything else.

### First split candidates

If a split is needed, start with the most isolatable and load-sensitive components:

- file-server worker
- conat persist / coordination worker

Do not split everything at once. Make the first split solve a measured problem.

### Decision criteria

Use real measurements, not instinct:

- event loop lag under load
- per-subsystem latency under load
- failure isolation benefit
- deployment complexity cost
- observability cost

## Pricing and Membership Translation

Do not define memberships from intuition. Define them from measured safe capacity.

The pricing points are fixed:

- `$8`
- `$20`
- `$200`

The missing piece is what each price buys in operational terms.

### What should be expressed per tier

- guaranteed RAM
- guaranteed CPU share or reservation
- maximum number of concurrently active projects
- maximum number of concurrent heavy operations
- priority in operation queues
- snapshot/backup allowances if relevant
- level of isolation from noisy neighbors

### Likely interpretation

- `$8`:
  - shared, best-effort, tight concurrency limits
- `$20`:
  - better interactive reliability, more concurrency, higher priority
- `$200`:
  - strong guarantees, materially lower contention risk, possibly host-level isolation

### How to derive the numbers

For each host class and workload mix:

1. measure safe sustained capacity,
2. reserve headroom for control-plane actions and noisy bursts,
3. decide what fraction of that safe capacity can be sold as guaranteed,
4. leave the rest for burst and operational slack.

The final tier mapping should be a capacity sheet, not a marketing guess.

## Continuous Live Canaries

The existing live workflow harnesses should become ongoing production-readiness canaries.

Critical canaries:

- create/open project
- restart project
- backup-snapshot
- copy-path
- move project

They should run continuously across the providers and host classes you plan to depend on.

Each canary should produce:

- artifact directory,
- workflow summary,
- ledger of steps,
- duration,
- cleanup result.

The canary program should also page or at least alert on:

- repeated failures,
- repeated cleanup leaks,
- rising latency,
- growing stuck-op count.

## Concrete Deliverables Before Launch

### 1. SLO table

A markdown or JSON artifact listing:

- workflow
- success-rate target
- p95 target
- p99 target
- timeout budget
- degraded-mode behavior

### 2. Scenario matrix

A tracked artifact enumerating:

- scenario name
- user value
- automated vs manual
- provider coverage
- host-class coverage
- pass/fail status

### 3. Load-test harness

A harness that can:

- generate project populations,
- drive mixed workloads,
- measure end-to-end workflow latency,
- record host saturation,
- record control-plane lag,
- produce a machine-readable result set.

### 4. Capacity report

A report per host class with:

- safe project count by workload mix,
- safe concurrent heavy-op count,
- recommended production cap,
- failure mode notes.

### 5. Admission-control settings

Repo-tracked default settings or a documented config sheet for:

- host project limits,
- heavy-op concurrency,
- queue policy,
- timeout policy,
- retry policy.

### 6. Launch runbooks

At minimum:

- how to pause risky workflows,
- how to drain a host,
- how to identify stuck operations,
- how to reconcile or clean up orphaned state,
- how to roll back a bad deploy.

## Two-Week Execution Plan

### March 20 to March 24: Foundation and instrumentation

- define the critical workflows and SLO draft
- add missing metrics and dashboards
- make live canaries reliable and cheap enough to run frequently
- document the scenario matrix
- build the first load-test harness for mixed project workloads

### March 24 to March 28: Capacity and admission control

- run host-class capacity sweeps
- measure concurrency knees
- identify safe per-host project limits
- identify safe per-host heavy-op limits
- set initial admission-control defaults

### March 28 to April 1: Soak and failure injection

- run 24h and 48h soak tests
- inject provider and process faults
- verify cleanup and reconciliation
- verify overload behavior is queue/refuse, not random breakage
- decide whether the single-process design survives target load

### April 1 to April 3: Packaging and launch decision

- finalize pricing-to-capacity mapping
- review launch gates
- confirm dashboards and runbooks
- decide go / no-go / partial rollout

## Launch Gates

The system is ready for go-live only if:

- critical workflows meet SLOs on real providers,
- no severe correctness bug remains in core workflows,
- live canaries are green and stable,
- soak tests do not show growth in leaks or wedged operations,
- admission control is in place and tested,
- safe capacity numbers exist for the main host classes,
- pricing tiers can be mapped to measured budgets,
- operators have clear runbooks and kill switches.

## Immediate Next Actions

1. Write the first SLO table for the critical workflows.
2. Enumerate the scenario matrix in a repo-tracked artifact.
3. Choose the first three host classes for capacity sweeps.
4. Add the metrics needed to measure event loop lag, operation queue depth, and per-host pressure.
5. Turn the Nebius and GCP workflow harnesses into continuously runnable canaries.
6. Build the first mixed-workload stress harness.
7. Use the resulting data to decide whether project-host stays single-process for launch.

## Principle

The launch decision should not be based on whether the system feels okay during ad hoc testing.

It should be based on measured evidence that:

- the critical workflows are correct,
- the tails are acceptable,
- overload is controlled,
- the safe operating region is known,
- the business tiers match that operating region.
