## Conat Coordinated Recovery API Plan

Status: proposed API and migration plan as of 2026-04-17

Related:

- [frontend-standby-load-shedding-plan.md](./frontend-standby-load-shedding-plan.md)
- [conat-reconnect-coordinator-plan.md](./conat-reconnect-coordinator-plan.md)

### Goal

Define a shared recovery API for Conat stateful resources so that:

- `dstream`
- `dkv`
- Conat sockets

can keep their own protocol-local correctness state while a higher-level
coordinator owns reconnect scheduling, prioritization, and concurrency.

This plan is intentionally broader than the current frontend reconnect work.
It is meant to support:

- browser tabs
- backend Node.js processes
- any future long-lived Conat client with many active resources

### Why This Is Needed

Today, several Conat abstractions already contain local reconnect logic:

- [core-stream.ts](../packages/conat/sync/core-stream.ts)
- [dkv.ts](../packages/conat/sync/dkv.ts)
- [dstream.ts](../packages/conat/sync/dstream.ts)
- [socket/base.ts](../packages/conat/socket/base.ts)
- [socket/client.ts](../packages/conat/socket/client.ts)

This local logic is good for protocol correctness, but it is not sufficient for
system-wide operational behavior.

The failure mode is:

- each object decides for itself when to reconnect
- each object decides for itself how aggressively to retry
- after a disconnect or wake-from-sleep, many resources recover at once
- browsers or Node.js processes with many active resources can stampede

This is especially dangerous for:

- backend workers with hundreds or thousands of `dkv` / `dstream` / socket
  instances
- mobile foreground wake-ups
- standby/resume transitions
- cluster restarts or short network flaps

### Important Constraint

Do **not** solve this by replacing a `DStream`, `DKV`, or socket object with a
fresh one whenever reconnect is needed.

That is the wrong abstraction boundary.

For these stateful objects, application code may depend on:

- their in-memory data
- attached listeners
- resend/ack state
- checkpoint state
- stable object identity

The correct design is:

- keep the object
- keep its local correctness state
- improve its API so an external coordinator can drive recovery

### Existing Strengths To Preserve

#### 1. `CoreStream` already knows how to recover efficiently

In [core-stream.ts](../packages/conat/sync/core-stream.ts):

- changefeed recovery already resumes from `lastSeq + 1`
- retained-history gaps are already detected and surfaced

This is good and should remain the basis for stream recovery.

#### 2. Conat sockets already protect ordering and delivery

In [socket/client.ts](../packages/conat/socket/client.ts) and
[socket/tcp.ts](../packages/conat/socket/tcp.ts):

- sockets maintain resend/ack state
- sockets preserve ordering
- sockets aim for exactly-once delivery semantics

That correctness logic must stay local to the socket protocol engine.

#### 3. The frontend already has a useful reconnect coordinator shape

In [reconnect-coordinator.ts](../packages/frontend/conat/reconnect-coordinator.ts),
we now have a workable model of:

- shared reconnect ownership
- resource registration
- foreground/background prioritization
- standby-aware suppression

The Conat recovery API should make it possible for both frontend and backend
coordinators to steer resource recovery in the same style.

### Design Principles

1. Local resource objects own protocol correctness.
2. Coordinators own recovery scheduling.
3. Stable resource objects must survive reconnects.
4. Recovery must be externally observable.
5. Recovery must be pausable and resumable.
6. Recovery must be concurrency-limited at the process level.
7. Full reset should only happen on true history/state gaps, not ordinary
   reconnects.

### Target Split Of Responsibilities

#### Local resource layer

Each `dstream`, `dkv`, and Conat socket should continue to own:

- local in-memory state
- message ordering and dedup
- ack/resend state
- last-seen sequence tracking
- checkpoint tracking
- protocol-specific recovery mechanics

#### Coordinator layer

A coordinator per client process should own:

- reconnect epochs
- retry timing and backoff
- recovery priorities
- concurrency limits
- standby/load-shedding policy
- deduping equivalent recovery work
- foreground-before-background ordering

For a Node.js process with many active resources, this should be tested
explicitly once the coordinator exists:

1. create a process with large `N` sockets and/or streams
2. disconnect and reconnect the network or underlying Conat transport
3. observe orderly restoration of service instead of a reconnect stampede

### Heartbeat And Liveness

Heartbeat policy must also be coordinated.

