# Scalable Architecture Remaining Checklist

Status: active checklist as of 2026-04-20.

This is the current execution checklist for finishing the scalable control-plane
work after the recent multibay auth/bootstrap work and the large project-host
runtime/lifecycle cleanup.

It is intentionally narrower and more current than:

- [scalable-architecture-implementation-plan.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-implementation-plan.md)
- [phase-5-remaining-checklist-2026-04-13.md](/home/user/cocalc-ai/src/.agents/phase-5-remaining-checklist-2026-04-13.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)

## Current Assessment

The architecture is now well past the "does this basically work?" stage.

What is proven or substantially implemented:

- one-bay Rocket / Launchpad architecture is real enough to operate
- account home bay, project owning bay, and host bay can be different
- the browser can stay on one stable public URL while using a different
  account-home bay for the control-plane websocket/API
- wrong-bay auth recovery exists
- per-bay public DNS and seed-managed bay tunnel provisioning exist
- many major project-local runtime paths no longer hairpin through bays:
  - project log
  - touch
  - storage / disk usage
  - document activity / file-use
  - snapshot / backup reads
  - major CLI project operations
- 3-bay local development is automated and usable
- project-host runtime architecture is much stronger than before:
  - split daemon model exists
  - `host-agent` exists
  - automatic rollback exists
  - desired runtime state exists
  - align-runtime-stack exists
  - runtime retention / rollback inventory is much better surfaced
- the major project-host performance regression was found and fixed:
  - btrfs qgroups were the wrong mechanism
  - simpler quota mode is the intended direction
  - the sqlite locking issue affecting backend Codex turns was also fixed
- browser-to-project-host auth has been improved:
  - bay-minted token is now used to establish auth
  - project-host cookie auth carries reconnects afterward
  - this reduces bay load and removes a class of reconnect complexity
- spot-instance support now exists and materially improves the production cost
  story for project hosts

Recent 3-way fixture validation:

- on 2026-04-20, a bay-1-owned project running on a bay-1 spot project-host was
  validated from bay-2 collaborator accounts through the stable multibay control
  path
- validated CLI paths:
  - remote collaborator listing
  - invite projection and redeem from bay-2
  - snapshot listing
  - storage summary
  - remote stop, start, and restart with LRO completion
- validated browser smoke paths:
  - bay-2 home-bay impersonation finishes back on the stable site URL
  - stable URL can open the bay-1-owned project as the bay-2 collaborator
  - browser opens a direct project-host session on the bay-1 host
- backup listing from a bay-2 collaborator against the bay-1-owned fixture now
  succeeds; attached bays delegate backup repo config to the seed bay, and the
  bay-1 project row records the returned seed repo id
- manual backup creation from a non-owning bay now returns a waitable source-bay
  LRO and delegates execution to the owning bay's backup worker; validated from
  bay-2 against the bay-1-owned fixture after redeploying hubs
- on 2026-04-21, the browser matrix was replayed against the stable
  `lite4b.cocalc.ai` fixture with account home bay `bay-1`, project owning bay
  `bay-0`, and host execution on `host2`:
  - stable URL sign-in to the project passed
  - stable URL reconnect / network flap passed and stayed on the stable origin
  - browser lifecycle `start`, `restart`, `stop`, and final `start` passed
  - browser terminal attach passed after both start and restart
  - browser storage / snapshot / backup reads passed
  - browser invite redeem passed with cleanup
  - browser invite duplicate, revoke, already-collaborator, remove, and
    re-invite edge cases passed with cleanup
  - the reusable QA runner now prints lifecycle progress and bounds browser
    cleanup so long lifecycle runs are debuggable
- a fresh bay-2 sign-up replay was attempted on 2026-04-21 but the available
  registration token was exhausted; previous non-seed sign-up/sign-in
  validation remains the evidence for this item

What should still be treated as incomplete:

- complete remaining hot-path bay-hairpin audit
- inter-bay observability / replay / load-test readiness
- explicit completion of host placement and lifecycle validation under multibay
  failure modes
- 2FA / TOTP auth, which should be added later as a home-bay-owned auth layer
  and not as a project-host or cross-bay runtime concern
- account rehome workflow
- project move workflow

## Phase Summary

### Phases 0-4

Treat these as done enough for forward progress.

