# Scalable Architecture Release Checklist

Status: current execution checklist as of 2026-04-24.

This document replaces the older broad “remaining checklist” as the main
working checklist for getting multibay CoCalc to:

- a releaseable product soon
- an architecture that is credibly scalable
- an operational model that is boring enough to run

It is intentionally grounded in the current evidence:

- split-ingress multibay routing is working
- the hot-path `three-bay` benchmark improved dramatically after `fast-rpc`
  plus routing-context caching
- the synthetic hot path is no longer obviously Postgres-bound
- the current control-plane architecture appears viable enough to harden rather
  than redesign

Related background documents:

- [scalable-architecture-remaining-checklist-2026-04-18.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-remaining-checklist-2026-04-18.md)
- [bay-hub-load-testing-plan.md](/home/user/cocalc-ai/src/.agents/bay-hub-load-testing-plan.md)
- [scalable-architecture-implementation-plan.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-implementation-plan.md)
- [scalable-architecture.md](/home/user/cocalc-ai/src/.agents/scalable-architecture.md)
- [membership-usage-limits-release-spec-2026-04-25.md](/home/user/cocalc-ai/src/.agents/membership-usage-limits-release-spec-2026-04-25.md)

## Current Read

What now looks good enough:

- multibay routing is real, not speculative
- stable-URL browser bootstrap plus hidden home-bay routing is real
- split ingress is the correct direction
- project-host runtime traffic can and should keep moving off the bays
- the hot control-plane path can already reach useful throughput on a large VM

What still looks risky for release:

- correctness under real operational churn
- state convergence / reconciliation bugs
- auth and operator flows that are still too environment-sensitive
- tests and soak confidence
- translating synthetic throughput into believable real-user capacity

The main strategic conclusion is:

- do not spend the next block of time redesigning architecture again
- do spend the next block of time hardening, measuring, and simplifying

## Release Target

The near-term release target should be:

- one coherent multibay product that is safe to dogfood heavily and release
  conservatively
- conservative scope
- simple ownership rules
- explicit operator workflows
- enough measured headroom that scale is a deployment problem, not an immediate
  product blocker

For first release, the system does **not** need:

- finished account rehome
- finished project rehome
- final “1M users proven” capacity evidence
- every possible auth/key feature preserved

For first release, the system **does** need:

- correctness
- operational clarity
- reproducible deployment
- enough capacity evidence to size bays conservatively

## Must Have Before Release

### 1. Keep The Architecture Frozen Enough To Harden

- [ ] declare the first-release architectural invariants in one place:
      - split ingress stays
      - browser keeps one stable public URL
      - account home bay owns account/session authority
      - project owning bay owns project authority
      - project-host runtime traffic should bypass bays whenever possible
      - billing/purchases remain seed-owned for first release
- [ ] explicitly remove or disable project API keys if they are truly unused
- [ ] keep account API keys and define the minimum acceptable scope model, even
      if full scoped-key rollout happens later
- [ ] avoid adding new cross-bay architectural mechanisms unless a measured
      blocker forces them

### 2. Green And Stable Test Surface

- [ ] get `pnpm test conat` back to consistently green
- [ ] get package-level failures caused by recent `fast-rpc` and routing work
      back to green
- [ ] identify which integration tests are authoritative for multibay release
      readiness
- [ ] add one stable CI target for the hot-path benchmark plumbing that checks
      correctness, not throughput
- [ ] ensure recent auth, host-state, and routing regressions each have a
      permanent test

### 3. Bay State Correctness And Reconciliation

- [ ] finish the stale-host propagation hardening:
      - stale remote host rows must not override owner/seed truth
      - deleted/deprovisioned state must converge across bays
- [ ] make “VM gone but host row still looks provisioned” converge
      automatically and quickly
- [ ] make cloud orphan detection and DB orphan detection explicit operator
      workflows
- [ ] make host-card/manual inspection paths trigger enough refresh to be
      trustworthy
- [ ] finish host search/filter by `host_id`, IP, and other operator-relevant
      identifiers

### 4. Deployment And Packaging

- [ ] finish the bay packaging flow under `src/packages/rocket`
- [ ] make one standard deploy artifact and one standard deploy command path
- [ ] make restart/rollback/update behavior reproducible and documented
- [ ] verify the packaged bay runtime actually works on a clean VM without
      local-dev assumptions
- [ ] document the minimum supported bay host environment

### 5. Authentication And Operator Ergonomics

- [ ] make benchmark/auth behavior deterministic even in env-heavy dev shells
- [ ] eliminate accidental auth target confusion caused by ambient
      `CONAT_SERVER`, bearer, or project-secret env
- [ ] define one supported operator credential story for release:
      preferably scoped and short-lived, but at minimum explicit and auditable
