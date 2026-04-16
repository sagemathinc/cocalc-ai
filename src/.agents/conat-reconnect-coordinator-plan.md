# Conat Reconnect Coordinator Plan

## Problem

Conat reconnect handling is currently spread across multiple layers:

- browser connection monitoring in
  `src/packages/frontend/app/monitor-connection.ts`
- top-level transport reconnect and subscription resync in
  `src/packages/conat/core/client.ts`
- per-storage reconnect in
  `src/packages/conat/persist/client.ts`
- per-virtual-socket retry/reconnect in
  `src/packages/conat/socket/client.ts`
- per-stream bootstrap and changefeed recovery in
  `src/packages/conat/sync/core-stream.ts`

When the network flaps or a laptop resumes from sleep, these layers all try to
recover at once. That creates the exact failure mode seen during dogfooding:

- multiple browser tabs pin the CPU for minutes
- `getAllFromPersist` retries pile up
- terminals and chats recover much more slowly than a manual page refresh
- background tabs compete with the foreground tab for recovery work

The architecture is wrong for this workload. The system has too many
independent reconnect loops and too many resource-local ideas of liveness.

## Goal

Replace distributed reconnect logic with a single browser-side reconnect
coordinator per routed host connection.

The coordinator will:

- own reconnect state, backoff, and epochs
- treat Socket.IO transport liveness as the primary heartbeat
- reconnect the currently visible foreground work first
- delay background catch-up until the foreground becomes interactive
- cancel stale recovery work from older reconnect epochs
- dedupe repeated recovery/bootstrap requests for the same storage

## Non-Goals

- do not rewrite the whole backend first
- do not redesign Conat message formats in phase 1
- do not solve every terminal/file/watch optimization at once
- do not keep the current “many local reconnect loops” model and only tune
  timeouts

## Guiding Principles

1. There is one transport connection per routed host, so there should be one
   reconnect coordinator per routed host.
2. Only the transport layer should use heartbeat/ping as its main liveness
   mechanism.
3. Higher-level resources should not schedule reconnects on their own.
4. Recovery must be prioritized:
   - active foreground file/editor/chat/terminal first
   - visible project support data next
   - background tabs and hidden resources last
5. Recovery must be epoch-based:
   - work started for reconnect epoch `N` must be ignored or cancelled once
     epoch `N+1` begins.
6. Recovery must be deduped:
   - if multiple consumers want the same storage bootstrap, do it once.

## Current Failure Sources

### 1. Browser connection monitor triggers extra reconnects

`src/packages/frontend/app/monitor-connection.ts`
calls `webapp_client.conat_client.reconnect()` in response to instability.
This is an extra reconnect authority layered on top of Conat itself.

### 2. Core client reconnects and resyncs subscriptions globally

`src/packages/conat/core/client.ts`
already owns transport reconnection and then runs `syncSubscriptions()`.
This is the right place for transport ownership, but it is not yet the central
coordinator for higher-level recovery.

### 3. Persist clients reconnect per storage path

`src/packages/conat/persist/client.ts`
maintains its own reconnect timers and backoff per storage.
This means a network flap can cause many storage-local reconnect attempts at
once.

### 4. Virtual sockets retry independently

`src/packages/conat/socket/client.ts`
retries socket requests by disconnecting and waiting for readiness again. This
is another reconnect decision maker.

### 5. Streams bootstrap independently

`src/packages/conat/sync/core-stream.ts`
calls `getAllFromPersist(...)` during init and again during changefeed
recovery. Many streams doing that at once is exactly the sort of reconnect
thundering herd we want to stop.

## Target Architecture

### Transport

Transport ownership stays with the routed Conat client in
`src/packages/conat/core/client.ts`.

There should be one liveness signal at this layer:

- Socket.IO connect/disconnect/ping state

We may keep one coordinator-level progress watchdog later, but there should not
be separate reconnect timers for each stream/socket/storage client.

### Reconnect Coordinator

Introduce a browser-side `ReconnectCoordinator` for each routed host.

Responsibilities:

- track connection state:
  - `disconnected`
  - `connecting`
  - `transport_ready`
  - `resync_foreground`
  - `interactive_ready`
  - `resync_background`
- own reconnect epoch counters
- own reconnect backoff
- own recovery queues and resource priorities
- expose one place to request reconnect and one place to observe readiness

### Resource Adapters

Each high-level Conat consumer becomes a passive resource adapter instead of
owning reconnect logic.

Phase-1 interface:

```ts
type ReconnectPriority =
  | "foreground-active"
  | "foreground-support"
  | "background-visible"
  | "background-hidden";

interface ReconnectResource {
  key: string;
  priority: ReconnectPriority;
  suspend(reason: "disconnect" | "epoch-replaced"): void;
  resume(epoch: number): Promise<void>;
  close(): void;
}
```

Properties:

- resources do not schedule reconnect timers
- `resume(epoch)` must be idempotent
- `resume(epoch)` must abandon stale work if the coordinator has advanced to a
  newer epoch

### Foreground-First Recovery

The key user-visible behavior change is:

- when the network reconnects, restore the active thing the user is looking at
  first
- only after that is interactive again, start catching up background tabs and
  background resources

This should apply to:

- the current foreground project
- the current foreground file/editor/chat
- the current foreground terminal

