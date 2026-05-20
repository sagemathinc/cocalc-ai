# Conat Router Interest Direct Sync Plan

Date: 2026-05-20

## Context

We observed a production failure on `alpha.cocalc.ai` where `conat-persist`
accepted new socket connections but never received the initial client data for
those connections. Files opened read-only, patchflow sync sessions never
started, and other frontend features backed by `conat-persist` stalled.

The key experiment was decisive:

- Restarting only `conat-router` fixed the system immediately.
- `conat-persist` stayed running with the same process.
- Restarting only `conat-persist` had also fixed the same failure previously.

That points at stale router/cluster interest state, not a persist data store
bug. Restarting persist likely worked only because it reconnected and
re-advertised its interest.

Commit `d02405b604` added a convergence repair:

- cluster interest updates now have monotonic versions;
- cluster links periodically request authoritative interest snapshots;
- stale snapshots are applied only when all later deltas can be replayed;
- socket clients confirm private return-subject subscriptions before connect.

That is a reasonable near-term production hardening step, but it still leaves
the cluster interest delta stream implemented using Conat's own DStream,
persist, socket, and pub/sub stack. That is clever but circular: the mechanism
that synchronizes router routing state depends on the routing stack being
healthy.

## Goal

Replace cluster interest synchronization with a simpler dedicated
router-to-router control protocol that does not depend on Conat pub/sub,
Conat sockets, DStream, or persist.

The protocol should:

- converge after missed, duplicated, delayed, or reordered messages;
- not require exactly-once delivery;
- preserve low-latency delta propagation in the normal case;
- repair state by periodic authoritative snapshots;
- work for the current same-machine worker cluster;
- continue to work if routers later run as separate processes reachable over
  localhost/TCP;
- fit the existing integration test suite.

## Non-Goals

- Do not introduce Redis, NATS, Postgres, or another external coordinator.
- Do not use shared memory for JavaScript object graphs.
- Do not make interest durable product data. Interest is ephemeral router
  control-plane state.
- Do not redesign the public Conat pub/sub API.
- Do not attempt exactly-once delivery. Use idempotence, versions, and
  snapshots instead.

## Current Design

Each router maintains local interest:

```ts
Patterns<{ [queue: string]: Set<room> }>
```

That state is updated when clients subscribe/unsubscribe. In cluster mode, each
router also publishes interest deltas to a DStream:

- stream name: `cluster/<clusterName>/<id>/interest`
- service: `persist:<clusterName>:<id>`
- storage: ephemeral

Other routers create a `ClusterLink` to a peer and subscribe to that peer's
interest DStream. The link applies remote deltas to its local derived
`link.interest`.

The transport path is:

```text
router A ClusterLink client
  -> Socket.IO/WebSocket to router B
  -> Conat pub/sub
  -> Conat socket
  -> router B in-process cluster persist server
  -> ephemeral DStream/CoreStream
```

This works in normal cases but has too many layers for router-internal routing
state. If one DStream/changefeed/socket layer silently stops making progress,
interest can diverge indefinitely.

## Recommended Design

Use the existing direct router-to-router Socket.IO connection as a dedicated
control channel.

The direct channel should carry only cluster control messages. It should not
use Conat pub/sub subjects to deliver these messages.

### Core Idea

Each router is authoritative for its own local interest.

Each router exposes two forms of its local interest to peers:

- versioned deltas for fast convergence;
- versioned full snapshots for correctness.

Each `ClusterLink` maintains derived state for one remote router:

```ts
{
  peerId: string;
  peerClusterName: string;
  interest: Patterns<{ [queue: string]: Set<room> }>;
  version: number;
  recentDeltas: InterestDelta[];
  lastSnapshotAt: number;
  lastDeltaAt: number;
}
```

The receiver never has to trust exactly-once delivery:

- duplicate delta: ignore because version is already applied;
- stale delta: ignore because version is lower than current;
- gap: request snapshot;
- missing heartbeat/snapshot: request snapshot or reconnect link;
- old snapshot: apply only if later deltas can be replayed;
- incomplete replay buffer: skip snapshot and request a newer one.

