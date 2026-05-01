# Deployment, Packaging, And Host-Convergence Hardening Plan

Status: focused execution plan as of 2026-05-01

This document narrows the release-critical "deployment / packaging / host
convergence" work into a concrete sequence.

It exists because the broader runtime deployment docs are now too general for
the actual failure modes we are hitting on `lite4b`.

The point of this plan is not to redesign host lifecycle again. The point is
to make the current model deterministic, inspectable, and boring enough that
the remaining release work can proceed without constant host-software drift
debugging.

Related documents:

- [first-public-release-master-plan-2026-04-30.md](/home/user/cocalc-ai/src/.agents/first-public-release-master-plan-2026-04-30.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)
- [bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md)
- [host-software-lifecycle-model-2026-05-01.md](/home/user/cocalc-ai/src/.agents/host-software-lifecycle-model-2026-05-01.md)

## Current Status Snapshot

As of 2026-05-01, these problem areas are materially improved:

- stale desired deployment state after deprovision/reprovision
- bootstrap-environment / wrapper convergence on existing hosts
- command naming and dev workflow split for hub/lite restart vs host rollout
- bootstrap env file atomicity and lifecycle locking
- attached-bay local postgres restart behavior
- project status reporting on hosts where libpod loses track of live conmon
  trees

The main remaining gaps are:

- one concise desired / installed / running / executor operator view
- more explicit reconcile ownership reporting
- adversarial canaries for reconnect/offline/rollback behavior
- root-causing the underlying libpod orphaning that the new reconcile fallback
  now masks safely

## Goal

Make host software rollout and convergence satisfy all of the following:

1. a freshly provisioned host boots to the intended software version
2. an existing host converges to the intended software version after upgrade or
   reconcile
3. deprovision/reprovision does not resurrect stale desired software state
4. wrapper/bootstrap-environment changes converge reliably on existing hosts
5. operators can inspect desired vs installed vs running state without ssh
6. local dev flows such as `pnpm hub:daemon:build` have deterministic effects
7. one-host and three-host canaries can be run without manual DB surgery

## Non-Goals

This plan is not for:

- broad cluster orchestration redesign
- replacing the current host-agent + bootstrap reconcile architecture
- changing the software artifact model beyond what is needed for correctness
- new dedicated-host product features

## Concrete Problems To Eliminate

These are the failures this plan must fix.

### 1. Stale desired deployment state survives too long

Observed failure:

- deprovision/reprovision of a host could keep chasing an old locally-built
  bundle version that no longer exists under `/software`
- bootstrap then failed with `404` while trying to download the historical
  version

Relevant code:

- [project-host-runtime-deployments.ts](/home/user/cocalc-ai/src/packages/database/postgres/project-host-runtime-deployments.ts)
- [hosts.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts.ts)
- [hosts-teardown.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-teardown.ts)
- [host-work.ts](/home/user/cocalc-ai/src/packages/server/cloud/host-work.ts)

### 2. Bootstrap-environment / wrapper updates do not converge predictably

Observed failure:

- a new bootstrap wrapper/schema version existed in the published bootstrap
  payload
- existing hosts still reported older desired bootstrap-environment state
- reconcile did not obviously roll them forward
- live canaries required manual wrapper patching on a host

Relevant code:

- [bootstrap.py](/home/user/cocalc-ai/src/packages/server/cloud/bootstrap/bootstrap.py)
- [bootstrap-host.ts](/home/user/cocalc-ai/src/packages/server/cloud/bootstrap-host.ts)
- [hosts-bootstrap-reconcile.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-bootstrap-reconcile.ts)
- [hosts-runtime-observation.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-observation.ts)
- [bootstrap-lifecycle.ts](/home/user/cocalc-ai/src/packages/project-host/bootstrap-lifecycle.ts)

### 3. Desired / installed / running state is too hard to explain

Observed failure:

- it is easy to know that "something is drifted" but not easy to tell:
  - what exact version is desired
  - what exact version is installed
  - what exact version is running
  - which reconcile path is responsible for repairing the mismatch
  - whether a failed reconcile actually changed anything

Relevant code:

- [hosts-runtime-observation.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-observation.ts)
- [hosts-runtime-deployment-status.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-status.ts)
- [host.ts](/home/user/cocalc-ai/src/packages/cli/src/bin/commands/host.ts)

