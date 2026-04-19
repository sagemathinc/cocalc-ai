# Project-Host Runtime Upgrade And Rollback Plan

Status: substantially implemented; this document is now primarily the
remaining-work plan and architecture reference

Goal: evolve the current imperative host software upgrade and managed-component
rollout work into a fully production-ready runtime lifecycle system for Linux
project hosts that is:

- safe by default
- rollback-friendly
- explicit about desired state
- usable from both the GUI and `cocalc-cli`
- reliable for online and offline hosts
- precise enough for agent automation

This plan starts from the code and workflows that already exist today. It does
not assume a clean-room controller rewrite.

## Scope

This plan is for host-local runtime software on Linux project hosts.

Daemon components:

- `host-agent` (new low-churn host lifecycle controller)
- `project-host`
- `conat-router`
- `conat-persist`
- `acp-worker`

Runtime artifacts that also need first-class lifecycle management:

- `project bundle`
- `project tools`
- `bootstrap environment`

It is not a plan for:

- `cocalc-plus`
- general cluster orchestration
- replacing bootstrap/reconcile lifecycle work already captured in
  [bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md)
- replacing restart/session identity work already captured in
  [project-host-restart.md](/home/user/cocalc-ai/src/.agents/project-host-restart.md)

## Where We Are Now

This document started as a proposal. A substantial part of the base system now
exists, so the useful question is no longer "is this architecture plausible?"
but "which parts are finished, partial, or still missing?"

### Landed

1. Host-local safety-critical recovery is no longer just a design idea.
   - `host-agent` exists as the separate low-churn supervisor for the critical
     host-local daemons.
   - automatic `project-host` rollback now exists and is executed through that
     host-local control path instead of remaining only an ssh/manual recovery
     story.
2. Desired runtime deployment state exists in the hub.
   - global desired versions exist
   - host-scoped overrides exist
   - the effective target for a host can now differ from the cluster default
3. Managed-component status and rollout exist for the daemon components:
   - `project-host`
   - `conat-router`
   - `conat-persist`
   - `acp-worker`
4. The host software control surface is now broader than imperative
   `host upgrade`.
   - routed host rollout RPC/CLI exists
   - host-scoped desired state can be resumed back to the cluster default
   - the control plane can now explain some automatic rollback cases instead of
     only exposing stale failed upgrades
5. The GUI is no longer purely fire-and-forget.
   - `/hosts` has a runtime versions catalog
   - cluster default can be changed from the UI
   - per-host rollback pins are surfaced more explicitly
   - `Resume cluster default` exists in both UI and CLI
   - the host drawer/runtime view now exposes daemon components and health for
     `project-host`, `conat-router`, `conat-persist`, and `acp-worker`
   - the host drawer is now split into operational tabs instead of one long
     scroll surface
6. Artifact metadata/catalog work has started.
   - published runtime versions now carry operator-facing metadata such as
     build message
   - the `/hosts` runtime versions panel can show recent published versions and
     current fleet adoption
7. Running-project artifact reference tracking exists for bundle/tools.
   - deploy status exposes `referenced_versions` for `project bundle` and
     `project tools`
   - this is enough to make retention/rollback decisions data-driven later
8. Runtime rollback is no longer only implicit.
   - `cocalc host deploy rollback` exists
   - explicit CLI version selection via `--to-version` exists
   - rollback targets and retained versions are exposed in deploy status
   - `bootstrap-environment` rollback now follows the same desired-state path
     and applies via bootstrap reconcile over ssh
9. Host upgrade semantics now distinguish low-disruption `project-host`
   updates from explicit full-stack alignment.
   - ordinary `project-host` upgrade preserves the lower-disruption path
   - explicit `--align-runtime-stack` and drawer “upgrade all” paths exist for
     coordinated runtime alignment

### Partial / Still Missing

1. The plan document itself is stale.
   - several sections below still read like open proposals instead of current
     reality
2. Fleet-scale exception visibility is only partially landed.
   - hosts list and CLI now surface host overrides and recent automatic
     rollbacks
   - there is still no dedicated central table/filter for these exceptions in
     large fleets
