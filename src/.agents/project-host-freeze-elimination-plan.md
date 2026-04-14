# Project-Host Freeze Elimination Plan

Status: proposed

Goal: eliminate the class of freezes where ACP/Codex work can make the main
`project-host` process visibly hang, causing terminal stalls, virtual-socket
disconnects, or host control-plane instability.

This is not a plan to make the current lock behavior slightly less bad. It is a
plan to change the architecture so the main `project-host` process is no longer
in the blast radius of ACP persistence and worker contention.

## Problem Statement

We now have direct production evidence that ACP SQLite contention is real and
user-visible.

From `34.106.144.109` on April 14, 2026:

- `2026-04-14T15:08:37.613Z`
  `ACP worker heartbeat failed`
  `Error: database is locked`
- `2026-04-14T15:08:43.415Z`
  `failed to heartbeat acp turn lease`
  `Error: database is locked`

Those two log points are about `5.8s` apart, which is consistent with a
lock-wait budget around `5s` plus scheduling overhead.

During the same period, users observed:

- terminal hangs for about `5s`
- virtual socket disconnects
- transient reconnect behavior

That is enough evidence to treat this as an architectural defect, not a tuning
problem.

## Root Cause Model

The current failure mode is a combination of four design choices:

1. ACP state is stored in a SQLite file that is shared across components.
2. ACP code uses synchronous SQLite access (`DatabaseSync`-style accessors).
3. Multiple ACP workers can overlap and contend on the same DB.
4. The main `project-host` process remains too close to this lock domain.

The logs already prove at least two of these are happening in production:

- `database is locked` in ACP heartbeat paths
- overlapping ACP workers on the same host

The user's clarification about terminal hangs matters:

- the visible disconnect was in CoCalc's virtual socket layer over pub/sub
- the underlying browser websocket may have remained up

That is exactly what we would expect if the main `project-host` process stops
servicing work for roughly `5s` but does not fully crash.

## Hard Requirements

The new design must satisfy all of these:

1. A lock or stall in ACP persistence must not freeze the main `project-host`
   event loop.
2. A broken or overloaded Codex/ACP subsystem must not disconnect terminals,
   editors, or other non-ACP project services.
3. The main `project-host` process must not make synchronous, lock-prone calls
   into ACP state on hot paths.
4. Ordinary `project-host` restarts must not require overlapping ACP workers to
   preserve in-flight turns.
5. If ACP state remains SQLite-backed, it must be used in a way SQLite is good
   at:
   - narrow scope
   - single ownership
   - no multi-process hot contention

## Non-Goals

This plan does not try to:

- remove SQLite from CoCalc entirely
- replace chat/document sync storage
- redesign Codex session semantics
- solve every ACP reliability bug in one step

The target is narrower and more urgent:

- ACP must stop being able to freeze `project-host`

## Why Increasing `busy_timeout` Is The Wrong Fix

Do not "solve" this by increasing the shared timeout.

That would:

- make freezes last longer
- make terminal hangs worse
- increase the chance of virtual socket timeouts
- preserve the same lock contention pattern
- hide the architectural bug rather than removing it

The real problem is not merely that the timeout is `5s`. The real problem is
that lock waiting is happening in the wrong place, in the wrong process, on the
wrong storage boundary.

## Target Architecture

The correct long-term shape is:

- main `project-host` process:
  - project control plane
  - terminal/persist/changefeed/conat serving
  - no synchronous ACP DB access on hot paths
- ACP daemon:
  - owns ACP queue/lease/worker/automation state
  - owns Codex app-server lifecycle
  - may stall or restart without freezing the main host
- ACP storage:
  - isolated from the main `project-host` SQLite file
  - used only by the ACP daemon

In other words:

- ACP becomes a subsystem beside `project-host`, not inside its lock domain

## Design Principle

The single most important invariant is:

> The main `project-host` process must never block on ACP persistence.

Everything below is derived from that invariant.

## Proposed End State

### 1. Introduce a Dedicated ACP Daemon Process

Create a dedicated long-lived `project-host-acp` daemon.

Responsibilities:

- own ACP job queue state
- own ACP turn leases and worker state
- own ACP interrupt and steer queues
- own ACP automations
- own Codex app-server execution
- own ACP recovery logic

The main `project-host` process should only:

- ensure the ACP daemon is running
- send local RPC requests to it
- observe health/status via a narrow interface

It should not:

- open ACP SQLite directly on request paths
- inspect ACP queue tables synchronously
- coordinate turns by writing ACP DB rows itself