### 4. Build/publish/restart/reconcile semantics are too implicit

Observed failure:

- `pnpm hub:daemon:build` is doing more than its name suggests
- operators have to remember whether a step rebuilt artifacts, restarted the
  hub, upgraded hosts, rolled managed components, or reconciled bootstrap
- debugging a failed live canary is slowed by ambiguity about which steps were
  actually run

Relevant code:

- [hub-daemon.sh](/home/user/cocalc-ai/src/scripts/dev/hub-daemon.sh)
- [hosts-software.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-software.ts)

### 5. Reconcile paths are split across too many layers

Observed failure:

- one repair path runs over host control
- another repair path runs over ssh bootstrap reconcile
- another path comes from host-agent rollback
- another path comes from automatic runtime deployment queueing
- the current model works, but it is not explicit enough about which layer owns
  which correction

Relevant code:

- [hosts-runtime-deployment-planning.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-planning.ts)
- [hosts-runtime-deployment-queue.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-queue.ts)
- [hosts-bootstrap-reconcile.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-bootstrap-reconcile.ts)
- [host-agent.ts](/home/user/cocalc-ai/src/packages/project-host/host-agent.ts)

## Required Invariants

The system is not done until these are true.

### 1. Single effective desired state per host

For every host and every managed target, there must be exactly one effective
desired version after applying:

- global desired deployment state
- host-scoped override state
- cluster-default resume behavior

No provisioning or reconcile path may use an inferred desired version that is
different from this effective state.

### 2. Bootstrap environment is first-class, not implicit

`bootstrap-environment` must be treated exactly like a real desired software
target:

- explicit desired version
- explicit observed installed/current version
- explicit reconcile path
- explicit drift status

### 3. Reconcile is idempotent and safe

Running host software reconcile twice in a row on a healthy host must produce:

- no harmful side effects
- no version regression
- no new drift
- no need for manual cleanup

### 4. Deprovisioned hosts do not keep stale software intent

A host that is fully torn down and reprovisioned must either:

- inherit the current global desired state, or
- inherit an intentional still-valid host override

It must never inherit accidental stale local dev version pins.

### 5. Operators can inspect the full state without ssh

For each host, the UI/CLI must show:

- desired version by target
- installed version(s)
- running version(s)
- drift classification
- last reconcile start / finish / result
- last rollback summary if any

## Workstreams

## A. Clarify The Runtime Model

Goal: reduce ambiguity before changing more code.

### Todo

- [x] Write a one-page canonical model note for host software lifecycle:
  - artifact
  - component
  - bootstrap-environment
  - desired state
  - observed state
  - reconcile
  - rollout
  - rollback
- [ ] Explicitly define which layer owns each target:
  - `bootstrap-environment`
  - `project-host` artifact
  - `project bundle`
  - `tools`
  - daemon components
- [ ] Explicitly define which executor owns each repair path:
  - host-control
  - bootstrap-over-ssh
  - host-agent rollback
  - automatic runtime deployment reconcile

### Exit Criteria

- one short canonical model exists
- code review can reject ambiguous lifecycle changes by referencing it

## B. Make Published Software Deterministic

Goal: make local and hosted software artifacts behave like a catalog, not like
opaque side effects.

### Todo

- [x] Audit and document exactly what `pnpm hub:daemon:build` does today.
- [x] Split or rename the workflow into explicit steps:
  - build artifacts
  - publish local software manifests
  - restart hub
  - upgrade hosts
  - reconcile hosts
- [ ] Make every published artifact manifest include:
  - version
  - build id if different
  - sha256
  - built_at
  - operator-facing message
- [ ] Ensure `bootstrap-environment` publishing follows the same explicit
      version contract as the other artifacts.
- [ ] Ensure local dev base-URL replacement does not change version identity.

### Relevant Modules

- [hub-daemon.sh](/home/user/cocalc-ai/src/scripts/dev/hub-daemon.sh)
- [hosts-software.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-software.ts)
- [bootstrap-host.ts](/home/user/cocalc-ai/src/packages/server/cloud/bootstrap-host.ts)

### Exit Criteria

- operators can say what exact version a build published
- build/restart/reconcile are explicit actions, not one overloaded verb