3. Retained rollback inventory and pruning policy are still incomplete.
   - the system can now observe referenced bundle/tools versions
   - rollback targets now surface protected vs prune-candidate versions
   - live deploy status now includes retained/protected/prunable byte totals for
     runtime artifacts, so operators can reason about disk cost instead of only
     version counts
   - host-side bundle/tools pruning now preserves versions referenced by
     running projects instead of treating every artifact as a blind keep-3
     cache
   - host-side `project-host` pruning now also preserves the host-agent's own
     rollback checkpoint versions instead of relying only on recency
   - host-side retention policy is now configurable by env and can use
     per-artifact byte budgets in addition to keep-count floors
   - control-plane software upgrades now send retention policy explicitly, and
     host runtime status surfaces the host's effective keep floor / byte budget
   - durable default retention policy now lives in `server_settings` instead of
     only fixed server-side constants, while host env vars remain last-mile
     overrides
   - admin settings now expose a guided wizard for editing runtime retention
     policy instead of requiring raw JSON editing only
   - the host drawer now renders rollback / protected / prunable versions with
     human-readable timestamps and published artifact messages when that
     metadata is available, instead of only raw opaque version strings
   - but local rollback inventory, retention policy, and rollback candidate
     surfacing are still not fully operator-friendly yet
4. Some desired-state semantics are still incomplete or only partially proven.
   - explicit `--align-runtime-stack` execution now converges the full managed
     runtime stack on live hosts and updates status coherently
   - hosts now retry automatic convergence on heartbeat after register-time
     `observation_failed` results, so reconnect timing is less brittle
   - single-host offline convergence has now been validated live, but broader
     adversarial coverage is still missing
   - component policy is not yet exposed as durable central control-plane state
5. LRO and CLI ergonomics still have gaps.
   - repeated deploy/upgrade requests still need more adversarial coverage for
     stale observed state and offline hosts

## Problem Statement

Today, host daemon lifecycle is still too imperative.

The operator and agent story is still roughly:

1. publish software somewhere
2. tell a host to upgrade artifacts
3. tell a host to roll out one or more components
4. watch whether it comes back
5. if it breaks badly, ssh in and fix it

That is not production-ready enough for a fast-moving control plane.

The target system should feel much closer to a small explicit deployment
controller:

- desired version is declared
- rollout policy is declared
- hosts converge
- health is watched
- rollback is explicit and cheap
- offline hosts catch up automatically later

## Hard Requirements

1. Human admins must be able to answer, for any host:
   - what version is desired?
   - what version is running?
   - what component is rolling out?
   - what is the last known good version?
   - what will happen if I click upgrade or rollback?
2. Agents must be able to perform the same actions through stable CLI/RPC
   surfaces without screen scraping or ssh.
3. `project-host` upgrade must have automatic rollback if the host fails to
   return to `ready_for_work` within a bounded window.
4. Rollback must be possible without downloading anything new from the network
   if the prior bundle is still retained locally.
5. Offline hosts must converge when they reconnect.
6. `acp-worker` rollout must remain policy-driven and not be conflated with
   health failure handling.
7. The system must preserve the current ability to do one-host canaries.
8. The same machinery must support:
   - one specific host
   - all online hosts
   - future global desired-state defaults
9. `project bundle` and `project tools` versions must remain available as long
   as any running or restorable project still references them.
10. Standard recovery must not depend on manually pre-arranged ssh trust.
11. The user impact of restarting or upgrading each component must be
    documented explicitly.
12. Standard recovery for `project-host` must not depend on `project-host`
    itself being healthy enough to execute its own rollback.

## Core Design Principles

### 1. Desired State, Not Just Actions

We should treat "upgrade daemon X to version Y" as state, not only as an LRO.

### 2. Component Policy Is Explicit

Every managed component must have an upgrade policy recorded centrally:

- `restart_now`
- `drain_then_replace`

Later policies can be added, but the first implementation should not hide them
inside ad hoc code.

### 3. Artifact And Component Are Related, But Not The Same

Right now all four daemon components run from the `project-host` artifact. That
is fine, but the control model must still separate:

- artifact version
- component rollout target

That keeps the system usable if router or persist later become separately
versioned artifacts.

The same distinction also matters today for:

- daemon components that all currently run from the `project-host` artifact
- `project bundle`
- `project tools`
- `bootstrap environment`

### 4. Health Recovery And Upgrade Are Different State Machines

The system must not use "component looks unhealthy" as a proxy for "upgrade
this component now". That coupling caused the ACP worker problems.

### 5. Rollback Must Be Normal

Rollback is not an ssh-only disaster recovery trick. It is a standard operator
workflow and must be visible in the same surfaces as upgrade.

### 6. Low-Level Staging And High-Level Deploy Are Different

The low-level operation that ensures an artifact is present on a host is not
the same as the high-level operation that changes what should run.

The current `host upgrade` command mostly performs staging plus some follow-up
action. The end-state UX should make that distinction explicit.

### 7. Multi-Bay Must Stay Mostly Invisible To Operators

Different project hosts may be owned by different bays, but the operator model
should remain "manage a host fleet", not "manually reason about bay-local
plumbing" for routine upgrades and rollback.

