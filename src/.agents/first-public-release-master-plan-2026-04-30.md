# First Public Release Master Plan

Status: master release planning and execution tracker as of 2026-04-30.

This document is the single planning / todo document for the first public
release of `cocalc-ai`.

It is intentionally stricter than the surrounding design docs. The point is
not to capture every good idea. The point is to ship a coherent first release
without expanding scope.

This plan explicitly includes:

- multibay scalability and operational hardening
- self-serve hosts
- shared-host and dedicated-host resource protection
- fixing all known release-relevant bugs we have already uncovered

This plan explicitly excludes:

- speculative new product features
- large architectural redesigns
- “nice to have” platform expansion that is not required for the first release

Related documents:

- [scalable-architecture-release-checklist-2026-04-24.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-release-checklist-2026-04-24.md)
- [control-plane-launch-readiness-plan.md](/home/user/cocalc-ai/src/.agents/control-plane-launch-readiness-plan.md)
- [membership-usage-limits-release-spec-2026-04-25.md](/home/user/cocalc-ai/src/.agents/membership-usage-limits-release-spec-2026-04-25.md)
- [shared-host-stopping-eviction-spec-2026-04-29.md](/home/user/cocalc-ai/src/.agents/shared-host-stopping-eviction-spec-2026-04-29.md)
- [self-hosted-cloud.md](/home/user/cocalc-ai/src/.agents/self-hosted-cloud.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)
- [project-host-auth.md](/home/user/cocalc-ai/src/.agents/project-host-auth.md)

## Release Definition

The first public release means:

1. a real multibay hosted CoCalc deployment that is trustworthy enough for
   conservative public use
2. a narrow but real self-serve host offering
3. a pricing / limits / enforcement model that protects cost and keeps the
   system stable
4. clear operator workflows for deployment, rollback, host lifecycle, and
   incident response

It does **not** mean:

1. every long-term launchpad/platform ambition ships now
2. every scalability question is answered forever
3. every provider and every hosting mode is equally polished

## Scope Freeze

The following scope is in for the first public release:

### 1. Multibay Hosted CoCalc

- split-ingress multibay routing
- stable browser URL and home-bay model
- project-host direct runtime routing where already designed
- seed-owned purchases/billing authority for first release

### 2. Self-Serve Hosts

- self-hosted cloud connector path
- narrow provider story and explicit install path
- safe pairing/auth model
- clear supported environments

### 3. Resource Protection And Limits

- membership-driven compute priority
- per-project storage
- total account storage
- project count
- managed egress limits
- host-local stopping/eviction on both shared and dedicated hosts

### 4. Operational Hardening

- packaging
- deployment
- rollback
- host reconcile / host convergence
- operator auth and CLI usability
- real dogfood soak

### 5. Known Release Bugs

- all user-visible or operator-visible bugs discovered during current dogfood
  and canary work

The following scope is **not** in:

- broad new app/platform features
- large rehome feature completion
- deep new routing protocols unless forced by a measured blocker
- generalized private-network optimization across every topology
- advanced billing model expansion
- large new self-serve provider surface beyond the first supported path

## Hard Rules For Release Work

1. No new feature gets added to release scope unless it removes an explicit
   blocker already named here.
2. No architecture redesign gets added unless existing architecture is proven
   inadequate by measured evidence.
3. Bugs found in soak, canary, or dogfood that affect correctness or operator
   trust are release work, not side quests.
4. A feature that exists but is unreliable counts as unfinished.
5. “Almost done” does not count; each release workstream needs explicit exit
   criteria.

## Current Read

### What already looks good

- multibay routing is real
- stable-URL browser bootstrap is real
- hot-path control-plane throughput is promising
- membership/storage/egress/project-count policy work is mostly done
- host-local stopping/eviction is now implemented and live-validated

### What still looks risky

- correctness under churn
- deployment / upgrade / rollback reproducibility
- operator workflows that remain too environment-sensitive
- self-serve host polish and support boundaries
- release bugs discovered during real canaries
- soak confidence and test confidence

## Primary Release Workstreams

## A. Architecture Freeze And Release Invariants

Goal: freeze the first-release system boundaries so the team hardens instead of
expanding.

### Todo

- [ ] Write one short canonical release-invariants note that states:
  - split ingress stays
  - browser keeps one stable public URL
  - account home bay owns account/session authority
  - project owning bay owns project authority
  - project-host runtime traffic bypasses bays whenever possible
  - billing/purchases remain seed-owned for first release
- [ ] Remove or disable project API keys if they are not part of the release
      contract.
- [ ] Keep account API keys, but narrow the acceptable first-release scope
      model.
- [ ] Refuse new cross-bay mechanisms unless a measured blocker forces them.

### Exit Criteria

- one short invariants doc exists
- release work is being judged against it
- no major release-area ambiguity remains

## B. Multibay Correctness And State Convergence

Goal: make the current multibay architecture trustworthy under churn.

### Todo