- foundations / measurement: done enough
- projection / routing groundwork: done enough
- one-bay Rocket / Launchpad mode: done enough

Open work here is mainly refinement, not phase-defining migration work.

### Phase 5: Inter-Bay Plumbing

Treat this as structurally advanced but not formally closed.

Core Phase 5 results that are now real:

- stable public URL + hidden account-home control-plane routing
- wrong-bay auth recovery
- seed-managed per-bay public endpoints
- explicit split between account/project ownership and host execution placement
- major remote collaborator and CLI plumbing

Phase 5 remaining work is now mostly:

- validation
- observability
- cleanup of leftover hidden one-bay assumptions

Auth note for later:

- 2FA should fit naturally into the stable-URL shell + home-bay auth-authority
  design
- TOTP secrets, backup codes, and challenge verification should be owned by the
  account home bay
- real session issuance should only happen after the home bay completes the
  second factor
- this should not change project-host routing or runtime placement logic

### Phase 6: Project Host Reachability And Placement

This phase moved forward substantially in the last few days.

The recent daemon/runtime work is not just "project-host polish". It is a real
piece of Phase 6 and of production-readiness in general.

Still, Phase 6 is not complete until:

- multibay start/stop/restart is validated in browser and CLI
- owning-bay vs host-bay failure behavior is validated
- host reachability and placement behavior is measured under load

### Phases 7-9

These remain future-facing:

- account rehome
- project move
- real multi-bay rollout / sizing guidance

Some groundwork exists, but the workflows do not.

## Exit Target For "Close Enough To Move On"

The scalable architecture should be considered ready to leave this phase of
work when:

- the browser-side multibay session/bootstrap model is validated enough that it
  no longer feels experimental
- project-host hot paths no longer depend on bays except for auth/routing
  metadata
- host runtime lifecycle is dependable enough for production-like operation
- inter-bay lag / replay / failure state is observable enough to operate
  safely
- there is a first believable multibay load story, not just architectural
  confidence

## What Remains

### 1. Close Browser Multibay Validation

- [x] replay the full browser-side multibay validation matrix against current
      code and current DNS/bootstrap behavior
- [x] validate sign-up for a non-seed home bay
- [x] validate sign-in for a non-seed home bay
- [x] validate invite / collaborator acceptance flow for a non-seed home bay
- [x] validate impersonation flow all the way back to the stable public URL
- [x] validate browser reconnect after network flap while staying on the stable
      public URL
- [x] confirm there are no remaining frontend bootstrap calls that still assume
      same-origin auth/session authority

Notes:

- the stable-URL + hidden-home-bay websocket trick appears to work in real
  testing and should now be treated as demonstrated
- invite projection/redeem has now been validated in both CLI and browser flows
- browser sign-in through the bay-2 home-bay impersonation retry path was
  validated and ended on `lite4b.cocalc.ai`, and browser project open reached
  the bay-1 project host
- the final sign-up replay could not create another user because the current
  registration token is exhausted; this is not a routing failure, but future
  QA should use disposable registration tokens so sign-up can be replayed
  without manual token management

### 2. Finish Remaining Runtime Bay-Hairpin Audit

The rule remains:

- interactive runtime traffic should be direct client -> project-host
- bays should provide auth, routing metadata, durable state, and orchestration

Remaining audit targets:

- [ ] terminal creation / attach / resize / stream paths
- [ ] notebook kernel / session / exec paths
- [ ] app-server interactive reads / status paths
- [ ] any remaining user-hot-path `hub.projects.*` runtime reads
- [ ] any remaining frontend code that can silently fall back to the default
      global Conat client instead of an explicit routed client

### 3. Finish Project-Host Runtime Productionization

This is the major new area that changed in the last few days.

- [ ] codify and document that qgroups are not part of the intended production
      quota path
- [ ] validate simple quota behavior under realistic host churn and snapshot
      load
- [x] fix project backup creation LRO routing when the caller bay is not the
      owning bay; the caller bay keeps the waitable source LRO while the owning
      bay queues and runs the actual backup
- [ ] validate sqlite persistence/concurrency under Codex-heavy workloads after
      the recent locking fixes
- [ ] validate daemon split behavior under adversarial conditions:
  - `project-host` restart
  - `conat-router` restart
  - `conat-persist` restart
  - `acp-worker` crash / restart
  - `host-agent` rollback path