### 8. Separate System Control From Runtime Control

The node-local process that stages artifacts, supervises critical daemons, and
rolls back failed `project-host` upgrades should not itself be the same
high-churn `project-host` runtime daemon.

That control path should live in a separate low-churn process, even if the
first implementation is mostly a code move from the current `project-host`
package into a second Node.js process.

## Architectural Decision: Split A Stable Host Agent From `project-host`

We should explicitly separate the current node-local responsibilities into two
host processes:

- `host-agent`:
  a small stable lifecycle controller, likely versioned with or delivered by
  the bootstrap environment
- `project-host`:
  the higher-level runtime/control daemon that manages projects and other
  frequently changing host-local behavior

This is not a rejection of the hub-side design work already completed. The
existing desired-state, observed-state, rollout, rollback-target, and CLI/RPC
model remains useful almost unchanged. The main change is which host-local
process executes the safety-critical lifecycle work.

### Why Make This Split

`project-host` is likely to be:

- upgraded often
- unstable during active development
- closer to complex user/runtime behavior

The node-local safety controller is supposed to recover from exactly those
failures. If `project-host` is both the thing that breaks and the thing that
must save us, the recovery story remains structurally weak and keeps dragging
ssh back in as the only true escape hatch.

Separating the processes gives us:

- a smaller and lower-churn rollback controller
- a standard recovery path that can work even when ssh is unavailable or
  inconvenient
- a cleaner system-vs-userspace boundary
- less pressure to keep `project-host` artificially conservative just because
  it is currently the only recovery path

### Intended Responsibilities

#### `host-agent`

Own:

- artifact staging and local inventory
- current/desired selected version for host-local daemons and artifacts
- process start/stop/restart for:
  - `project-host`
  - `conat-router`
  - `conat-persist`
  - `acp-worker`
- health checks and readiness observation for those daemons
- automatic rollback and last-known-good tracking
- host-local deployment state file
- a minimal outbound control channel to the hub

Do not own:

- general project lifecycle
- high-level project runtime behavior
- complex host business logic that is not needed for safe recovery

#### `project-host`

Own:

- project lifecycle
- project runner integration
- higher-level runtime behavior for projects and host-local services
- operational features that are useful when the host is healthy, but are not
  part of the minimal safety-critical rollback path

### Upgrade Model After The Split

- `host-agent` is upgraded rarely and explicitly, probably together with the
  bootstrap environment
- `project-host` remains a high-churn runtime artifact
- automatic `project-host` rollback is executed by `host-agent`, not by
  `project-host`
- `conat-router`, `conat-persist`, and `acp-worker` can also migrate under
  `host-agent` supervision without changing the hub-side desired-state model

### What Stays The Same

The hub-side model we already built should stay substantially the same:

- desired runtime deployment state
- observed component and artifact state
- rollback targets and last-known-good tracking
- host-scoped and fleet-scoped CLI/RPC surfaces
- rollout policy semantics
- canary workflow

In other words, this is primarily a host-local execution-plane split, not a
control-plane rewrite.

### What Changes

The host-local code paths that currently live under `project-host` should move
behind `host-agent`:

- managed component status and rollout execution
- artifact selection/current-version switching
- daemon supervision
- automatic `project-host` rollback
- health-gated reconcile for host-local daemons

`project-host` may still proxy or expose host operations when healthy, but the
authoritative recovery path should no longer depend on it.

### Standard Path vs Emergency Path

After this split:

- the standard upgrade and rollback path should go through `host-agent`
- ssh becomes only an emergency path, not the normal control-plane assumption

This matters for environments where inbound ssh is unavailable, awkward, or
dependent on unstable addressing, even if full firewall-only support is still a
"nice to have" rather than a hard requirement.

## Target Operator Contract

This is the end-state behavior we want.

### Human/Admin Intent

The operator should be able to say:

- upgrade `project-host` to version `V` on all hosts
- upgrade `acp-worker` to version `V` on one host
- upgrade `project bundle` to version `V` for new project starts on one host
- upgrade `project tools` to version `V` on one host
- upgrade `bootstrap environment` to version `V` on one host
- canary `project-host` version `V` on `spot-utah`
- roll back `project-host` on one host to the last known good version
- restart `conat-persist` on one host without changing its version
- set `acp-worker` drain deadline to `12h`
- inspect which hosts are drifted, mixed, draining, or rolled back

### Agent Intent

An agent should be able to do the same with deterministic CLI output:

- resolve candidate version
- declare desired state
- wait for reconciliation
- inspect result
- trigger rollback if needed
- optionally issue a restart-only action without changing desired version