- [ ] Finish stale-host propagation hardening.
- [ ] Ensure deleted / deprovisioned host state converges across bays.
- [ ] Make “VM gone but DB row still looks provisioned” heal automatically.
- [ ] Make cloud orphan detection and DB orphan detection explicit operator
      workflows.
- [ ] Finish trustworthy host search/filter by host id, IP, and similar
      identifiers.
- [ ] Ensure host card / drawer inspection paths refresh enough to be relied
      on.
- [ ] Audit any remaining assumptions that project bay and host bay are always
      identical.
- [ ] Confirm cross-bay project lookup, start, stop, and browser reconnect
      paths are stable after recent routing work.

### Exit Criteria

- stale/deleted host rows converge without manual DB surgery
- operator UI and CLI agree on host state
- multibay correctness bugs are no longer appearing in ordinary dogfooding

## C. Shared And Dedicated Host Resource Protection

Goal: ship the current limit model and host-local protection model as one
coherent release story.

### Todo

- [x] Validate host-local stopping / eviction on live hardware:
  - observe
  - pressure
  - startup protection
  - cooldown
  - emergency multi-stop
  - project-log surfacing
  - placement reaction
- [ ] Keep the remaining limit model surfaces coherent:
  - admin override controls
  - dedicated-host egress policy wiring
  - override explanation/audit visibility
- [ ] Ensure dedicated hosts use the same local host-protection model as
      shared hosts.
- [ ] Keep `always_running` and `idle_timeout` removed as product/runtime
      concepts, except for inert compatibility if needed internally.
- [ ] Decide whether managed-egress leased budgets are actually required before
      release.

### Exit Criteria

- membership/limits policy surfaces are coherent
- override model is explicit
- shared and dedicated hosts protect themselves predictably
- operator can explain why a project was stopped or spared

## D. Self-Serve Hosts

Goal: ship a narrow, explicit, supportable self-serve host story.

This workstream is in scope, but it must stay narrow.

### Included

- self-hosted cloud connector path
- pairing/auth/revocation
- minimal supported provider/backend path
- clear local install/service story
- clear release documentation on what is supported

### Excluded

- broad backend/provider matrix expansion
- advanced local networking modes beyond what is required
- new GPU/self-host feature expansion unless already required by scope

### Todo

- [ ] Choose and document the exact first supported self-serve host modes.
- [ ] Finish connector pairing and token lifecycle hardening.
- [ ] Finish connector install/distribution flow.
- [ ] Make connector lifecycle idempotent and auditable.
- [ ] Verify self-serve host create/start/stop/delete/status flows on clean
      machines.
- [ ] Verify project-host auth and subject authorization are production-safe
      enough for self-serve use.
- [ ] Decide the exact release story for Cloudflare vs local/self-host tunnel
      modes.
- [ ] Document explicit support boundaries:
  - supported OS
  - supported virtualization/runtime backend
  - supported networking assumptions
  - what is not supported yet
- [ ] Ensure release docs explain that this is a narrow first release, not a
      general arbitrary local cloud platform.

### Exit Criteria

- one self-serve host path works end to end on clean machines
- auth/token lifecycle is trustworthy
- support boundaries are documented and narrow
- operators are not relying on ad hoc tribal knowledge to assist users

## E. Deployment, Packaging, Upgrade, And Rollback

Goal: make deployment boring enough to run.

### Todo

- [ ] Finish the bay packaging flow under `src/packages/rocket`.
- [ ] Define one standard deploy artifact.
- [ ] Define one standard deploy command path.
- [ ] Verify packaged bay runtime on a clean VM without local-dev assumptions.
- [ ] Finish the project-host daemon upgrade / rollback path enough for public
      release.
- [ ] Ensure host reconcile behavior is predictable and inspectable.
- [ ] Document rollback workflows for:
  - bay software
  - project-host software
  - project bundle/tools drift
- [ ] Define the minimum supported bay host environment.

### Exit Criteria

- release deploy is reproducible
- rollback is explicit and tested
- host software lifecycle is not a manual-SSH adventure

## F. Operator Auth, CLI, And Observability

Goal: make operator workflows safe and not context-fragile.

### Todo

- [ ] Make benchmark/auth behavior deterministic even in env-heavy shells.
- [ ] Eliminate ambient auth target confusion caused by `CONAT_SERVER`, bearer,
      or project-secret env.
- [ ] Define the supported operator credential story for release.
- [ ] Make `cocalc-cli` operator commands reliable without hidden local
      context.
- [ ] Add structured logs for critical host/project auth failures and deny
      reasons.
- [ ] Add minimum required production observability:
  - message rates
  - event-loop delay
  - per-worker CPU
  - Postgres pressure
  - routing latency
  - host reconciliation lag
- [ ] Add/export control-plane traffic stats in frontend session tooling.

### Exit Criteria

- operator workflows are predictable
- auth confusion is not a recurring bug source
- release operation has a minimum viable observability story