- [ ] validate upgrade / rollback / resume-default flows on live hosts under
      actual background load
- [ ] validate daemon restart ordering and operator UX under partial runtime
      failure
- [ ] write down the intended production runtime layout explicitly:
  - which daemons are essential
  - which can degrade independently
  - which state is persistent vs disposable

### 4. Close Phase 6 Placement / Lifecycle Validation

- [x] validate 3-way `start`, `stop`, and `restart` in both browser and CLI
- [ ] validate behavior when the owning bay is healthy and the host bay is slow
- [ ] validate behavior when the host bay is healthy and the owning bay is slow
- [ ] validate behavior when the host bay is unreachable
- [x] validate LRO progress / errors across owning-bay and host-bay boundaries
- [ ] audit remaining assumptions that `project bay == host bay`
- [ ] measure host heartbeat / lifecycle traffic at realistic bay sizes

Notes:

- CLI remote `stop`, `start`, and `restart` were validated on 2026-04-20 with
  account home bay 2, project owning bay 1, and host bay 1
- browser lifecycle was replayed on 2026-04-21 with stable URL sign-in,
  `start`, terminal attach, `restart`, terminal attach, `stop`, and final
  `start`; it passed, but the full run is slow enough that the QA runner now
  emits lifecycle progress messages

### 5. Spot Instance Operational Readiness

Spot support is strategically important now and should be treated as first-class.

- [ ] document the intended spot-host lifecycle
- [ ] validate preemption / disappearance handling for spot-backed hosts
- [ ] validate project reassignment / recovery behavior when a spot host dies
- [ ] measure how much operator complexity spot instances actually add
- [ ] decide where spot is acceptable vs where on-demand is still required

### 6. Inter-Bay Observability And Replay

- [ ] expose operator-visible mapping for:
  - account -> home bay
  - project -> owning bay
  - host -> host bay
- [ ] expose inter-bay lag and backlog clearly enough to diagnose real issues
- [ ] expose replay state / stale directory state clearly enough to diagnose
      outages
- [ ] expose route-failure / stale-ownership / handoff errors in one place
- [ ] document fencing / replay behavior for:
  - ownership changes
  - host reassignment
  - future account rehome
  - future project move

### 7. Load-Test Readiness

The connection leak fix means future measurements should be much more
trustworthy than before. This is now high-value work.

- [ ] add repeatable N-bay load-test fixture setup on top of the current
      multibay dev harness
- [ ] create a canonical 3-bay load scenario:
  - many accounts on bay A
  - projects owned on bay B
  - hosts on bay C
- [ ] measure:
  - browser/bootstrap latency
  - project open latency
  - terminal/notebook latency
  - exec latency
  - inter-bay request volume
  - bay CPU / Postgres pressure
  - project-host daemon pressure
- [ ] specifically measure the impact of project-host cookie-based reconnect
      auth on bay traffic reduction
- [ ] write the first real sizing guidance for:
  - bays
  - project-hosts
  - spot vs on-demand mix

### 8. Account Rehome

This remains future work, but it is the next major workflow after Phase 5/6
close-out.

- [ ] account-write fencing
- [ ] home-state copy
- [ ] projection rebuild / copy
- [ ] directory update
- [ ] forced browser reconnection
- [ ] CLI workflow
- [ ] rollback / replay plan

### 9. Project Move

Also future work.

- [ ] project fence / quiesce
- [ ] data copy
- [ ] metadata transfer
- [ ] directory update
- [ ] projection convergence
- [ ] rollback / retry plan
- [ ] CLI workflow

## What Is No Longer A Priority Bottleneck

These should not distract the team unless they block one of the checklist items
above:

- abstract architecture debate about whether bays/project-host split is correct
- one-bay Launchpad cleanup for its own sake
- broad host daemon controller redesign beyond the current landed model
- polishing rare admin-only paths before load / lifecycle / validation work
- exotic public ingress ideas beyond the current stable-URL + per-bay endpoint
  model

## Recommended Next Order

1. Finish the remaining runtime bay-hairpin audit.
2. Finish project-host runtime productionization and explicit Phase 6
   lifecycle/placement validation.
3. Start real multibay load measurement now that the connection leak is fixed.
4. Only then move to account rehome and project move.
