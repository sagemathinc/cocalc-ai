# Host Software Lifecycle Model

Status: canonical model note as of 2026-05-01

This is the short reference for host software lifecycle. It exists so reviews
and debugging can point at one concrete model instead of re-deriving intent
from several plans.

Related documents:

- [deployment-host-convergence-hardening-plan-2026-05-01.md](/home/user/cocalc-ai/src/.agents/deployment-host-convergence-hardening-plan-2026-05-01.md)
- [bootstrap-tool-lifecycle.md](/home/user/cocalc-ai/src/.agents/bootstrap-tool-lifecycle.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)

## Terms

### Artifact

A versioned software payload published by the hub and installed on a host.

Current first-class artifacts:

- `bootstrap-environment`
- `project-host`
- `project-bundle`
- `tools`

Artifacts have a version identity. In local dev this is usually a numeric build
timestamp. Operators should treat that version as the source of truth, not the
fact that a file happened to be rebuilt recently.

### Component

A long-lived daemon process managed on the host.

Current managed components:

- `project-host`
- `conat-router`
- `conat-persist`
- `acp-worker`

Components run from installed artifacts, but component rollout is distinct from
artifact installation.

### Bootstrap-Environment

The host-local control layer written by `bootstrap.py`.

This includes:

- wrapper scripts
- helper scripts
- managed env files
- cloudflared helpers
- other privileged glue under bootstrap ownership

It is a real managed target, not an incidental side effect of first boot.

### Desired State

The effective target version for each managed artifact after applying:

1. global desired deployment state
2. host-scoped overrides
3. explicit rollback pins or resume-default behavior

Desired state is a control-plane fact. Bootstrap, reconcile, and observation
must all compute the same answer.

### Installed State

What payloads and bootstrap-owned assets are actually present on disk on the
host.

Installed state is observed from the host and recorded back into host
metadata/runtime status.

### Running State

What artifact/component version is currently active in live processes.

Examples:

- the currently running `project-host` bundle version
- the currently running daemon component state
- live projects and their real runtime processes

Installed and running state may differ during rollout, rollback, or partial
repair.

### Reconcile

A safe, idempotent repair path that makes installed and running state converge
toward desired state.

Reconcile may:

- install artifacts
- rewrite bootstrap-owned files
- roll managed components
- update observation metadata

Reconcile must be repeatable without introducing new drift.

### Rollout

An intentional action that changes desired state and/or asks a host to apply
that desired state now.

Examples:

- `cocalc host upgrade ...`
- `cocalc host reconcile ...`
- explicit runtime deployment changes

### Rollback

A controlled move back to a prior known-good version, usually for
`project-host`, using retained local artifacts when possible.

Rollback is its own lifecycle path. It is not just "another upgrade".

## Ownership Model

### Hub / Control Plane Owns

- published artifact catalog
- global desired versions
- host-scoped overrides
- upgrade/reconcile/rollback LRO orchestration
- normalized operator-facing status

### bootstrap-over-ssh Owns

- `bootstrap-environment` application on an existing host
- helper/wrapper/env file rewrite
- recovery when host-control cannot safely repair bootstrap-owned assets

### host-control / runtime deployment execution Owns

- online artifact installation and managed component alignment
- low-disruption runtime rollout when the host is healthy enough

### host-agent Owns

- host-local daemon supervision
- automatic `project-host` rollback to last known good
- reporting rollback facts back to the hub

## Repair Path Rules

Use these rules unless there is a documented exception.

1. If drift is only in runtime artifacts/components and the host is online,
   prefer host-control/runtime deployment reconcile.
2. If drift is in bootstrap-owned files or wrapper/schema state, prefer
   bootstrap-over-ssh reconcile.
3. If a new `project-host` fails health checks after rollout, host-agent owns
   the emergency rollback.
4. Deprovision/reprovision must clear accidental host-scoped local dev intent
   so fresh bootstrap uses current effective desired state.

## Required Operator Truth

For each host, operators must be able to answer without ssh:

- what is desired?
- what is installed?
- what is running?
- what repair path is expected to fix drift?
- what last happened during reconcile or rollback?

If a surface cannot answer those questions, it is incomplete.

## Current Development Commands

The local dev workflow is intentionally split:

- `pnpm dev:hub:build`
- `pnpm dev:hub:restart`
- `pnpm dev:hosts:upgrade`
- `pnpm dev:hosts:reconcile`
- `pnpm dev:stack:refresh`

These names reflect the lifecycle model better than the old overloaded
`hub:daemon:build` command.

## Review Heuristics

Reject lifecycle changes that do any of the following:

- infer desired state differently in different code paths
- treat `bootstrap-environment` as a one-off side effect
- blur installed state and running state into one field
- let two repair layers race to "fix" the same drift differently
- require ssh for standard operator understanding of host drift