### Required End-State CLI Shape

These commands are illustrative, not final syntax:

```sh
cocalc host deploy set \
  --component project-host \
  --version 20260415T061257Z-c97e9c71486d \
  --all-online

cocalc host deploy set \
  --host spot-utah \
  --component acp-worker \
  --version 20260415T061257Z-c97e9c71486d \
  --policy drain_then_replace \
  --drain-deadline 12h

cocalc host deploy status --host spot-utah

cocalc host deploy rollback \
  --host spot-utah \
  --component project-host \
  --to previous

cocalc host deploy restart \
  --host spot-utah \
  --component conat-persist
```

The current `cocalc host upgrade` and `cocalc host rollout` commands can remain
as compatibility aliases or advanced subcommands, but they should no longer be
the primary operator mental model.

## Target Data Model

The control plane needs durable desired-state tables, not only LRO history.

### 1. Desired Daemon Deployment

At minimum:

- scope:
  - global default
  - host override
- default provisioning behavior:
  - newly provisioned hosts inherit the promoted global default for each
    component/artifact
  - this must be distinct from "newest published version"
- component
- artifact
- desired version
- rollout policy
- drain deadline / grace policy
- rollout reason
- requested by
- requested at

This needs to be broadened to a generic host runtime deployment model that also
covers:

- `project bundle`
- `project tools`
- `bootstrap environment`

### 2. Observed Host Component State

This extends the existing managed-component status:

- host id
- component
- desired version
- running versions
- runtime state
- version state
- rollout state:
  - idle
  - pending
  - reconciling
  - draining
  - rollback_pending
  - failed
- last healthy version
- last attempted version
- last failure reason
- last reconciliation timestamps

### 3. Retained Bundle Inventory

Per host and artifact:

- installed versions
- current version
- rollback candidates
- installed at
- last used at

### 4. Published Version Catalog

Operators and agents need a first-class version list with metadata.

At minimum:

- artifact
- version
- channel
- promotion state:
  - published but not promoted
  - promoted as the default for newly provisioned hosts
  - optionally promoted for narrower scopes such as canary bays or regions
- published at
- source:
  - owning hub
  - `software.cocalc.ai`
  - admin-configured external source
- git commit
- commit title
- optional release description
- sha256

This catalog must be queryable through CLI and GUI.

Critical rule:

- the highest/newest published version must not automatically become the
  default for new hosts
- operators need an explicit promotion step that marks which version a newly
  provisioned host should use for each artifact/component
- this is the desired-state equivalent of a Kubernetes Deployment template:
  scaling up or provisioning new replicas should use the promoted target, not
  merely the newest artifact present in the registry

### 5. Runtime Version References

For `project bundle` and `project tools`, the system must track which projects
currently reference which retained version.

At minimum:

- host id
- project id
- pinned project bundle version
- pinned tools version
- when the version was bound to the project

This is now partially implemented for running projects via
`referenced_versions` in host deploy status. The remaining work is to:

- consume those references in retention/rollback logic
- distinguish "running reference" from broader "restorable project still needs
  this artifact" cases
- make the reference model authoritative enough for pruning decisions

### 6. Artifact Provenance And Deployment Hints

We also need a way to answer:

- which deployable artifact contains this code?
- which component actually needs to be rolled out after a given change?

This is especially important because a package name is not the same thing as a
deployable runtime target. For example, host-side project startup code may live
in `@cocalc/project-runner`, but the code is shipped as part of the
`project-host` runtime artifact, not the `project bundle`.

Each published artifact should therefore expose build provenance metadata:

- artifact
- version
- git commit
- included workspace packages
- optional changed file list or source manifest
- primary runtime targets affected

This provenance should power operator and agent deploy hints such as:

- "this change requires `project-host` rollout"
- "this change requires staging a new `project bundle`"
- "this change affects both host and project-side artifacts"

## Required Host-Side Model

Each host needs a small local daemon deployment state file, separate from
bootstrap facts. After the architectural split above, this state should belong
to `host-agent`, not to `project-host`:

- desired versions known to the host
- last applied versions
- last known good versions
- in-progress rollout info
- rollback checkpoint info

This should align with the broader split-state bootstrap/reconcile model from
[bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md),
not fight it.

For `project bundle` and `project tools`, host-local state must also record:

- which versions are currently pinned by active projects
- which versions are safe to prune
- which version is the desired default for newly started projects

## Health Gates

Production-ready upgrade and rollback requires explicit gates.

### For `project-host`

Success means the host returns to:

- connected
- control-ready
- file-server-ready
- ready-for-work