## Message Types

Use plain Socket.IO events on the authenticated router-to-router socket.

Names are illustrative; final names can be shorter.

### `cluster-interest-open`

Sent by a router that wants to receive a peer's interest stream.

```ts
interface ClusterInterestOpen {
  protocol: 1;
  clusterName: string;
  nodeId: string;
  knownVersion?: number;
}
```

The receiver validates that the socket is authenticated as the system account.
It records that this socket wants interest updates.

Response:

```ts
interface ClusterInterestOpenResponse {
  ok: true;
  snapshot: InterestSnapshot;
}
```

### `cluster-interest-delta`

Pushed by the authoritative node whenever its local interest changes.

```ts
interface InterestDelta {
  version: number;
  op: "add" | "delete";
  subject: string;
  queue?: string;
  room: string;
}
```

Versions are per-node, monotonic, and increment exactly once for each local
interest mutation.

### `cluster-interest-snapshot`

Pushed periodically and returned on request.

```ts
interface InterestSnapshot {
  version: number;
  subjects: {
    [subject: string]: {
      [queue: string]: string[];
    };
  };
}
```

Arrays are sorted for deterministic tests and easier debugging.

### `cluster-interest-snapshot-request`

Sent when a receiver detects a gap, stale heartbeat, or replay failure.

```ts
interface ClusterInterestSnapshotRequest {
  reason:
    | "bootstrap"
    | "gap"
    | "periodic"
    | "stale"
    | "reconnect"
    | "debug";
  currentVersion?: number;
}
```

Response is `InterestSnapshot`.

### `cluster-interest-close`

Sent when a link is unjoined or the router is closing. Best effort only.

## Protocol Flows

### Link Bootstrap

1. Router A creates a direct connection to router B.
2. Router A sends `cluster-interest-open`.
3. Router B returns `InterestSnapshot(version=N)`.
4. Router A replaces `link.interest` with the snapshot and sets
   `link.version = N`.
5. Router B registers A's socket for future deltas.

### Local Subscribe/Unsubscribe on Router B

1. Router B increments `interestVersion`.
2. Router B updates local `interest`.
3. Router B broadcasts `InterestDelta(version=M)` to all registered peer
   control sockets.
4. Router A receives the delta:
   - if `M === link.version + 1`, apply and set `link.version = M`;
   - if `M <= link.version`, ignore;
   - if `M > link.version + 1`, record gap and request snapshot.

### Snapshot While Deltas Are Arriving

This is the important heavy-traffic case.

1. Router A requests snapshot.
2. Router B sends snapshot at version `N`.
3. Before A receives the snapshot, A may already receive deltas up to version
   `M > N`.
4. A applies the snapshot only if it can replay every buffered delta from
   `N + 1` through `M`.
5. If replay is incomplete, A skips the snapshot and requests another one.

This avoids the bug where an old snapshot erases a newer delta.

### Periodic Repair

Every 15-30 seconds per link:

- request snapshot, or
- accept a pushed snapshot from the peer.

Either direction is fine. Receiver-requested snapshots are easier to reason
about because the receiver controls when replay starts. Pushed snapshots reduce
RPC fanout logic but require the same replay checks.

I recommend receiver-requested snapshots first because it mirrors the current
`d02405b604` repair and is easier to test.

### Stale Link

If no delta or snapshot is received for a configured interval:

1. request snapshot;
2. if snapshot request times out, mark link unhealthy;
3. let existing scan/join logic reconnect the peer.

This is not a persist/router restart. It is localized link repair.

## Implementation Plan

### Phase 0: Document and Preserve Current Fix

Status: mostly done via `d02405b604`.

- Keep the current snapshot repair until the direct protocol is tested.
- Keep the backend integration tests added for snapshot repair.
- Add this plan before deciding whether to replace the transport.

### Phase 1: Introduce Direct Protocol in Shadow Mode

Add the new control channel while leaving the DStream path as the actual router
source of truth.

Files likely touched:

- `src/packages/conat/core/cluster.ts`
- `src/packages/conat/core/server.ts`
- `src/packages/conat/core/sys.ts` if keeping snapshot RPC helpers
- backend Conat cluster tests

Tasks:

1. Define protocol message types in `cluster.ts` or a new
   `cluster-interest.ts`.
2. Add `serializeInterest` / `replaceInterest` helpers if not already shared.
3. Add server-side Socket.IO handlers:
   - `cluster-interest-open`
   - `cluster-interest-snapshot-request`
   - `cluster-interest-close`
4. Add a peer registry on each router:

```ts
private clusterInterestPeers = new Map<
  string,
  { socket: Socket; clusterName: string; id: string }
>();
```

5. Broadcast versioned deltas from `updateInterest`.
6. In `ClusterLink`, subscribe to direct deltas in shadow mode and maintain a
   second derived interest object:

```ts
directInterest: Interest;
dstreamInterest: Interest;
```

7. Compare hashes periodically and log mismatches.

Exit criteria:

- Direct protocol can bootstrap from snapshot.
- Direct protocol receives live deltas.
- Direct protocol matches the existing DStream-derived interest in integration
  tests.

### Phase 2: Make Direct Protocol the Read Path

Switch `ClusterLink.interest` to use the direct protocol state.

Keep the DStream path available behind a fallback flag for one release if
desired.

Feature flag:

```text
COCALC_CONAT_CLUSTER_INTEREST_TRANSPORT=direct|dstream|shadow
```

Recommended default after tests pass:

```text
direct
```

Tasks:

1. Replace `ClusterLink.init()` DStream bootstrap with direct
   `cluster-interest-open`.
2. Keep `waitForInterest`, `hasInterest`, `hash`, and routing callers unchanged.
3. Keep current `scan`, `join`, and `unjoin` topology logic unchanged.
4. Ensure direct link close removes peer registry entries on the remote.
5. Ensure reconnect reopens the control stream and fetches a fresh snapshot.

Exit criteria:

- Existing cluster pub/sub tests pass with direct protocol.
- Existing cluster socket tests pass with direct protocol.
- Existing sync and DStream cluster tests either pass or are adjusted if they
  were testing the old internal implementation rather than public behavior.

### Phase 3: Remove DStream Cluster Interest Transport

Once direct protocol is default and stable:

1. Remove `createClusterPersistServer` from router cluster initialization if it
   is only used for interest.
2. Remove `clusterStreams` for interest, or keep only test/debug helpers if
   still useful.
3. Remove `trimClusterStreams`.
4. Update tests that inspect internal DStream sequence numbers to inspect direct
   protocol state instead.

Exit criteria:

- Router cluster interest no longer depends on persist.
- Router cluster interest no longer depends on Conat socket.
- Router cluster interest no longer depends on DStream.

### Phase 4: Hardening and Observability

Add lightweight metrics/logging:

- current peer interest version;
- last snapshot age;
- last delta age;
- gap count;
- snapshot request count;
- replay failure count;
- peer reconnect count;
- serialized snapshot size.

Expose in existing Conat server stats or sys diagnostics.

## Test Plan

Use backend integration tests under `src/packages/backend/conat/test`.

### Required Existing Tests

Run at minimum:

```bash
cd src/packages/backend
pnpm exec jest conat/test/cluster conat/test/socket/cluster.test.ts --runInBand
```

Also run:

```bash
cd src/packages/conat
pnpm tsc --build

cd ../backend
pnpm tsc --build
```

### New Tests

Add direct protocol tests for:

1. Bootstrap snapshot:
   - create two nodes;
   - subscribe on node B;
   - join from node A;
   - assert A's link sees B's interest.

2. Live delta:
   - after join, subscribe/unsubscribe on B;
   - assert A's link updates without waiting for periodic snapshot.

3. Missing delta gap:
   - drop or skip one delta in test instrumentation;
   - deliver a later delta;
   - assert gap is detected and snapshot repairs state.