Background tabs should not be allowed to compete equally during the first
recovery burst.

### Shared Bootstrap Queue

Introduce a per-host bootstrap queue inside the coordinator:

- key by storage path or stream identity
- dedupe identical work
- cap concurrency
- support cancellation by epoch

This is where `getAllFromPersist(...)` recovery should go instead of every
stream doing its own full reconnect/bootstrap logic independently.

## Migration Plan

### Phase 0: Stabilize the Baseline

Status:

- Conat inventory is hard-disabled in
  `src/packages/conat/sync/inventory.ts`
  so it does not confuse reconnect experiments.

Required before phase 1:

- keep router/persist/acp metrics in place
- keep supervision event logging in place
- preserve the current reconnect/recovery behavior until the coordinator
  supersedes it

### Phase 1: Browser-Side Coordinator Skeleton

Create a browser-only coordinator layer above the existing routed Conat client.

Likely home:

- new frontend package module under `src/packages/frontend/conat/`

Work:

1. Create the `ReconnectCoordinator` state machine.
2. Register foreground and background resources with priorities.
3. Make `monitor-connection.ts` stop issuing extra manual reconnects.
4. Expose:
   - `requestReconnect(reason)`
   - `waitUntilInteractiveReady()`
   - `registerResource(...)`
5. Keep lower layers functional, but route reconnect requests through the
   coordinator first.

Success criteria:

- a reconnect results in one visible coordinator transition sequence
- the foreground tab becomes usable before background tabs fully catch up

### Phase 2: Persist Recovery Under Coordinator Control

Refactor persist/bootstrap behavior so reconnect is not per-storage autonomous
work.

Work:

1. Stop `persist/client.ts` from owning long-lived reconnect scheduling.
2. Make storage reconnect/resume coordinator-driven.
3. Add deduped bootstrap queue keyed by storage path.
4. Add epoch cancellation so stale bootstrap work cannot continue draining CPU
   after a newer reconnect has started.

Success criteria:

- no storage-local reconnect herd
- bounded concurrent bootstraps
- reconnect metrics are understandable by epoch

### Phase 3: Stream and Virtual Socket Adaptation

Move stream and socket recovery to passive adapter mode.

Work:

1. Make `core-stream.ts` resume via coordinator epochs instead of self-directed
   retry loops.
2. Make `socket/client.ts` request recovery from the coordinator instead of
   disconnecting/retrying independently.
3. Preserve resource-local semantics such as terminal leadership or channel
   behavior, but remove reconnect ownership from those layers.

Success criteria:

- one reconnect authority remains
- stream/socket layers do not each trigger their own reconnect storms

### Phase 4: Background Catch-Up Policy

After foreground-first recovery works, make background recovery intentionally
lazy.

Work:

1. Identify which open files/tabs are visible and interactive.
2. Delay background tab reconnection until:
   - the foreground is interactive, and
   - the coordinator judges the system stable.
3. Consider deprioritizing or suspending background resources that do not need
   instant catch-up.

Success criteria:

- reconnecting the network does not immediately light up every background tab
- browser CPU remains dominated by the tab the user is actively using

### Phase 5: Cleanup

Once the coordinator is proven:

- remove obsolete reconnect loops
- remove redundant heartbeats below transport
- simplify operator-facing connection diagnostics around the coordinator model

## Foreground Priority Model

The coordinator should classify work roughly like this:

### `foreground-active`

The currently focused thing the user is actively looking at.

Examples:

- active editor/chat file
- active terminal
- active notebook session

### `foreground-support`

Small dependencies needed to make the foreground usable.

Examples:

- project metadata needed for the current project page
- active project presence/read-state

### `background-visible`

Open but unfocused tabs in currently loaded browser windows.

### `background-hidden`

Everything else:

- hidden tabs
- old editors not currently on screen
- passive background views

## Risks

### Risk: layering the coordinator on top of existing reconnect logic creates

two authorities

Mitigation:

- in phase 1, explicitly remove browser-level extra reconnect forcing in
  `monitor-connection.ts`
- in later phases, strip reconnect ownership from persist/stream/socket layers

### Risk: stale work from older reconnect epochs still mutates state

Mitigation:

- every recovery job carries an epoch token
- all async resume/bootstrap paths check the current epoch before committing
  results

### Risk: background tabs become too stale

Mitigation:

- that is acceptable as long as the active tab becomes interactive quickly
- background catch-up remains part of the coordinator, just lower priority

## First Implementation Slice

The first slice should be intentionally narrow:

1. Hard-disable inventory entirely.
2. Add browser-side `ReconnectCoordinator`.
3. Make the coordinator own reconnect requests from
   `monitor-connection.ts`.
4. Add foreground vs background resource registration.
5. Gate recovery so only foreground resources resume first.

Do **not** start by rewriting every stream/socket/storage implementation. The
first win is controlling the order and duplication of reconnect work.

## Success Criteria

We should consider the coordinator approach successful when all of the
following are true during a wifi flap / sleep-resume test:

- the foreground tab becomes usable quickly
- background tabs do not all compete equally during the first reconnect burst
- browser CPU no longer pins for minutes across multiple tabs
- `getAllFromPersist` retries drop sharply during reconnect
- reconnect logs show one coherent recovery sequence per routed host instead of
  many independent loops