### 2. Move ACP State Into Its Own DB File

Create a separate DB file, for example:

- `/mnt/cocalc/data/acp.sqlite`

Move all ACP tables there:

- `acp_jobs`
- `acp_turns`
- `acp_workers`
- `acp_interrupts`
- `acp_steers`
- `acp_automations`
- `acp_queue` payload tables

The existing shared project-host SQLite file should no longer contain ACP
runtime state.

### 3. Make The ACP Daemon The Only Process That Opens `acp.sqlite`

This is the critical change.

Do not merely move ACP tables into a separate DB and continue opening that DB
from both the main process and ACP workers. That would reduce cross-subsystem
blast radius, but it would not eliminate multi-process DB contention.

The stronger rule is:

- only the ACP daemon opens `acp.sqlite`

That means:

- no `DatabaseSync` access to ACP state from the main process
- no direct ACP DB reads/writes from project-host request handlers
- no separate overlapping ACP workers all contending on the same file

### 4. Replace Direct ACP DB Calls With Local RPC

The main process should communicate with the ACP daemon over a local control
channel:

- unix domain socket JSON-RPC, or
- local-only Conat subject, or
- a minimal internal IPC layer

The API surface should include:

- `enqueueTurn`
- `interruptTurn`
- `steerTurn`
- `reprioritizeTurn`
- `forkSession`
- `truncateSession`
- `getThreadState`
- `listPendingJobs`
- `health`

The main process waits for the ACP daemon to durably persist before it returns
success to the browser.

That preserves durability without putting SQLite lock waits in the main event
loop.

### 5. Collapse ACP Execution To One Daemon Per Host

Do not keep the current pattern where multiple same-bundle ACP workers are
constantly spawned and drained.

Steady state should be:

- one ACP daemon per host

If the ACP daemon internally needs concurrency, it can manage it in-process.
That is much safer than multiple OS processes sharing a hot SQLite file.

### 6. Remove Same-Bundle Rolling Worker Churn

The current rolling-worker model was useful for preserving in-flight turns
during upgrades, but it creates multi-process contention.

After ACP is moved into a separate long-lived daemon:

- ordinary `project-host` restarts no longer need rolling ACP workers
- the ACP daemon can remain up while the main process restarts

That removes most of the operational reason to run overlapping ACP workers in
the first place.

For ACP daemon upgrades themselves, use one of:

- explicit drain and restart during low load
- a later, deliberate handoff protocol

Do not keep same-bundle rolling overlap as normal steady-state behavior.

## Why This Works

This design works for concrete reasons, not just because it is "cleaner".

### It Breaks The Freeze Causal Chain

Current chain:

1. ACP workers contend on shared SQLite.
2. A lock wait happens.
3. Synchronous DB access blocks or fails in a latency-sensitive path.
4. Main host responsiveness degrades.
5. Virtual sockets, terminals, or hub/host control plane visibly wobble.

New chain:

1. ACP contention, if any, is confined to `acp.sqlite`.
2. Only the ACP daemon touches that DB.
3. The main `project-host` process never blocks on ACP DB locks.
4. Terminal, persist, and project control paths keep running.
5. ACP may degrade, but `project-host` does not freeze.

### It Uses SQLite In A Regime Where SQLite Is Strong

SQLite is fine when:

- ownership is narrow
- concurrency is limited
- there is one obvious writer
- latency-sensitive unrelated services are not sharing the same lock domain

That is exactly what the ACP daemon design gives us.

### It Removes The Worst Multi-Process Contention

The logs already show overlapping ACP workers. Even if SQLite is moved to a new
file, overlapping workers would still contend if they all open it.

Making the ACP daemon the sole DB owner removes that class of contention
entirely.

## Implementation Plan

## Phase 0: Immediate Guard Rails

Goal: reduce risk while larger refactor is in progress.

Changes:

1. Add main-process event loop stall logging.
   - log when the `project-host` event loop stalls for `>250ms`, `>1000ms`,
     and `>4000ms`
   - include timestamp, lag, and a coarse subsystem activity snapshot

2. Add ACP DB lock telemetry.
   - every `database is locked` should log:
     - DB filename
     - operation name
     - process id
     - worker id
     - elapsed wait if known

3. Clamp ACP worker multiplicity.
   - if more than one same-bundle ACP worker exists, log loudly
   - terminate pathological extras
   - do not permit steady-state worker accumulation

Why this helps:

- it does not solve the architecture
- but it gives explicit production signals and reduces silent degradation

