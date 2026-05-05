# Host Software Rollout State Machine

Status: proposed canonical rollout model as of 2026-05-05

This note defines the exact state machine for installing and activating host
software, with emphasis on `project-host` rollouts.

The point is to stop relying on implicit transitions spread across:

- hub LRO logic
- bootstrap reconcile
- host-control RPCs
- host-agent local rollback logic
- host UI summaries

Related documents:

- [host-software-lifecycle-model-2026-05-01.md](/home/user/cocalc-ai/src/.agents/host-software-lifecycle-model-2026-05-01.md)
- [deployment-host-convergence-hardening-plan-2026-05-01.md](/home/user/cocalc-ai/src/.agents/deployment-host-convergence-hardening-plan-2026-05-01.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)

## Why This Exists

Recent bugs came from two missing explicit transitions:

1. The control plane rolled desired state back after a stale observation, even
   though the new `project-host` bundle had already become last-known-good.
2. The host-agent knew how to accept a healthy candidate and how to roll it
   back, but did not explicitly restart a still-healthy old daemon onto the
   newly installed candidate.

Both failures happened because we had local logic for individual conditions, but
no single written rollout model.

## Comparison With Kubernetes Deployments

This model is intentionally not the same as a Kubernetes `Deployment`.

As of 2026-05-05, upstream Kubernetes `Deployment` rollout behavior is:

- create a new ReplicaSet / new Pods
- wait for the new Pods to become ready and available
- scale old Pods down as the new Pods come up
- mark stalled rollout via `Progressing=False` with
  `Reason=ProgressDeadlineExceeded`
- not automatically roll the `Deployment` back in core Kubernetes

Official references:

- https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- https://kubernetes.io/docs/tasks/run-application/update-deployment-rolling/

That is a materially different problem from our `project-host` rollout.

### Why Our Model Differs

Kubernetes usually has overlap between old and new capacity:

- old Pods can remain serving
- new Pods can come up beside them
- the controller can stop making progress without immediately killing the old
  serving path

Our `project-host` rollout is a singleton in-place daemon switch on one host:

- there is one active `project-host` process on one host-local control plane
- activation requires an explicit restart from old daemon to candidate
- there is no ReplicaSet-style parallel steady-state during activation
- a failed candidate needs immediate host-local recovery, not just a status
  condition

Because of that, our design must differ from Kubernetes in two important ways:

1. local automatic rollback must exist
   - this belongs to host-agent
   - otherwise a bad singleton handoff can strand the host
2. explicit activation state must exist
   - artifact installed is not equivalent to process switched
   - Kubernetes gets this distinction from ReplicaSet/Pod objects; we must make
     it explicit in our own state

### What We Should Borrow From Kubernetes

We should not copy Kubernetes rollout mechanics, but we should copy its
discipline around conditions and visibility.

Useful Kubernetes ideas:

- explicit status conditions instead of one generic `waiting`
- deadlines owned by the controller that is actually evaluating progress
- separation of desired state from observed state
- failure reported as a first-class condition, not inferred from side effects

That implies our host UI and LRO progress should expose condition-like facts
such as:

- `ArtifactInstalled`
- `ProjectHostProgressing`
- `ProjectHostAvailable`
- `ProjectHostDegraded`
- `ManagedComponentsMixed`
- `RolledBack`

This note keeps the rollout mechanics host-specific while borrowing the
operator-facing clarity that Kubernetes conditions provide.

## Top-Level Rule

A host software rollout is not one state machine.

It is three state machines with different owners:

1. artifact installation
2. `project-host` activation
3. managed component alignment

If these are merged into one blurry phase like `waiting`, operators will not be
able to tell what is actually wrong.

## Actors And Authority

### Hub / Control Plane

Owns:

- desired artifact version
- rollout initiation
- rollout deadline budgets
- LRO status and operator-facing progress

Does not own:

- deciding whether a candidate `project-host` process is locally healthy enough
  to promote