This should reuse and extend the session/readiness direction in
[project-host-restart.md](/home/user/cocalc-ai/src/.agents/project-host-restart.md).

Rollback trigger:

- if the upgraded `project-host` does not recover to `ready_for_work` within a
  bounded timeout, mark rollout failed and revert to the last known good bundle
  automatically

### For `conat-router`

Success means:

- process alive
- health endpoint ready
- cluster membership converged enough for service

### For `conat-persist`

Success means:

- process alive
- health endpoint ready
- able to serve new client resolution and storage work

### For `acp-worker`

Success means:

- replacement worker exists
- rolling-capable workers are draining
- no duplicate worker-entrypoint pileup

Importantly, ACP success must not require all long-running turns to finish
before the rollout LRO can report that the replacement phase succeeded.

### For `project bundle`

Success means:

- the target version is staged on the host
- new project starts can use it
- running projects pinned to older versions continue working

### For `project tools`

Success means:

- the target version is staged on the host
- the selected activation policy is applied correctly
- existing projects do not silently lose required commands such as `open`

This implies that tools version binding must stop being an unsafe global swap.

### For `bootstrap environment`

Success means:

- the new bootstrap/reconcile environment is installed explicitly
- future reconcile actions use it
- ordinary `project-host` daemon upgrade does not implicitly and opaquely change
  bootstrap behavior

## Rollback Model

Rollback has to exist at three levels.

### 1. Explicit Manual Rollback

Operator or agent requests:

- rollback host `H` component `C` to:
  - `previous`
  - `last_known_good`
  - explicit retained version `V`

### 2. Automatic `project-host` Rollback

Special case because `project-host` carries the host control channel.

Flow:

1. record current bundle as rollback checkpoint
2. switch to new bundle
3. restart `project-host`
4. wait for hub-observed readiness
5. if readiness fails, `host-agent` reverts symlink/state to checkpoint
6. restart old bundle
7. mark rollout failed and rolled back

### 3. Deferred Offline Rollback/Recovery

If a host comes back with a bad current bundle or drifted components, the
controller must still know the desired and last-known-good targets so it can
recover without ssh.

## SSH Recovery Constraint

Current ssh-based fallback is not a reliable control-plane assumption because
seed/bay ssh keys are not yet guaranteed to be provisioned and trusted during
host creation.

The plan should therefore treat ssh in two layers:

### Standard Path

- no ssh required for normal upgrade or rollback
- standard recovery flows should go through `host-agent`, not through
  `project-host`

### Emergency Path

- if ssh fallback remains part of the recovery story, host provisioning must
  explicitly install and trust the bay/seed recovery key at bootstrap time
- this must be treated as a first-class provisioning requirement, not a manual
  post-hoc operator step

## Retention Policy

Current host-side bundle retention is too small.

Production target:

- retain at least `10` recent `project-host` bundle versions by default
- allow per-artifact retention tuning
- never prune:
  - current
  - last known good
- rollback target for any in-progress rollout

Additional retention rules:

- do not prune any `project bundle` version that any project still references
- do not prune any `project tools` version that any project still references
- allow rollback to any published version even if it is not currently staged on
  the host by restaging it first
- do not assume `/opt` is an acceptable long-term retention root:
  - today both `project-host` bundles and `project bundle` versions are stored
    extracted under `/opt`
  - that uses root-disk space, not the larger deduped/compressed btrfs volume
  - extracted trees are materially larger than the compressed bundle artifacts
  - this is not the immediate optimization target, but later retention and GC
    work must become storage-budget-aware and may need to move retained
    versions onto btrfs-backed storage

This is a prerequisite for trustworthy rollback.

## Rollout Strategy By Component

### `project-host`

- default policy: `restart_now`
- rollout scope:
  - one host
  - all online hosts
  - future global desired default
- automatic rollback required

### `conat-router`

- default policy: `restart_now`
- version-homogeneous per host
- if router and clients must remain in one wire-compatible set, rollout must be
  treated as an explicit disruptive event

### `conat-persist`

- default policy: `restart_now`
- version-homogeneous per host
- should not roll automatically just because `project-host` rolled

### `acp-worker`

- default policy: `drain_then_replace`
- long configurable drain window
- explicit separation between:
  - health repair
  - desired-version rollout
- support explicit force-replace / kill-now policy for emergency security or
  corruption scenarios
- if force-replaced, restart recovery behavior for interrupted turns must be
  clearly documented and tested

### `project bundle`

- default effect: changes what newly started or restarted projects use
- active projects pinned to older versions continue on those versions
- canary and rollback must operate without breaking projects already running on
  older retained versions

### `project tools`

- must stop behaving like an unsafe global current-symlink swap for active
  projects