At the moment, there is a real risk of too many resource-local liveness checks.
In particular, `dstream` / `dkv` recovery often flows through persist clients,
and persist clients use Conat sockets, which currently have per-socket
keepalive behavior.

That does not scale well for large fanout.

The intended direction should be:

1. transport-level liveness first
   - one primary heartbeat/liveness signal for the underlying Conat transport
2. shared service-session liveness second
   - if persist or another service needs extra liveness tracking, prefer one
     shared session heartbeat over one heartbeat per logical resource
3. resource-local heartbeats only as an exception
   - only where correctness truly requires it
   - only under coordinator control
   - never as unbounded independent timers across hundreds of resources

The exact final design is still open, but one constraint should be treated as
firm:

- avoid one heartbeat per `dkv`, one heartbeat per `dstream`, or one heartbeat
  per logical socket by default

### Proposed Common Recovery Surface

Each recoverable Conat resource should expose a small shared contract.

```ts
type RecoveryState =
  | "ready"
  | "disconnected"
  | "recovering"
  | "paused"
  | "history_gap"
  | "closed";

interface RecoverableConatResource {
  getRecoveryState(): RecoveryState;
  pauseRecovery(reason: string): void;
  resumeRecovery(opts?: {
    epoch?: number;
    priority?: "foreground" | "background";
  }): Promise<void>;
  recoverNow(opts?: {
    epoch?: number;
    priority?: "foreground" | "background";
    reason?: string;
  }): Promise<void>;
  close(): void;
}
```

This interface is intentionally small.

The main point is not to standardize every implementation detail. The main
point is to standardize coordinator control.

### Proposed Lifecycle Events

Each resource should also expose recovery lifecycle events so application code
and coordinators can reason about real state transitions.

Minimum event set:

- `connected`
- `disconnected`
- `recovering`
- `recovered`
- `history-gap`
- `closed`

Potentially useful later:

- `paused`
- `stalled`
- `recovery-progress`

### Resource-Specific Interpretation

#### `CoreStream` / `DStream`

Desired behavior:

- keep the same object and current message arrays
- on ordinary reconnect, fetch only the missing tail from persist
- on history gap, emit `history-gap` and transition to a reset/rebootstrap path

The resource should not silently launch an independent recovery storm when the
coordinator has chosen to defer background recovery.

#### `DKV`

Desired behavior:

- keep the same object and merged in-memory state
- preserve unsaved local mutations and conflict context
- recover remote state incrementally when possible
- surface a true reset only when required

#### Conat socket

Desired behavior:

- keep the same socket object
- preserve resend/ack state
- preserve exactly-once/in-order semantics across reconnect
- let the coordinator decide when socket reconnection work is scheduled

This is the most correctness-sensitive resource type, so it should be an early
integration-test target.

### Coordinated Mode

The current local reconnect logic should evolve into a coordinated mode rather
than being deleted outright.

In coordinated mode:

- resources do not own aggressive long-lived reconnect timers
- resources enter `disconnected` / `recovering`
- resources wait for the coordinator to call `resumeRecovery()` or
  `recoverNow()`
- resources still perform protocol-specific replay/resend/recovery internally

This lets us preserve correctness while stopping thundering-herd behavior.

### Process-Level Recovery Coordinator

We should have a shared recovery coordinator per Conat client process.

That applies to:

- browser frontend main Conat client
- backend workers
- CLI daemons
- any other long-lived Conat client process

Coordinator responsibilities:

- maintain one reconnect epoch counter
- own a bounded work queue
- group work by priority
- cap concurrent recovery
- apply jitter/backoff
- suppress or defer background work when needed

For a Node.js process with 1000 resources, this is the only realistic way to
avoid reconnect collapse.

USER:  We could actually test this with the coordinator once it exists: (1) create a node process with large $N$ sockets (or streams), (2) disconnect then reconnect the network, (3) observe orderly restoration of services.

### Migration Shape

#### Phase 1: Add lifecycle/control API without changing semantics much

Add new recovery-facing methods and events to:

- [core-stream.ts](../packages/conat/sync/core-stream.ts)
- [dstream.ts](../packages/conat/sync/dstream.ts)
- [dkv.ts](../packages/conat/sync/dkv.ts)
- [socket/base.ts](../packages/conat/socket/base.ts)
- [socket/client.ts](../packages/conat/socket/client.ts)