## Phase 1: Split ACP Storage

Goal: get ACP tables out of the shared host DB.

Changes:

1. Add a new ACP SQLite wrapper:
   - `src/packages/lite/hub/sqlite/acp-database.ts`
2. Point all ACP table modules to `acp.sqlite`.
3. Keep file format and table schemas stable at first.
4. Add migration/bootstrapping logic from the old DB on first start.

Acceptance:

- ACP tables no longer live in the main project-host SQLite file
- no non-ACP code opens `acp.sqlite`

Why this helps:

- it immediately removes cross-subsystem DB lock coupling
- ACP lock contention can no longer directly lock the main host DB file

## Phase 2: Introduce ACP Daemon Ownership

Goal: main process stops touching ACP DB state entirely.

Changes:

1. Add a dedicated ACP daemon entrypoint.
2. Move all ACP queue/recovery/automation loops into it.
3. Give it sole ownership of `acp.sqlite`.
4. Main process becomes supervisor only.

Acceptance:

- only ACP daemon opens `acp.sqlite`
- main process can restart without restarting ACP daemon
- in-flight ACP turns survive ordinary main-process restart

Why this helps:

- the main process leaves the ACP lock domain completely

## Phase 3: Local RPC For ACP Operations

Goal: preserve durable semantics without direct DB access from the main host.

Changes:

1. Define local RPC contract:
   - submit
   - interrupt
   - steer
   - fork
   - truncate
   - status
2. Route browser/API ACP requests through the ACP daemon.
3. Ack browser requests only after ACP daemon durably writes state.

Acceptance:

- a browser submit no longer causes main process SQLite writes to ACP tables
- the main process only relays and validates

Why this helps:

- durability stays intact
- main-process blocking on ACP persistence is removed

## Phase 4: Simplify Worker Lifecycle

Goal: stop same-bundle rolling churn from reintroducing contention.

Changes:

1. One ACP daemon per host in steady state.
2. No same-bundle "rolling" replacement as normal behavior.
3. Ordinary project-host deploys do not touch the ACP daemon.
4. ACP daemon upgrades use explicit drain/restart.

Acceptance:

- steady-state ACP process count is stable
- no recurring spawn/drain churn every few minutes

Why this helps:

- no more self-created lock contention from overlapping ACP processes

## Phase 5: Hard Failure Containment

Goal: make ACP failure visible but isolated.

Changes:

1. Main process health should report ACP degraded separately.
2. ACP failure must not mark the whole host offline unless project services are
   actually unavailable.
3. Browsers should see ACP-specific degradation, not generic project-host
   breakage.

Acceptance:

- ACP can fail without taking terminals and basic project interactions with it

Why this helps:

- it converts a host-wide freeze into a contained subsystem failure

## Testing Plan

The implementation is not done until these are reproducible and pass.

### Test 1: Single User Terminal Stall Regression

1. Start a long Codex turn.
2. Simultaneously use a terminal in the same project.
3. Force ACP DB pressure or ACP restart activity.
4. Verify terminal does not visibly freeze for `>250ms`.

### Test 2: Main Process Restart

1. Start a Codex turn.
2. Restart the main `project-host` process only.
3. Verify:
   - Codex turn continues
   - terminal stays connected
   - no virtual socket stall

### Test 3: ACP Daemon Failure Isolation

1. Kill ACP daemon.
2. Verify:
   - terminal still works
   - basic project control still works
   - ACP requests fail explicitly and recover after daemon restart

### Test 4: No Multi-Worker Contention

1. Generate repeated ACP traffic.
2. Verify only one ACP daemon owns the DB.
3. Verify no `database is locked` appears from ACP heartbeat paths.

### Test 5: Suspend/Resume And Reconnect

1. Keep terminal open.
2. Suspend/resume laptop.
3. Verify reconnect path does not trigger host-visible freeze.

## Recommended Order

This is the smallest safe order:

1. Phase 0 guard rails
2. Phase 1 ACP DB split
3. Phase 2 ACP daemon ownership
4. Phase 3 local RPC
5. Phase 4 worker lifecycle simplification
6. Phase 5 failure containment

Do not skip directly to tuning timeouts.

## Bottom Line

The right fix is not:

- bigger `busy_timeout`
- more retries
- more forgiving heartbeats

The right fix is:

- ACP isolation
- single ownership of ACP persistence
- no synchronous ACP DB dependency in the main `project-host` process

That is the architecture that actually removes this freeze class instead of
making it less frequent.