- default effect should match `project bundle`: new or re-bound projects get
  the new version, older projects keep their pinned version
- retention must be reference-aware

### `bootstrap environment`

- explicit rare upgrade surface
- not implicitly coupled to normal `project-host` daemon rollout
- usually upgraded by explicit reconcile policy, not as a side effect

## Upgrade Fences

We should enforce one crucial safety rule:

- when `project-host` daemon itself is being upgraded, no other host-local
  runtime component or artifact should be upgraded concurrently on that same
  host

Reason:

- if the host started healthy and only `project-host` changed, then rollback to
  the previous `project-host` bundle has a high chance of restoring control
- if `project-host`, tools, bundle selection, or bootstrap environment all
  changed together, rollback confidence drops sharply

This should be encoded as rollout admission logic, not only operator guidance.

## User Impact Matrix

Each managed runtime target must have explicit expected impact documentation.

### `project-host`

- likely impact today:
  - control-plane interruption
  - possible browser reconnects
  - no running project container restart
- target after later ingress split:
  - minimal control-plane interruption

### `conat-router`

- likely impact:
  - websocket reconnects
  - brief collaboration/control-plane disruption
  - no project container restart

### `conat-persist`

- likely impact:
  - temporary persistence lag or failure
  - document open/save/changefeed disruption
  - no project container restart

### `acp-worker`

- drain rollout:
  - existing turns continue
  - new worker handles future work
- force rollout:
  - active turns may be interrupted
  - automatic resume expectations must be documented

### `project bundle`

- affects newly started or restarted projects
- must not silently mutate already running projects pinned to older versions

### `project tools`

- must not cause commands like `open` to vanish from already running projects
- desired impact should be limited to newly started or explicitly re-bound
  projects

### `bootstrap environment`

- should not directly impact active users
- affects future reconcile, repair, and provisioning behavior

## Restart-Only And Smoke Testing

We need restart-only support independently of version change.

Required capability:

- restart one component on one host without changing desired version

Why:

- troubleshooting
- validating component recovery behavior
- smoke testing after deploy

We also need a smoke test that, on a canary host:

1. restarts each component one by one
2. verifies host readiness afterward
3. verifies key user flows afterward

The smoke test should become invokable from CLI and usable by agents.

## Multi-Bay Control Plane Constraints

The plan must fit the bay architecture.

Required behavior:

- operators target hosts, not bays
- CLI resolves host ownership and routes to the correct bay transparently
- desired deployment state is stored in the owning bay's control plane
- cross-bay operator workflows remain one logical host-fleet workflow

This should feel operationally similar to one hub even when multiple bays own
different hosts.

## End-State UX Requirements

### GUI

The host details UI should expose:

- current desired daemon versions
- observed running versions
- canary/upgrade action
- rollback action
- rollout history
- last known good version
- whether the host is drifted or blocked

The current "upgrade project-host" button should eventually become a higher
level wrapper over:

1. make version available
2. set desired state
3. watch rollout
4. show rollback affordance

### CLI

CLI must remain first-class and machine-readable.

Required end-state traits:

- all actions scriptable
- `--json` support
- no hidden ssh requirement for standard rollback
- predictable error states
- `--wait` must stream intermediate progress and status updates for long-running
  operations instead of staying silent until the terminal result

The CLI should not be materially worse than the frontend for LRO visibility.
The frontend already surfaces useful rollout/progress state. The CLI should at
least expose:

- current phase
- recent progress messages
- whether the operation is queued, running, reconciling, draining, rolling
  back, or stuck
- the last known host/component status while waiting

### Agent-Friendly Requirements

The agent workflow should be:

1. inspect versions and status
2. set desired target
3. wait on rollout LRO
4. inspect post-rollout state
5. roll back if needed

This means CLI output and RPC schemas must expose:

- desired version
- current version
- last known good
- rollout state
- rollback result

## Migration Plan

This is the concrete path from the current implementation to the target system.

### Phase 0: Split The Host-Local Execution Plane

Purpose:

- stop making `project-host` responsible for its own safety-critical rollback
  and recovery

Work:

- introduce `host-agent` as a separate host-local Node.js process
- move lifecycle supervision for host-local daemons under `host-agent`
- move automatic `project-host` rollback execution under `host-agent`
- keep the existing hub-side desired-state and rollout model intact where
  possible
- keep ssh as emergency-only fallback during migration, not as the intended
  standard path

Exit criteria:

- `project-host` no longer has to be healthy in order for the host to roll
  back `project-host`
- the hub can still target the same desired-state and rollout APIs without
  major operator-visible semantic changes

### Phase 1: Freeze The Current Primitive Surface