### bootstrap-over-ssh

Owns:

- privileged install/reconcile of bootstrap-owned assets
- artifact download/install on the host when bootstrap is the active executor
- full host restart of `project-host` under bootstrap control

### host-control RPC

Owns:

- online artifact installation
- direct managed-component rollout requests
- observation RPCs during rollout

### host-agent

Owns:

- local `project-host` candidate tracking
- restarting from old healthy daemon to candidate
- promoting candidate to last-known-good
- local rollback to previous version after health deadline expiry

This is the most important authority rule:

- only the host-agent should decide `project-host` local rollback after process
  activation begins

The hub may still trigger an explicit rollback operation, but it should not
invent a local rollback from partial stale observations if the host-agent is
still actively evaluating the candidate.

## Machine 1: Artifact Installation

Owner: hub request + bootstrap/host-control executor

Scope: on-disk payload only

States:

- `idle`
- `requested`
- `resolving`
- `downloading`
- `installing`
- `installed`
- `install_failed`

Transitions:

- `idle -> requested`
  - explicit host upgrade/reconcile requested
- `requested -> resolving`
  - executor begins work
- `resolving -> downloading`
  - artifact URL/version selected
- `downloading -> installing`
  - archive fetched and checksum verified
- `installing -> installed`
  - version dir extracted and `current` symlink updated
- `resolving|downloading|installing -> install_failed`
  - resolution/download/extract failure

Required persisted facts:

- `desired_version`
- `installed_version`
- `installed_versions`
- `last_install_error`
- `installed_recorded_at`

Artifact installation is complete when:

- new version is on disk
- new version is selected by the host-local current symlink

That does not imply the running `project-host` daemon has switched.

## Machine 2: Project-Host Activation

Owner: host-agent

Scope: switching the actual running `project-host` process to the newly
installed candidate

States:

- `stable`
- `candidate_pending`
- `restart_requested`
- `candidate_starting`
- `candidate_running_unhealthy`
- `candidate_running_healthy`
- `promoted`
- `rollback_requested`
- `rolled_back`

State meanings:

- `stable`
  - running version equals last-known-good
- `candidate_pending`
  - installed/current version differs from last-known-good
- `restart_requested`
  - host-agent has decided to move from old daemon to candidate
- `candidate_starting`
  - old daemon has been stopped and candidate process is starting
- `candidate_running_unhealthy`
  - candidate process exists but has not yet met health criteria
- `candidate_running_healthy`
  - candidate is healthy and running the candidate version
- `promoted`
  - candidate becomes new last-known-good
- `rollback_requested`
  - candidate missed deadline or explicit local rollback trigger fired
- `rolled_back`
  - previous version has been reactivated and restarted

### Required Activation Rules

If all of these are true:

- `currentVersion != lastKnownGood`
- `runningVersion == lastKnownGood`
- old daemon is still healthy

then host-agent must:

1. create/update `pending_rollout`
2. record `target_version` and `previous_version`
3. trigger `restartProjectHost(...)`

It must not treat that state as a no-op.

That exact gap caused one of the live failures on `host4`.

### Promotion Rule

The candidate is promoted only when:

- `runningVersion == currentVersion`
- health check passes

At that point host-agent must:

- set `last_known_good_version = currentVersion`
- clear `pending_rollout`

### Rollback Rule

If `pending_rollout.target_version == currentVersion` and the deadline expires
before the candidate becomes healthy, host-agent must:

1. reactivate `previous_version`
2. restart `project-host`
3. write `last_automatic_rollback`
4. set `last_known_good_version = previous_version`
5. clear `pending_rollout`

The rollback source is host-agent, not the hub.

## Machine 3: Managed Component Alignment

Owner: host-control rollout + component-specific supervisors

Scope: `conat-router`, `conat-persist`, `acp-worker`, and any future managed
daemons that run from the `project-host` artifact

States:

- `idle`
- `restart_requested`
- `restarting`
- `draining`
- `mixed`
- `aligned`
- `failed`

