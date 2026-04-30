# First Public Release Master Plan

Status: master release planning and execution tracker as of 2026-04-30.

This document is the single planning / todo document for the first public
release of `cocalc-ai`.

It is intentionally stricter than the surrounding design docs. The point is
not to capture every good idea. The point is to ship a coherent first release
without expanding scope.

This plan explicitly includes:

- multibay scalability and operational hardening
- rented dedicated cloud hosts
- project move between regions for data accessibility
- critical purchase and entitlement paths for first release
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
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)
- [project-host-auth.md](/home/user/cocalc-ai/src/.agents/project-host-auth.md)

## Release Definition

The first public release means:

1. a real multibay hosted CoCalc deployment that is trustworthy enough for
   public use
2. a narrow but real rented dedicated-host offering on managed GCP and Nebius
   infrastructure
3. a project move between regions path that keeps project data accessible even
   when a region has no active hosts
4. a pricing / limits / entitlement model that protects cost and supports real purchase paths
5. clear operator workflows for deployment, rollback, host lifecycle, and
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
- project move between regions with explicit backup-region cutover semantics

### 2. Rented Dedicated Hosts

- managed GCP and Nebius dedicated-host path only
- clear host configuration dialog with explicit pricing
- monthly billing/renewal path
- host-owner access control model for who may use a dedicated host
- clear supported environments and support boundaries

### 3. Resource Protection And Limits

- membership-driven compute priority
- per-project storage
- total account storage
- project count
- managed egress limits
- host-local stopping/eviction on both shared and dedicated hosts

### 4. Purchase Paths And Entitlements

- student pay for course access:
  - one-time payment
  - four-month duration
  - course/student-targeted special membership
- minimal site/domain license:
  - verified-domain based entitlement
  - baseline membership level applied automatically
  - simple site-admin configuration path

### 5. Operational Hardening

- packaging
- deployment
- rollback
- host reconcile / host convergence
- operator auth and CLI usability
- real dogfood soak

### 6. Known Release Bugs

- all user-visible or operator-visible bugs discovered during current dogfood
  and canary work

The following scope is **not** in:

- broad new app/platform features
- large rehome feature completion
- deep new routing protocols unless forced by a measured blocker
- generalized private-network optimization across every topology
- advanced billing model expansion beyond the named first-release purchase
  paths
- broad BYO-host or self-connected-machine product scope
- large provider/backend expansion beyond the first supported dedicated-host
  path

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
- region-move correctness and backup cutover semantics
- deployment / upgrade / rollback reproducibility
- operator workflows that remain too environment-sensitive
- dedicated-host pricing, billing, and access-control polish
- student pay and site/domain-license entitlement correctness
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
- [ ] Implement and validate move between regions as a first-class
      supported path:
  - restore from the old-region backup repo
  - take exactly one fresh backup in the destination region
  - flip the official backup region to the destination
  - purge the old-region snapshots after cutover
- [ ] Verify the accessibility case where a project's current backup region has
      no active hosts, and moving it to a region with hosts restores normal
      access.
- [ ] Document the user/operator-visible semantics for region moves:
  - expected downtime
  - what metadata changes
  - what snapshots are retained
  - who is allowed to initiate the move

### Exit Criteria

- stale/deleted host rows converge without manual DB surgery
- operator UI and CLI agree on host state
- multibay correctness bugs are no longer appearing in ordinary dogfooding
- one project can move between regions end to end with correct backup cutover
- the no-host-in-region accessibility story is real, not aspirational

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

## D. Rented Dedicated Hosts

Goal: ship a narrow, explicit, supportable rented dedicated-host product.

This workstream is in scope, but it must stay narrow.

### Included

- managed dedicated hosts provisioned by CoCalc on GCP and Nebius
- host configuration flow that clearly surfaces current monthly pricing
- monthly billing / renewal logic for dedicated hosts
- host-owner UI to control which users may use the host
- explicit release documentation on what is supported

### Excluded

- user-owned or user-connected machines joining the official cluster
- broad backend/provider matrix expansion
- advanced local/custom networking modes beyond what is required
- new GPU/host feature expansion unless already required by scope

### Todo

- [ ] Choose and document the exact first supported dedicated-host SKUs on GCP
      and Nebius.
  - must include spot instances on both GCP and Nebius
  - pricing semantics must account for dynamic spot pricing on GCP
- [ ] Make the dedicated-host configuration dialog clearly show monthly
      pricing before the user commits.
- [ ] Implement monthly billing / renewal / charge logic for rented dedicated
      hosts.
- [ ] Define the exact failure semantics for unpaid, expired, or failed-charge
      dedicated hosts.
- [ ] Implement host-owner UI to control which users may use a dedicated host.
- [ ] Verify dedicated-host create/start/stop/delete/status flows end to end.
- [ ] Verify dedicated-host auth and subject authorization are
      production-safe.
- [ ] Document explicit support boundaries:
  - supported providers
  - supported machine sizes / SKUs
  - supported regions if restricted
  - who can administer a rented host
  - who can be granted access to use a rented host
  - what is not supported yet
- [ ] Ensure release docs explain that this is a narrow first release, not a
      BYO-host or arbitrary user-managed cloud platform.

### Exit Criteria

- one supported dedicated-host path works end to end on supported providers
- pricing is visible and understandable before host creation
- monthly billing / renewal is trustworthy
- host-owner access control works
- support boundaries are documented and narrow
- operators are not relying on ad hoc tribal knowledge to assist users

## E. Purchase Paths And Entitlements

Goal: ship the minimum purchase and entitlement paths needed for real course
and campus adoption in the first release.

This workstream is in scope because it directly affects near-term revenue and
real migrations from `cocalc.com`.

### Included