4. Old snapshot with newer deltas:
   - take snapshot at version N;
   - deliver deltas N+1 through M;
   - apply snapshot;
   - assert replay preserves the newer deltas.

5. Old snapshot with incomplete replay:
   - take snapshot at version N;
   - deliver delta N+2 without N+1;
   - apply snapshot;
   - assert snapshot is skipped and snapshot request is scheduled.

6. Stale delete:
   - subscribe and unsubscribe;
   - drop delete delta;
   - assert periodic snapshot removes stale interest.

7. Heavy churn:
   - create many subscribe/unsubscribe operations while requesting snapshots;
   - assert final link hash equals authoritative server hash.

8. Reconnect:
   - close router-to-router connection;
   - reconnect;
   - assert fresh snapshot repairs state.

9. Forked local cluster:
   - use existing `localClusterSize`/forked worker path if covered by tests;
   - assert all workers converge.

## Alternatives Considered

### Keep DStream + Snapshots

This is the current post-`d02405b604` approach.

Pros:

- minimal change;
- already implemented and tested;
- likely fixes the observed production failure.

Cons:

- still circular;
- still routes internal router control state through the data-plane stack;
- harder to reason about when debugging router failures.

This is acceptable as a short-term hardening step.

### Node IPC Through Parent Process

Since production cluster workers are same-machine child processes, Node IPC is
possible.

Pros:

- bypasses Conat pub/sub and Socket.IO;
- could be very fast;
- parent can maintain central authoritative table.

Cons:

- couples router clustering to one process manager topology;
- direct child-to-child messaging is not natural; parent becomes broker;
- same-process integration tests need a parallel path;
- parent broker becomes a new single bottleneck/failure point;
- still needs versions/snapshots unless parent is fully authoritative.

This is not my first choice. It is viable only if we intentionally make the
parent process the cluster coordinator.

### Shared Memory

Not recommended.

JavaScript interest state is nested maps/sets/pattern indexes. Shared memory
would mean designing a custom byte-level data structure with Atomics. That is
more complexity than the problem warrants.

### External Coordinator

Examples: Redis, NATS, Postgres, SQLite.

Not recommended for this specific problem.

Interest is high-churn, ephemeral routing state. Adding an external dependency
would increase operational complexity and still require cleanup/TTL/version
logic.

## Migration Strategy

1. Land direct protocol in shadow mode.
2. Compare direct interest hash with DStream interest hash in tests and,
   optionally, debug logs.
3. Switch tests to direct mode.
4. Deploy direct mode to alpha.
5. Keep DStream fallback for one short cycle if desired.
6. Remove DStream interest transport once alpha runs cleanly.

## Risks

### Snapshot Size

A full interest snapshot could be large if there are many clients and private
subjects.

Mitigation:

- same-machine traffic is cheap;
- snapshots are periodic, not per publish;
- measure serialized size;
- if needed, compress or reduce frequency.

### Subscription Churn Exceeds Replay Buffer

If churn between snapshot request and response exceeds the delta replay buffer,
the snapshot is skipped.

Mitigation:

- buffer by count and maybe by time;
- request another snapshot immediately on replay failure;
- snapshots are local/fast, so the in-flight window should be small.

### Mixed Old/New Routers

During rolling upgrade, some routers may not support direct protocol.

Mitigation:

- shadow/fallback mode;
- versioned protocol field;
- detect unsupported peer and use DStream temporarily.

### Duplicate Links

Existing scan/join can produce bidirectional links. Direct peer registries must
handle duplicate opens idempotently.

Mitigation:

- key peer registry by `{clusterName, id, socket.id}` or a generated link id;
- close removes only its own registration;
- duplicate deltas are ignored by version.

## Recommendation

Keep `d02405b604` for near-term production stability.

If alpha runs cleanly after that, this rewrite is optional but still desirable.
If we see any further cluster interest weirdness, implement the direct protocol
instead of adding more DStream-level repair.

I would implement it incrementally:

1. direct protocol in shadow mode;
2. switch read path to direct;
3. remove DStream cluster interest transport.

Expected effort: 2-4 focused days including tests and cleanup.