## C. Make Desired-State Lifecycle Deterministic

Goal: remove stale desired-state surprises.

### Todo

- [ ] Audit all places that mutate host runtime deployments
      (partially complete):
  - global desired state
  - host override
  - rollback pin
  - resume cluster default
  - deprovision / reprovision
- [x] Tighten deprovision semantics:
  - what is preserved intentionally
  - what must always be cleared
- [ ] Add tests for:
  - deprovision clears stale local dev pins
  - reprovision inherits current default
  - resume default removes host-only intent
  - rollback pin remains intentional and visible
- [ ] Add an explicit "effective desired state" helper used by:
  - observation
  - bootstrap generation
  - reconcile planning

### Relevant Modules

- [project-host-runtime-deployments.ts](/home/user/cocalc-ai/src/packages/database/postgres/project-host-runtime-deployments.ts)
- [hosts-runtime-deployment-planning.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-planning.ts)
- [host-work.ts](/home/user/cocalc-ai/src/packages/server/cloud/host-work.ts)

### Exit Criteria

- deprovision/reprovision cannot target a stale unpublished version
- every code path computes the same effective desired version

## D. Finish Bootstrap-Environment Convergence

Goal: wrapper and helper changes must converge on existing hosts without manual
patching.

### Todo

- [x] Treat runtime wrappers/helper scripts as owned artifacts under
      `bootstrap-environment`, not incidental files.
- [x] Verify bootstrap observation reports:
  - desired bootstrap version
  - installed bootstrap version
  - current bootstrap version
  - wrapper schema/version
- [x] Make bootstrap reconcile rewrite wrappers/helpers whenever the desired
      bootstrap-environment version changes.
- [x] Ensure every later boot runs real reconcile before trusting old wrapper
      state.
- [ ] Add adversarial tests (partially complete) for:
  - wrapper schema bump on existing host
  - reconcile after published bootstrap change
  - rollback to prior bootstrap-environment version
  - reboot after partial failed bootstrap reconcile

### Relevant Modules

- [bootstrap.py](/home/user/cocalc-ai/src/packages/server/cloud/bootstrap/bootstrap.py)
- [bootstrap-host.ts](/home/user/cocalc-ai/src/packages/server/cloud/bootstrap-host.ts)
- [hosts-bootstrap-reconcile.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-bootstrap-reconcile.ts)
- [bootstrap-lifecycle.ts](/home/user/cocalc-ai/src/packages/project-host/bootstrap-lifecycle.ts)

### Exit Criteria

- changing a wrapper/bootstrap schema version converges on existing hosts
- bootstrap status makes the result obvious from UI/CLI alone

## E. Unify Reconcile Ownership

Goal: keep the current layered repair model, but make ownership explicit and
non-overlapping.

### Todo

- [ ] Define when runtime deployment reconcile should use:
  - host-control component/action path
  - bootstrap-over-ssh path
  - host-agent rollback path
- [ ] Remove accidental overlap where two layers can race to "fix" the same
      drift differently.
- [ ] Ensure queue planning and execution emit explicit decisions:
  - no reconcile needed
  - online host-control reconcile
  - bootstrap-over-ssh reconcile
  - rollback
- [ ] Add LRO/result detail that names the executor path chosen.

### Relevant Modules

- [hosts-runtime-deployment-planning.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-planning.ts)
- [hosts-runtime-deployment-queue.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-deployment-queue.ts)
- [hosts-bootstrap-reconcile.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-bootstrap-reconcile.ts)
- [host-agent.ts](/home/user/cocalc-ai/src/packages/project-host/host-agent.ts)

### Exit Criteria

- every reconcile/rollback outcome names the executor path
- there is no ambiguity about which layer repairs which drift

## F. Improve Operator Surfaces

Goal: make drift and repair inspectable enough that live canaries stop being
guesswork.

### Todo

- [ ] Add one concise CLI view for a host showing:
  - desired version by target
  - installed versions
  - running versions
  - drift status
  - last reconcile result/timestamps
  - last rollback info
- [ ] Ensure the host drawer/runtime tab shows the same fields.
- [ ] Surface "why drifted" instead of only "drifted".
- [ ] Make bootstrap lifecycle and runtime deployment observations easy to
      compare side by side.

