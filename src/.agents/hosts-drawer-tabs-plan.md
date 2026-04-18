# Hosts Drawer Tabs Plan

## Goal

Refactor the overloaded host drawer in
`src/packages/frontend/hosts/components/host-drawer.tsx`
into a tabbed drawer so the surface is easier to scan, easier to maintain,
and less likely to keep accreting unrelated controls into one long scroll.

The target is not a visual redesign first. The target is information
architecture and operational clarity.

## Why

The current drawer mixes several unrelated jobs into one vertical surface:

- host summary and health
- lifecycle actions
- software/runtime deployment state
- managed daemon controls
- projects and backup operations
- rootfs/cache management
- logs and diagnostics
- destructive actions

This makes the drawer harder to use and harder to extend.

## Recommended Structure

Use tabs inside the existing drawer. Do not split into multiple independent
drawers.

Recommended tabs:

1. `Overview`
2. `Runtime`
3. `Projects`
4. `Storage`
5. `Logs`
6. `Danger`

## Tab Responsibilities

### Overview

Purpose:

- the operational summary of the host
- the first place a user lands

Contents:

- name, provider, region, size
- online/offline/status tags
- current host op / bootstrap progress
- daemon health summary
- current metrics summary
- project counts / backup summary
- last action / last error summary
- top-level actions:
  - edit
  - refresh
  - details-style links into deeper tabs if useful

Rules:

- no dense version-management controls here
- no long project browser
- no rootfs inventory
- no destructive controls

### Runtime

Purpose:

- software lifecycle and runtime deployment management

Contents:

- software artifacts section
  - `project-host`
  - `project bundle`
  - `tools`
- managed daemon components section
  - `project-host`
  - `conat-router`
  - `conat-persist`
  - `acp-worker`
- reconcile / deploy / rollback / resume-cluster-default controls
- CLI snippets / popovers

Rules:

- this is the only tab that should own most version-management actions
- keep drawer-wide status summary out of here

### Projects

Purpose:

- host occupancy and project/backups operations

Contents:

- project status summary
- backup status
- stop/restart running projects
- host projects browser

Rules:

- no software lifecycle controls
- no rootfs/cache controls

### Storage

Purpose:

- storage and cache operations

Contents:

- rootfs inventory
- rootfs pull/delete/gc
- rootfs cache state
- storage metrics that are primarily about host capacity / cache / disk

Rules:

- keep this focused on storage mechanics
- if a metric is general operational health, it may also appear in Overview in
  summarized form

### Logs

Purpose:

- diagnostics and observability

Contents:

- host runtime log tail
- recent restart / watchdog / health summaries
- bootstrap lifecycle detail
- forensics capture status if available
- host session ids / timestamps if useful

Rules:

- no mutation-heavy controls except log refresh / copy

### Danger

Purpose:

- destructive or high-risk operations

Contents:

- deprovision
- delete
- remove connector
- force-deprovision / force operations

Rules:

- all destructive actions live here, not scattered throughout the drawer
- future enhancement:
  - support an optional per-host destructive-operation lock phrase
  - require the user to enter or paste that phrase before deprovision/delete
  - this is not a secret; it is an intentional friction mechanism for high-value
    hosts such as production or dogfood infrastructure

## Mapping Current Drawer Sections

Current blocks should move as follows:

- host identity / provider / region / size:
  - `Overview`
- status tags / online state / bootstrap progress:
  - `Overview`
- current host op panel:
  - `Overview`
- software artifacts cards:
  - `Runtime`
- daemon components cards:
  - `Runtime`
- reconcile button:
  - `Runtime`
- project status / backup summary:
  - `Projects`
- stop/restart running projects:
  - `Projects`
- project browser:
  - `Projects`
- rootfs cache / inventory:
  - `Storage`
- log viewer:
  - `Logs`
- detailed bootstrap lifecycle panel:
  - `Logs`
- delete / deprovision / remove connector:
  - `Danger`

## Header Actions

Keep a very small set of drawer-level actions in the header:

- close
- refresh
- maybe edit host

Avoid putting many operational buttons in the header. Most actions should live
in the relevant tab.

## State Model

Add persistent local state for:

- selected drawer tab
- per-tab expansion state only where necessary

Use local storage only for the selected tab if it proves helpful. Do not
persist every collapsible detail section unless there is a clear reason.

## Phased Implementation

### Phase 1: Structural Refactor

Goal:

- introduce tabs without changing most individual section internals

Work:

- add tab shell to `host-drawer.tsx`
- move existing sections into the tabs listed above
- keep current controls and cards mostly unchanged

Acceptance:

- no loss of existing functionality
- no one long scroll surface

### Phase 2: Overview Compression

Goal:

- make `Overview` genuinely summary-first

Work:

- trim duplicate details from Overview
- create or refine compact summary blocks:
  - daemon health
  - metrics
  - project occupancy
  - last action/error

Acceptance:

- Overview is quick to scan in under one screen on desktop

### Phase 3: Runtime Cleanup

Goal:

- make Runtime the clear home for software/daemon lifecycle

Work:

- align artifact cards and daemon cards visually
- standardize action affordances
- standardize CLI popovers

Acceptance:

- all rollout/deploy/rollback actions are easy to find in one place

### Phase 4: Logs / Danger Cleanup

Goal:

- isolate diagnostics and destructive operations

Work:

- simplify Logs tab
- move all destructive actions into Danger

Acceptance:

- no destructive controls remain scattered in non-danger tabs

## Constraints

- keep the drawer itself for now
- do not introduce route-based host subpages yet
- do not add multiple nested drawers
- do not redesign the data model as part of the first tab pass

## Success Criteria

The refactor is successful if:

- users can find runtime deployment controls immediately under `Runtime`
- users can find project occupancy/backups under `Projects`
- users can find logs/diagnostics under `Logs`
- destructive actions are isolated
- the default `Overview` tab is short and readable

## Recommended Next Task

Implement Phase 1 only:

- add tabs to `host-drawer.tsx`
- move current sections into the new tab layout
- keep all existing controls working

Do not try to fully redesign card internals in the same change-set.