- student pay:
  - one-time payment
  - four-month duration
  - special membership for students in courses
- minimal site/domain license:
  - verified email domain grants a baseline membership level
  - simple site-admin configuration path
- explicit entitlement computation and precedence with existing memberships and
  upgrades

### Excluded

- broad institutional billing/workflow expansion
- custom contract logic beyond the minimal domain-license path
- generalized coupon/promotions system
- complex multi-tier licensing hierarchies

### Todo

- [ ] Define the exact first-release student pay product:
  - eligibility rules
  - one-time price
  - four-month duration semantics
  - renewal/re-purchase behavior
  - how course association is determined
- [ ] Implement the student pay purchase flow and post-purchase entitlement
      grant.
- [ ] Ensure student pay entitlement expiry/revocation is automatic and
      inspectable.
- [ ] Define and implement the minimal site/domain-license data model:
  - verified domain
  - granted membership level
  - configuration actor / site admin
  - effective dates if needed
- [ ] Implement site-admin configuration UI/API for the minimal domain-license
      path.
- [ ] Wire verified-domain entitlement into user entitlement computation.
- [ ] Define and document entitlement precedence among:
  - direct memberships/upgrades
  - student pay
  - domain/site license
  - any other first-release entitlement sources
- [ ] Add auditability/explainability so operators can answer why a user has a
      given entitlement.

### Exit Criteria

- a student can pay once and receive the intended four-month course membership
- a verified-domain account automatically receives the configured baseline
  membership
- entitlement precedence is explicit and tested
- operators and site admins can understand and inspect why entitlements were
  granted

## F. Deployment, Packaging, Upgrade, And Rollback

Goal: make deployment boring enough to run.

### Todo

- [ ] Finish the bay packaging flow under `src/packages/rocket`.
- [ ] Define one standard deploy artifact.
- [ ] Define one standard deploy command path.
- [ ] Verify packaged bay runtime on a clean VM without local-dev assumptions.
- [ ] Harden project-host bootstrap for `copy.fail` / `CVE-2026-31431`
      before first public release.
  - reference: <https://copy.fail/>
  - add to host bootstrap:
    ```sh
    echo "install algif_aead /bin/false" > /etc/modprobe.d/disable-algif-aead.conf
    rmmod algif_aead 2>/dev/null || true
    ```
  - verify the mitigation is present on newly provisioned hosts
  - evaluate a container seccomp deny for `socket(AF_ALG, ...)` as defense in
    depth, but only after confirming it does not break supported workloads
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

## G. Operator Auth, CLI, And Observability

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

## H. Real Soak And Capacity Evidence

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
  - project move between regions
  - dedicated-host workflows
  - student pay
  - domain-license entitlement behavior
- [ ] Fix every correctness bug found during soak before release.
- [ ] Rerun synthetic/loadgen benchmarks with the now-current architecture.
- [ ] Sample real user traffic and compare it to synthetic benchmark capacity.
- [ ] Write a conservative bay-sizing story for release.
- [ ] Capture a short “known operational hazards” list from soak.

### Exit Criteria

- meaningful soak completed
- no scary unresolved correctness bugs remain
- conservative capacity estimate is written down

## I. Known Bug Scrub

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
- [ ] Any project region-move / backup-cutover bugs discovered during real
      trials.
- [ ] Any dedicated-host pricing, billing, access-control, or provisioning
      bugs discovered during real trials.
- [ ] Any student pay or domain-license entitlement bugs discovered during real
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
- [ ] finish project move between regions implementation

### Phase 2. Dedicated Host Narrow MVP

- [ ] finish pricing/configuration dialog
- [ ] finish monthly billing / renewal path
- [ ] finish host-owner access-control UI
- [ ] validate create/start/stop/delete/status
- [ ] document support boundary

### Phase 3. Purchase And Entitlement Paths

- [ ] implement student pay
- [ ] implement minimal site/domain license
- [ ] validate entitlement precedence and auditability

### Phase 4. Known Bug Burn-Down

- [ ] fix the currently known live bugs
- [ ] keep bug list current from dogfood and canary work

### Phase 5. Test And Soak

- [ ] green authoritative test surface
- [ ] run 3-bay soak
- [ ] run dedicated-host soak
- [ ] run project region-move soak
- [ ] run student pay / domain-license entitlement soak
- [ ] fix what breaks

### Phase 6. Capacity And Launch Readiness

- [ ] rerun benchmarks
- [ ] capture real traffic samples
- [ ] write conservative sizing story
- [ ] finalize operator playbooks

### Phase 7. Release Decision

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
- [ ] project move between regions works end to end with the intended backup
      cutover semantics
- [ ] dedicated-host MVP path works end to end on supported providers
- [ ] student pay works end to end with the intended four-month duration
- [ ] minimal domain-license entitlement works end to end for verified-domain
      users
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
- broader provider/backend expansion for dedicated rented hosts
- user-owned / BYO-host integration with the official cluster
- generalized LAN/private-network optimization across every dev topology
- deep new router protocol work beyond measured necessity
- million-user proof campaigns
- major new platform features unrelated to current blockers

## Immediate Next Block

If we want the shortest path to release from today, do these next:

- [ ] fix the current known live bugs from the `lite4b` canary
- [ ] finish central admin override controls
- [ ] finish dedicated-host egress policy wiring
- [ ] finish project move between regions
- [ ] implement student pay
- [ ] implement minimal site/domain license
- [ ] finish packaging/deploy/rollback path
- [ ] validate one supported rented dedicated-host path end to end
- [ ] run a real 3-bay soak and fix what it finds
- [ ] rerun capacity benchmarks and write the conservative sizing note

That is the highest-value path to a real first public release without
expanding scope.