Initially, the default behavior can remain close to current behavior.

Goal:

- surface recovery state explicitly
- make coordinator integration possible

#### Phase 2: Introduce coordinated mode

Add a way for resources to opt into coordinator-driven recovery.

Likely shape:

- constructor option or client-level policy that enables coordinated mode
- local reconnect timers become dormant in that mode
- resources recover only when the coordinator schedules them

#### Phase 3: Use coordinated mode in the frontend

Switch the frontend reconnect coordinator to use the new resource API instead
of treating `dstream` / `dkv` / sockets as opaque or trying to replace them.

This should directly improve:

- Codex log live stream resume
- mobile wake-up recovery
- standby/load-shedding interactions

#### Phase 4: Use coordinated mode in backend Node.js processes

Apply the same API to backend workers and daemons that may have large numbers
of active Conat resources.

This is where the scalability payoff becomes largest.

### Testing Requirements

This work should not rely on mocks alone.

The repository already has strong integration-style Conat tests in
[src/packages/backend/conat/test](../packages/backend/conat/test), and this is
exactly the right place to validate the new API.

Use both:

- focused unit tests
- integration tests with a real Conat network on localhost

### Required Integration Tests

#### Streams

- a `DStream` object survives disconnect/reconnect without replacement
- ordinary reconnect resumes from the missing tail only
- history-gap still forces explicit reset behavior
- many streams reconnect under a coordinator concurrency cap

Relevant existing tests:

- [core-stream-recovery.test.ts](../packages/backend/conat/test/core/core-stream-recovery.test.ts)
- [history-gap.test.ts](../packages/backend/conat/test/sync/history-gap.test.ts)

#### DKV

- a `DKV` object survives disconnect/reconnect without replacement
- local unsaved changes remain coherent across reconnect
- many DKV instances reconnect under bounded concurrency

Relevant existing tests:

- [dkv.test.ts](../packages/backend/conat/test/sync/dkv.test.ts)
- [connectivity.test.ts](../packages/backend/conat/test/sync/connectivity.test.ts)

#### Sockets

- a socket survives disconnect/reconnect without replacement
- ordering/exactly-once semantics still hold after reconnect
- resend/ack state remains valid under coordinated recovery
- many sockets reconnect without stampeding

Relevant existing tests:

- [basic.test.ts](../packages/backend/conat/test/socket/basic.test.ts)
- [restarts.test.ts](../packages/backend/conat/test/socket/restarts.test.ts)

### Open Questions

1. Should coordinated mode be opt-in per resource, or a client-wide default?
   Current view:
   - during development it should be opt-in
   - long term it should become the standard mode rather than living forever as
     a niche option
2. How much process-level concurrency should be allowed by default?
   Current view:
   - treat this as a parameter
   - the real question is how many resources should actively recover at once
     after reconnect
   - likely candidates are small numbers such as `3` or `10`
   - integration testing should help decide this instead of intuition alone
3. Should resource priorities be part of the core API, or only the coordinator?
   Current view:
   - not obvious for non-browser resources
   - `recently active` is likely a useful generic signal
   - in practice, resources with recent traffic should probably recover before
     long-idle resources
4. Do sockets need a slightly richer recovery contract than streams and DKV?
   Current view:
   - maybe
   - `dstream` and `dkv` share `CoreStream`, which is conceptually cleaner
   - sockets carry stronger ordering/ack semantics and may need a slightly
     richer contract
5. Should the coordinator own recovery budgets per project/account/host, not
   just per process?
   Current view:
   - probably too hard to require initially
   - per-process budgets are the right first design
   - finer-grained budgets may make sense later, especially in hub processes
6. What is the right heartbeat hierarchy?
   Current view:
   - this is a real open problem and should be treated explicitly
   - transport heartbeat first, shared service-session heartbeat second,
     resource-local heartbeat only as an exception
   - if heartbeat fanout remains high, further multiplexing work will be needed

### Best Next Step

Implement the smallest useful API slice first:

1. add explicit recovery lifecycle events to `CoreStream`
2. add `pauseRecovery()` / `resumeRecovery()` / `recoverNow()` to
   `CoreStream`, `DStream`, and `DKV`
3. do the same for Conat sockets
4. add backend integration tests proving stable-object recovery

Only after that should the frontend reconnect coordinator be changed to depend
on this new API.