Purpose:

- treat current `host upgrade` and `host rollout` as the low-level primitives
  they already are

Work:

- document them explicitly as:
  - artifact install primitive
  - component action primitive
- keep improving help text and RPC comments
- stop adding hidden restart behavior to unrelated upgrade paths

Exit criteria:

- there is exactly one clear path for:
  - install new artifact
  - roll out component

### Phase 2: Persist Desired Runtime Deployment State In The Hub

Purpose:

- move from imperative actions to declarative intent

Work:

- add hub tables for desired runtime deployment state
- support:
  - global default
  - host override
- add status queries that join desired vs observed state
- add explicit rollout policy fields
- cover:
  - daemon components
  - `project bundle`
  - `project tools`
  - `bootstrap environment`

Exit criteria:

- operators can ask "what should this host be running?" without inferring from
  LRO history

### Phase 3: Add Host-Side Reconciler For Runtime Components

Purpose:

- make online and offline hosts converge to desired state

Work:

- add a runtime deployment reconcile loop on the host
- on host connect / heartbeat / periodic reconcile:
  - compare desired vs observed
  - schedule the appropriate component action
- keep using existing component rollout implementations under the hood where
  they already exist
- add version-pinning and activation handling for:
  - `project bundle`
  - `project tools`
  - `bootstrap environment`

Exit criteria:

- an offline host that comes back automatically notices drift and converges

### Phase 4: Introduce Retained Artifact Inventory And Rollback Checkpoints

Purpose:

- make rollback cheap and reliable

Work:

- increase artifact retention
- record per-host retained artifact inventory
- add "last known good" tracking
- add explicit rollback checkpoint creation before `project-host` rollout
- enforce reference-aware retention for bundle/tools

Exit criteria:

- rollback target is available locally on normal hosts

### Phase 5: Implement Explicit Manual Rollback

Purpose:

- make rollback a standard operator action

Work:

- add rollback RPC/LRO
- add CLI and GUI affordances
- allow:
  - `previous`
  - `last_known_good`
  - explicit retained version

Exit criteria:

- normal rollback does not require ssh

### Phase 6: Implement Automatic `project-host` Rollback

Purpose:

- protect the host control channel

Work:

- define rollout timeout and readiness gates
- on failed `project-host` rollout:
  - mark failed
  - `host-agent` reverts current bundle link/state
  - `host-agent` restarts previous bundle
  - publish rollback result

Exit criteria:

- a broken `project-host` rollout self-recovers without manual ssh in the
  common case

### Phase 7: Promote Desired-State Upgrade UX

Purpose:

- make the system human and agent friendly

Work:

- add higher-level CLI:
  - set desired version
  - observe rollout
  - rollback
- update GUI upgrade button to use desired-state workflow
- keep old commands as lower-level compatibility tools where useful

Exit criteria:

- routine upgrades and rollbacks are performed through the same desired-state
  surface

### Phase 8: Canary And Fleet Workflow

Purpose:

- make production rollout disciplined

Work:

- first-class one-host canary workflow
- promote host override over global default
- add "promote canary to all" path
- add rollout summaries across online hosts

Exit criteria:

- upgrading one host, validating it, then rolling the fleet is the normal path

## Recommended Initial Command Semantics

We should preserve user muscle memory where possible.

### Keep

- `cocalc host upgrade`
- `cocalc host rollout`
- `cocalc host reconcile`
- `cocalc host versions`

### Landed Under `host deploy`

- `cocalc host deploy restart`
- `cocalc host deploy status`
- `cocalc host deploy set`
- `cocalc host deploy rollback`
- `cocalc host deploy resume-default`
- `cocalc host deploy reconcile`

### Reframe

- `host upgrade`:
  keep as the routine operator path for artifact updates, especially the
  lower-disruption `project-host` flow
- `host rollout`:
  immediate advanced action primitive
- `host deploy set`:
  durable desired-state workflow
- `host deploy rollback`:
  durable rollback workflow using recorded rollback targets and retained
  versions

The earlier proposal to demote `host upgrade` into a thin compatibility alias
does not match current operational reality. We need both:

- a routine, low-disruption `host upgrade` workflow
- an explicit desired-state / rollback surface under `host deploy`

## Why We Are Not Using MicroK8s / K3s / Similar

This should be explicit because it is a reasonable question.

Short version:

- the project-host problem is not "we need generic container orchestration"
- the hidden complexity of single-node Kubernetes here is high
- it does not naturally solve our most important lifecycle problems

More concretely, a microk8s-style design would still require us to solve:

