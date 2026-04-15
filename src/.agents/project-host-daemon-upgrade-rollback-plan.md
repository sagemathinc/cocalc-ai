# Project-Host Daemon Upgrade And Rollback Plan

Status: proposed implementation plan

Goal: evolve the current imperative host software upgrade and managed-component
rollout work into a fully production-ready daemon lifecycle system for Linux
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

This plan is for project-host runtime daemons on Linux project hosts:

- `project-host`
- `conat-router`
- `conat-persist`
- `acp-worker`

It is not a plan for:

- `cocalc-plus`
- general cluster orchestration
- replacing bootstrap/reconcile lifecycle work already captured in
  [bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md)
- replacing restart/session identity work already captured in
  [project-host-restart.md](/home/user/cocalc-ai/src/.agents/project-host-restart.md)

## Where We Are Now

The current implementation already has useful building blocks.

### Implemented

1. Host software artifacts can be upgraded through the hub control plane:
   - `cocalc host upgrade ...`
   - [host.ts](/home/user/cocalc-ai/src/packages/cli/src/bin/commands/host.ts)
   - [hosts.ts](/home/user/cocalc-ai/src/packages/server/conat/api/hosts.ts)
   - [upgrade.ts](/home/user/cocalc-ai/src/packages/project-host/upgrade.ts)
2. `project-host` bundle install and `project-host` restart are now separated.
   - host artifact install can happen without immediate self-restart
   - server-side upgrade path can explicitly roll out `project-host` afterward
3. Managed-component status exists:
   - [managed-components.ts](/home/user/cocalc-ai/src/packages/project-host/managed-components.ts)
4. Managed-component rollout exists:
   - [managed-component-rollout.ts](/home/user/cocalc-ai/src/packages/project-host/managed-component-rollout.ts)
   - `project-host`
   - `conat-router`
   - `conat-persist`
   - `acp-worker`
5. A routed host-control RPC and CLI exist:
   - `cocalc host rollout <host> --component ...`
6. Bootstrap/reconcile already exists as the broader host software lifecycle:
   - [bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md)

### Not Yet Implemented

1. There is no persisted desired daemon version state in the hub.
2. There is no per-host override vs global default desired state model.
3. Offline hosts do not automatically converge to new daemon versions when they
   come back unless an operator manually upgrades them later.
4. There is no first-class rollback command.
5. There is no automatic rollback for `project-host` if control-plane health
   disappears after an upgrade.
6. Bundle retention is too small for safe rollback workflows.
7. The GUI still presents upgrade mainly as a fire-and-forget imperative action
   instead of a desired-state workflow with explicit policy and rollback.
8. Component policy exists conceptually, but not yet as durable control-plane
   state:
   - `project-host`: restart now
   - `conat-router`: restart now
   - `conat-persist`: restart now
   - `acp-worker`: drain then replace
9. Current rollout is still fundamentally "act now on whatever is installed on
   this host", not "make this host converge to the declared target state".

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

### 4. Health Recovery And Upgrade Are Different State Machines

The system must not use "component looks unhealthy" as a proxy for "upgrade
this component now". That coupling caused the ACP worker problems.

### 5. Rollback Must Be Normal

Rollback is not an ssh-only disaster recovery trick. It is a standard operator
workflow and must be visible in the same surfaces as upgrade.

## Target Operator Contract

This is the end-state behavior we want.

### Human/Admin Intent

The operator should be able to say:

- upgrade `project-host` to version `V` on all hosts
- upgrade `acp-worker` to version `V` on one host
- canary `project-host` version `V` on `spot-utah`
- roll back `project-host` on one host to the last known good version
- set `acp-worker` drain deadline to `12h`
- inspect which hosts are drifted, mixed, draining, or rolled back

### Agent Intent

An agent should be able to do the same with deterministic CLI output:

- resolve candidate version
- declare desired state
- wait for reconciliation
- inspect result
- trigger rollback if needed

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
```

The current `cocalc host upgrade` and `cocalc host rollout` commands can remain
as ergonomic aliases or lower-level subcommands, but they should no longer be
the only mental model.

## Target Data Model

The control plane needs durable desired-state tables, not only LRO history.

### 1. Desired Daemon Deployment

At minimum:

- scope:
  - global default
  - host override
- component
- artifact
- desired version
- rollout policy
- drain deadline / grace policy
- rollout reason
- requested by
- requested at

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

## Required Host-Side Model

Each host needs a small local daemon deployment state file, separate from
bootstrap facts:

- desired versions known to the host
- last applied versions
- last known good versions
- in-progress rollout info
- rollback checkpoint info

This should align with the broader split-state bootstrap/reconcile model from
[bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md),
not fight it.

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
5. if readiness fails, revert symlink/state to checkpoint
6. restart old bundle
7. mark rollout failed and rolled back

### 3. Deferred Offline Rollback/Recovery

If a host comes back with a bad current bundle or drifted components, the
controller must still know the desired and last-known-good targets so it can
recover without ssh.

## Retention Policy

Current host-side bundle retention is too small.

Production target:

- retain at least `10` recent `project-host` bundle versions by default
- allow per-artifact retention tuning
- never prune:
  - current
  - last known good
  - rollback target for any in-progress rollout

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

### Phase 2: Persist Desired Component State In The Hub

Purpose:

- move from imperative actions to declarative intent

Work:

- add hub tables for desired daemon deployment state
- support:
  - global default
  - host override
- add status queries that join desired vs observed state
- add explicit rollout policy fields

Exit criteria:

- operators can ask "what should this host be running?" without inferring from
  LRO history

### Phase 3: Add Host-Side Reconciler For Daemon Components

Purpose:

- make online and offline hosts converge to desired state

Work:

- add a daemon deployment reconcile loop on the host
- on host connect / heartbeat / periodic reconcile:
  - compare desired vs observed
  - schedule the appropriate component action
- keep using existing component rollout implementations under the hood

Exit criteria:

- an offline host that comes back automatically notices drift and converges

### Phase 4: Introduce Retained Bundle Inventory And Rollback Checkpoints

Purpose:

- make rollback cheap and reliable

Work:

- increase bundle retention
- record per-host retained artifact inventory
- add "last known good" tracking
- add explicit rollback checkpoint creation before `project-host` rollout

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
  - revert current bundle link/state
  - restart previous bundle
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

### Add

- `cocalc host deploy status`
- `cocalc host deploy set`
- `cocalc host deploy rollback`
- `cocalc host deploy history`

### Reframe

- `host upgrade`:
  artifact install / publish / availability
- `host rollout`:
  immediate component action primitive
- `host deploy set`:
  durable desired-state workflow

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

## Immediate Next Steps

The first implementation slice after this plan should be:

1. add a durable desired daemon deployment data model in the hub
2. expose desired vs observed daemon deployment status in CLI and GUI
3. increase retained `project-host` bundle history and track last known good
4. then implement manual rollback before automatic rollback

That order matters:

- desired state first
- retained rollback target second
- manual rollback third
- automatic rollback fourth

Automatic rollback without the first three pieces will be fragile.