## G. Real Soak And Capacity Evidence

Goal: replace hope with measured confidence.

### Todo

- [ ] Keep one real 3-bay dogfood cluster running for an extended soak window.
- [ ] Exercise:
  - restarts
  - host churn
  - invites/collaboration
  - browser reconnects
  - notebook
  - terminal
  - app-server flows
  - admin operations
  - self-serve host workflows
- [ ] Fix every correctness bug found during soak before release.
- [ ] Rerun synthetic/loadgen benchmarks with the now-current architecture.
- [ ] Sample real user traffic and compare it to synthetic benchmark capacity.
- [ ] Write a conservative bay-sizing story for release.
- [ ] Capture a short “known operational hazards” list from soak.

### Exit Criteria

- meaningful soak completed
- no scary unresolved correctness bugs remain
- conservative capacity estimate is written down

## H. Known Bug Scrub

Goal: treat all known release-relevant bugs as first-class release work.

This list should stay aggressively pruned and explicit.

### Current Known Bugs / Defects

- [ ] New projects on `lite4b` can fail runtime bootstrap because `apt-get`
      cannot locate `sudo`.
- [ ] ACP worker supervisor still emits `EACCES` on
      `/mnt/cocalc/data/logs/acp-worker.log`.
- [ ] Duplicate/stale `project_hosts` rows can remain in the registry and harm
      operator trust.
- [ ] `cocalc project log` CLI handling for stopped projects is not reliable
      enough; the log stream itself works, but the operator-facing path is
      confusing.
- [ ] Any remaining stale host / stale bundle reconcile bugs discovered during
      canaries or soak.
- [ ] Any self-serve host pairing/auth/install bugs discovered during real
      trials.

### Bug Policy

- [ ] Every bug found during soak or canary gets classified:
  - release blocker
  - must fix before wider dogfood
  - post-release
- [ ] User-visible correctness bugs default to release blockers.
- [ ] Operator-trust bugs default to release blockers.
- [ ] Release bug backlog must trend toward zero, not sideways.

### Exit Criteria

- every known release-relevant bug is either fixed or consciously deferred with
  rationale
- no hand-wavy “we’ll probably be fine” bugs remain

## Release Sequence

This is the recommended order of work.

### Phase 0. Scope Freeze

- [ ] Publish this release plan as the working denominator.
- [ ] Refuse new scope expansion unless it removes a named blocker.

### Phase 1. Finish Core Blockers Already In Flight

- [ ] close remaining admin override / dedicated-host egress work
- [ ] finish deployment/packaging path
- [ ] finish multibay stale-state convergence work

### Phase 2. Self-Serve Host Narrow MVP

- [ ] finish pairing/auth/install path
- [ ] validate create/start/stop/delete/status
- [ ] document support boundary

### Phase 3. Known Bug Burn-Down

- [ ] fix the currently known live bugs
- [ ] keep bug list current from dogfood and canary work

### Phase 4. Test And Soak

- [ ] green authoritative test surface
- [ ] run 3-bay soak
- [ ] run self-serve host soak
- [ ] fix what breaks

### Phase 5. Capacity And Launch Readiness

- [ ] rerun benchmarks
- [ ] capture real traffic samples
- [ ] write conservative sizing story
- [ ] finalize operator playbooks

### Phase 6. Release Decision

- [ ] check exit criteria below
- [ ] decide:
  - limited public release
  - broadened dogfood only
  - no-go pending named blockers

## Exit Criteria For First Public Release

The product is ready for first public release when all of the following are
true:

- [ ] important multibay correctness tests are green
- [ ] dogfood multibay cluster has survived a meaningful soak
- [ ] self-serve host MVP path works end to end on supported environments
- [ ] deployment and rollback are reproducible
- [ ] host/cloud reconciliation is trustworthy enough for operators
- [ ] purchases/billing authority is explicitly bounded where intended
- [ ] operator auth and CLI flows are safe enough to use
- [ ] resource protection and limits behave as designed
- [ ] all known release-relevant bugs are fixed or explicitly deferred
- [ ] conservative capacity and bay-sizing story is written down
- [ ] release scope has not silently expanded beyond this document

## Explicitly Deferred Until After First Public Release

- finished account rehome
- finished project rehome
- broader provider/backend expansion for self-serve hosts
- generalized LAN/private-network optimization across every dev topology
- deep new router protocol work beyond measured necessity
- million-user proof campaigns
- major new platform features unrelated to current blockers

## Immediate Next Block

If we want the shortest path to release from today, do these next:

- [ ] fix the current known live bugs from the `lite4b` canary
- [ ] finish central admin override controls
- [ ] finish dedicated-host egress policy wiring
- [ ] finish packaging/deploy/rollback path
- [ ] validate one supported self-serve host path end to end
- [ ] run a real 3-bay soak and fix what it finds
- [ ] rerun capacity benchmarks and write the conservative sizing note

That is the highest-value path to a real first public release without
expanding scope.