- [ ] make `cocalc-cli` bay/operator commands reliable enough that they do not
      depend on hidden local context

### 6. Real Product Soak

- [ ] keep one real 3-bay dogfood cluster running for an extended soak window
- [ ] exercise restarts, host churn, invite flows, browser reconnects,
      notebook/terminal/app-server flows, and admin operations on that cluster
- [ ] fix every multibay correctness bug found during that soak before calling
      the product release-ready
- [ ] capture a short written “known operational hazards” list from the soak

## Should Have Before Release

### 7. Observability That Operators Can Actually Use

- [ ] add/export control-plane traffic stats in the frontend session dialog
- [ ] include rates, not just cumulative counters
- [ ] add a one-click JSON export for usage/session traffic data
- [ ] make per-bay / per-worker health, lag, and routing state visible enough
      for debugging
- [ ] define the minimum observability set required for production operation:
      - message rates
      - event-loop delay
      - per-worker CPU
      - Postgres pressure
      - routing-context latency
      - host reconciliation lag

### 8. Simplify The Hot Path Further Where Cheap

- [ ] keep `fast-rpc` on the common small-call path
- [ ] preserve a safe fallback for oversized responses without redoing expensive
      calls
- [ ] continue moving obvious runtime traffic off bays and onto project-host
      direct paths
- [ ] keep short-lived routing-context caching if it remains correctness-safe
- [ ] measure first before doing more low-level Conat/router surgery

### 9. Purchases / Seed-Owned Billing Safety Review

- [ ] explicitly review everything touching `purchases` and billing ownership
- [ ] confirm what still assumes single-bay local state
- [ ] ensure first release cannot silently split billing authority across bays
- [ ] add a checklist item or design note for the later fuller billing move, if
      needed

## Capacity Checklist

This section is about getting from “promising benchmark” to “credible sizing”.

### 10. Convert Synthetic Throughput Into Bay Sizing

- [ ] rerun the remote-loadgen benchmark against `bay-test` or equivalent using
      the now-working SSH-forwarded localhost topology
- [ ] capture the current best same-box and separate-loadgen benchmark results
      in one short summary table
- [ ] define the current canonical synthetic benchmark:
      - exact command
      - VM size
      - worker count
      - concurrency
      - ingress topology
- [ ] stop changing the benchmark shape casually once that canonical version is
      chosen

### 11. Measure Real Dogfood User Profiles

- [ ] capture real browser/control-plane message rates during normal dogfooding
- [ ] export and save representative JSON samples
- [ ] classify at least:
      - idle/background user
      - normal active user
      - heavy active user
      - pathological/buggy user
- [ ] identify obvious “this should be on project-host, not bay” traffic and
      treat it as a bug list

### 12. Build A Simple Capacity Model

- [ ] turn real-user message rates plus synthetic benchmark rates into a simple
      per-bay capacity estimate
- [ ] write down a conservative target operating point with headroom, not just
      a peak number
- [ ] estimate how many bays are needed for early release, medium-term growth,
      and the larger long-term goal
- [ ] document what currently limits capacity:
      - load generator
      - Node worker saturation
      - socket/router overhead
      - event-loop delay
      - or something else

## Explicitly Deferred Until After Release

These are important, but they should not block a conservative first release
unless new evidence says otherwise.

### 13. Major Post-Release Scalability Work

- [ ] account rehome completion
- [ ] project rehome completion
- [ ] stronger scoped account API key model
- [ ] formal operator credential model with short-lived scopes
- [ ] deeper Conat/router protocol work beyond the already-proven hot-path wins
- [ ] bigger multi-VM / multi-loadgen capacity campaigns
- [ ] final million-user envelope modeling

## Exit Criteria For “Ready To Release Conservatively”

The product should be considered ready for a first real release when:

- the important multibay correctness tests are green
- the dogfood cluster has survived a meaningful soak without scary unresolved
  routing/state bugs
- deployment and rollback are reproducible
- host/cloud reconciliation is not obviously untrustworthy
- purchases/billing authority is explicitly bounded to the seed where intended
- operator auth and CLI flows are clear enough to use safely
- real-user traffic has been sampled and compared against the benchmark model
- there is a conservative written bay-sizing story

## Immediate Next Block

If we want the next block of work to be maximally pragmatic, do these next:

- [ ] get the Conat/package test surface green again
- [ ] finish the stale host / deprovision propagation hardening
- [ ] finish the bay packaging/deploy path
- [ ] rerun remote-loadgen benchmarking on the SSH-forwarded localhost topology
- [ ] add/export real browser session traffic stats
- [ ] run a real 3-bay soak and fix the bugs it finds

That is the shortest path from “promising architecture work” to “releaseable and
scalable enough product”.
