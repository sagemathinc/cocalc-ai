# Project-Host Restart Contract

## Problem

Restarting or upgrading a project-host can leave stale hub-side and browser-side
connections around that still identify the host only by stable `host_id`.

This causes confusing behavior:

- routed Conat clients on the hub can keep talking to an old dead connection
- project operations can hang instead of failing fast
- browser pages can require manual refresh after a host restart

The core missing concept is a **host incarnation/session identity**.

## Contract

Every project-host process start must create a fresh `host_session_id`.

The hub must treat `(host_id, host_session_id)` as the identity of the current
live control-plane process, not just `host_id`.

Expected behavior:

1. A restarted host gets a new `host_session_id`.
2. The hub invalidates stale cached routing for that host.
3. The next routed request creates a fresh routed client for the new session.
4. In-flight operations that are not explicitly resumable should fail clearly or
   be retried by higher-level logic; they must not silently hang.
5. New operations should only be admitted once the host is ready for work.
6. Browser/project connections should reconnect or self-heal when possible.

## Readiness Stages

These are the stages we want the system to model explicitly:

- `connected`: host websocket/Conat session exists
- `control_ready`: host control API answers ping
- `file_server_ready`: file-server answers ping
- `ready_for_work`: host is eligible for new start/backup/restore/publish work

Only `ready_for_work` should admit new operations.

## Implementation Plan

### Step 1: Session identity

Implemented in this phase:

- project-host generates a per-process `host_session_id`
- `host_session_id` is included in register/heartbeat metadata
- hub persists it on the `project_hosts` row metadata
- routed project targets include `host_session_id`
- routed hub clients are evicted/recreated when the session changes
- host re-register sends a host-scoped route invalidation notification so the
  hub drops cached project routes for that host

This addresses the most basic stale-route problem.

### Step 2: Admission/readiness

Follow-up work:

- track explicit host readiness phases on the hub
- gate new operations on readiness instead of only `last_seen`
- fail fast when a host restarts during an in-flight non-resumable operation

### Step 3: Browser reconnect semantics

Follow-up work:

- surface `host_session_id` in project/session metadata exposed to the browser
- detect session changes and reconnect project tabs without manual refresh when
  possible

## Test Matrix

The restart regression matrix should include:

1. Restart idle host, then verify new starts work without manual cleanup.
2. Restart host during project start.
3. Restart host during RootFS publish.
4. Restart host during backup/restore/copy.
5. Verify routed hub clients are recreated for the new session.
6. Verify browser/project tabs recover or show a clear reconnect state.

## Current Status

Backend session identity and routed-client invalidation are implemented.

Readiness gating and browser reconnect semantics are still follow-up work.