1. bootstrapping and upgrading the orchestrator itself on every host
2. packaging current host-local components as OCI images with access to:
   - `/mnt/cocalc`
   - host btrfs state
   - podman/runtime wrappers
   - host-local privileged helpers
3. modeling `project bundle` and `project tools` retention around active
   project references, which is not the same as generic container image rollout
4. preserving the direct visibility and debuggability we currently get from:
   - pid files
   - explicit logs
   - health endpoints
   - direct host process control
5. integrating bay-aware host control, canary rollout, and automatic rollback
   anyway

In other words, even with microk8s we would still need substantial custom
control-plane logic for:

- project-host readiness
- artifact staging
- pinned project bundle and tools versions
- rollback checkpoints
- host-specific recovery behavior

For the project-host runtime layer, a small explicit deployment controller is a
better fit than importing a general container orchestrator plus all of its
operational surface area.

## Extensibility Constraint

Today several code paths hardcode the current four daemon components. That is
acceptable for early slices, but the end-state implementation should use a
component/artifact registry rather than repeated hand-maintained lists.

The registry should define:

- component name
- artifact
- rollout policy options
- health checks
- restart command
- rollback semantics
- user-impact description

That keeps the system maintainable if we add more host-local components later.

## Clearly Out Of Scope

This plan is not for:

- upgrading software inside a running project container
  - `apt-get update`
  - `apt-get upgrade`
- upgrading bay/hub software itself
  - Rocket / Kubernetes clusters
  - Launchpad on a laptop
- upgrading Ubuntu on the project host machine
- upgrading `cocalc-plus`

## Success Criteria

This plan is complete when all of the following are true:

1. A host can be upgraded or rolled back without ssh in the common case.
2. `project-host` automatically rolls back after a failed upgrade that loses
   readiness.
3. Offline hosts converge after reconnect.
4. Human admins and agents both use stable CLI/RPC flows.
5. One-host canaries and fleet promotion are routine.
6. `acp-worker` rollout uses explicit drain policy instead of hidden
   same-bundle convergence.
7. Router and persist are no longer incidentally restarted by normal
   `project-host` upgrades.
8. Operators can inspect desired vs observed state and last known good version
   directly.
9. `project bundle`, `project tools`, and `bootstrap environment` use the same
   operator mental model.
10. Restart-only actions and smoke tests exist.
11. Version listing includes published metadata and source information.

## Immediate Next Steps

The next implementation priorities are now narrower and more operational:

1. finish rollback inventory and retention policy
   - make retained local versions easier to inspect and reason about
   - turn raw retained/reference data into clearer rollback and pruning UX
   - tighten host-side pruning policy beyond the first reference-aware safety
     slice
2. add more adversarial convergence coverage
   - repeated `--align-runtime-stack` requests
   - stale observed state
   - offline host reconnect and delayed observation paths
3. add smoke-test coverage for restart-only and canary workflows
   - restart each managed component
   - verify host readiness
   - verify a small set of user-facing flows afterward
4. continue operator tooling around host-scoped maintenance LROs
   - explicit `projects-backup`
   - host-scoped batch stop/restart of projects where operationally useful

## Near-Term Operator Batch Controls

In parallel with the software deploy/rollback work, the control plane should
gain first-class host-scoped batch project operations for emergencies and load
simulation:

- stop all matching projects on one host
- restart all matching projects on one host

These should be implemented as server-side LROs, not CLI loops over per-project
commands, so they survive operator disconnects and produce durable progress and
results.

Required semantics:

- snapshot the exact project target set when the operation starts
- support coarse filters such as `running` plus exact raw-status filters
- default `stop` target set: running and starting projects
- default `restart` target set: running projects
- return per-project succeeded / failed / skipped results
- stream useful progress during CLI `--wait`

Once the single-host semantics are proven, fleet-wide `--all-hosts` variants
can be added on top of the same primitive.

Another near-term operator command should be:

- `cocalc host projects-backup <host>`

This should expose the backup phase of `host drain` as a standalone host-scoped
LRO for peace-of-mind checks, pre-maintenance workflows, and backup throughput
tuning.

Required semantics:

- scan every project assigned to the host at operation start
- select every project whose latest backup is older than its `last_edited`
  timestamp
- back up the selected projects in parallel, without stopping them
- treat the freshness guarantee as:
  `backup_time >= min(command_start_time, last_edited)`
- continue after per-project failures instead of aborting the whole operation
- return the full failed project id list in the final result
- expose `--parallel` and `--wait`

This is intentionally weaker than a fully quiesced backup barrier, because
projects continue running during the operation. The value is operational: an
admin can quickly reduce the known data-loss window on one host and see which
projects, if any, still failed to back up.