### Relevant Modules

- [hosts-runtime-observation.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-runtime-observation.ts)
- [hosts-normalization.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts-normalization.ts)
- [host.ts](/home/user/cocalc-ai/src/packages/cli/src/bin/commands/host.ts)

### Exit Criteria

- most runtime drift debugging can be done without ssh
- one screenshot or CLI output can explain a host's lifecycle state

## G. Add Adversarial Tests And Live Canaries

Goal: stop rediscovering the same lifecycle bugs through manual dogfooding.

### Automated Coverage

- [ ] Unit tests for deployment planning and effective desired-state
      computation
- [x] Unit tests for deprovision/reprovision stale-state cleanup
- [ ] Unit tests for bootstrap-environment version changes
      (partially complete)
- [ ] Integration tests for:
  - upgrade project-host only
  - align runtime stack
  - bootstrap-environment reconcile
  - rollback after failed project-host startup

### Live Canary Matrix

- [ ] `host1` clean reprovision -> bootstrap -> ready
- [x] `host2` local bundle upgrade -> reconcile -> ready
- [x] `italy` bootstrap-environment version bump -> reconcile -> wrapper change
- [ ] offline host comes back and converges automatically
- [x] deprovisioned host does not request stale software on reprovision
- [ ] rollback path restores last known good `project-host`

### Exit Criteria

- the canary matrix can be rerun as a checklist
- failures point to a specific lifecycle layer, not a mystery

## Recommended Order

This is the shortest credible path.

### Phase 1. Establish Truth Surfaces

1. document the canonical lifecycle model
2. add effective desired-state helper(s)
3. add CLI/runtime inspection output for desired vs installed vs running

### Phase 2. Fix Bootstrap-Environment Convergence

1. make bootstrap-environment first-class in observation and reconcile
2. eliminate wrapper/helper drift on existing hosts
3. add tests for schema/version bumps

### Phase 3. Fix Dev Build And Publish Semantics

1. make `hub:daemon:build` explicit or split it
2. make local published software versions deterministic and inspectable
3. ensure dev artifacts and desired-state pins cannot silently diverge

### Phase 4. Harden Host Lifecycle Under Reprovision And Reconnect

1. complete stale desired-state cleanup paths
2. verify automatic convergence after reconnect
3. verify rollback and resume-default behavior

### Phase 5. Run Repeated Live Canaries

1. host reprovision canary
2. bootstrap bump canary
3. offline convergence canary
4. three-host cluster canary

## Concrete Acceptance Scenarios

The plan is done only when all of these are boring.

### Scenario 1. Fresh Host Provision

- create a new GCP host with extra ssh keys already present
- bootstrap succeeds
- host becomes `running` and `ready_for_work`
- desired/install/running versions all line up from CLI/UI

### Scenario 2. Local Dev Upgrade

- publish a new local `project-host` bundle
- run the documented upgrade flow
- host upgrades to that exact version
- no bootstrap wrapper drift remains afterward

### Scenario 3. Bootstrap-Environment Bump

- publish a new bootstrap-environment version with a wrapper/schema change
- existing hosts reconcile
- wrappers/helpers are rewritten
- bootstrap status reports the new version clearly

### Scenario 4. Deprovision / Reprovision

- deprovision a host with a prior local override
- reprovision it
- bootstrap targets the current intended version, not an unpublished old one

### Scenario 5. Offline Catch-Up

- take a host offline
- change desired versions while offline
- bring the host back
- it converges automatically without manual db or ssh surgery

### Scenario 6. Rollback

- publish a bad `project-host`
- host misses health deadline
- host-agent rollback restores the prior working version
- operator surfaces explain what happened

## Immediate Deliverables

If we want the fastest path to unblocking the rest of release work, do these
next:

- [x] write the canonical lifecycle model note
- [ ] add explicit desired/install/running/bootstrap version inspection output
- [x] make bootstrap-environment observation and reconcile fully coherent
- [x] split or rename `pnpm hub:daemon:build` into explicit stages
- [ ] run a host reprovision + bootstrap-version-bump live canary and keep
      iterating until no manual surgery is required

That is the point where region-move soak, dedicated-host work, and remaining
release hardening stop getting derailed by host lifecycle uncertainty.