Per-component policy:

- `project-host`
  - `restart_now`
- `conat-router`
  - `restart_now`
- `conat-persist`
  - `restart_now`
- `acp-worker`
  - `drain_then_replace`

Alignment is complete when each component reaches its policy target:

- `project-host`: running only desired version
- `conat-router`: restarted and healthy
- `conat-persist`: restarted and healthy
- `acp-worker`: replacement spawned, old workers drained

`mixed` is expected for `acp-worker` during rollout and should not be treated
the same way as `project-host` drift.

## Allowed Transition Summary

### Happy Path

1. hub sets new desired artifact version
2. artifact machine reaches `installed`
3. host-agent enters `candidate_pending`
4. host-agent requests restart to candidate
5. candidate becomes healthy
6. host-agent promotes candidate to last-known-good
7. managed components align
8. hub LRO completes successfully

### Failing Candidate Path

1. hub sets new desired artifact version
2. artifact machine reaches `installed`
3. host-agent enters `candidate_pending`
4. host-agent requests restart to candidate
5. candidate remains unhealthy until deadline
6. host-agent rolls back to previous version
7. hub observes local rollback and reports failure

### Invalid Transition Examples

These should be treated as bugs:

- hub rewrites desired state backward before host-agent deadline expires
- host-agent sees old healthy daemon on previous version and does nothing
- UI shows `waiting` without telling which machine owns the wait
- `artifact installed` is reported as if `project-host running` had already
  switched

## Deadlines

Each wait must have one owner and one deadline.

### Hub Deadlines

- artifact resolution/download deadline
- outer LRO completion deadline
- optional grace period to observe host-agent convergence

### Host-Agent Deadlines

- candidate health deadline

The hub may wait longer than the host-agent deadline, but it should not invent
its own earlier rollback when host-agent is still evaluating the candidate.

## What Must Be Persisted

At minimum, the host should persist a single durable activation record with:

- `target_version`
- `previous_version`
- `phase`
- `started_at`
- `deadline_at`
- `running_pid`
- `running_version`
- `healthy`
- `accepted_at`
- `rollback_started_at`
- `rollback_finished_at`
- `failure_reason`

Today, these facts are spread across:

- bootstrap lifecycle state
- host-agent state
- runtime deployment metadata
- LRO progress

That is survivable, but not ideal. Long term these should be normalized into a
single host-observed rollout record and then projected into UI/API summaries.

## Operator / UI Contract

The UI should present rollout as explicit phases, not one generic spinner.

Minimum operator-visible phases:

- `Resolving artifact`
- `Downloading artifact`
- `Installing artifact`
- `Installed on host`
- `Waiting for host-agent to restart project-host`
- `Candidate running, health deadline in ...`
- `Candidate promoted to last known good`
- `Restarting conat router`
- `Restarting conat persist`
- `Draining/replacing ACP worker`
- `Complete`

On failure, show:

- rollback source
  - `host-agent local rollback`
  - `hub explicit rollback`
- target version
- rollback version
- observed running version
- deadline or timeout that expired
- owning machine
  - `artifact install`
  - `project-host activation`
  - `managed component alignment`

The UI should never say only:

- `waiting`

It must say what it is waiting for and who owns that wait.

## Review Checklist

Reject rollout changes that do any of the following:

- let the hub and host-agent both independently decide local rollback
- blur `installed` and `running` into one field
- treat a healthy old daemon on the previous version as success
- add a new wait with no explicit owner and no deadline
- report `project-host` aligned when only the artifact symlink changed
- hide mixed `acp-worker` state as if it were a `project-host` failure

## Practical Next Steps

1. Use this document as the canonical phase model for host-upgrade UX.
2. Expose activation phase and deadlines directly in host LRO progress.
3. Normalize host-agent rollout state into a single host-observed rollout
   record.
4. Keep artifact install, `project-host` activation, and managed-component
   alignment distinct in code and UI.
