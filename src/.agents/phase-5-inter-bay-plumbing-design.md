# Phase 5 Inter-Bay Plumbing Design

Status: proposed design note for the Phase 5 implementation work described in
[scalable-architecture-implementation-plan.md](/home/wstein/build/cocalc-lite4/src/.agents/scalable-architecture-implementation-plan.md).

This document is intentionally concrete. It is meant to settle the main
architectural choices before writing the multi-bay plumbing code.

## Scope

Phase 5 is about adding the minimum inter-bay control-plane plumbing needed to
move from one-bay Launchpad toward real Rocket:

- inter-bay RPC
- inter-bay routing metadata
- bounded cross-bay event distribution
- replay/fencing hooks
- observability for cross-bay traffic and lag

It is not the phase where project file traffic or project terminal/network IO
become multi-bay. This remains control-plane only.

## Primary Recommendation

Use one internal Conat router fabric that all bays connect to.

Each bay should keep a small number of long-lived outbound connections to a
router cluster. Application code inside a bay should continue to use one local
Conat client by default. Inter-bay forwarding should happen through a
bay-to-fabric bridge layer, not by sprinkling many different Conat clients
throughout the codebase.

This is the recommended default because it gives:

- one global routing model
- no `O(N^2)` bay mesh
- simple per-bay connection management
- reuse of already-debugged router code
- a straightforward scaling story for the fabric itself

The extra hop cost is acceptable because cross-bay traffic should be
control-plane traffic, not a hot project data path.

## Important Clarifications

### The Router Is Not Fully Stateless

The router already maintains and replicates routing state: the subject-pattern
subscription information needed to forward messages correctly.

That is fine and expected.

When this note says "keep the router dumb", the intended meaning is:

- routing state is fine
- transport-level forwarding state is fine
- embedding lots of control-plane product semantics into the router should be
  avoided unless there is a strong reason

In other words, the router should know enough to route, authorize, and
replicate its own subscription metadata, but it should not automatically become
the place where all directory, placement, and policy logic lives unless that is
deliberately chosen.

### Directory/Auth/Placement May Be Fabric Services Or Router Extensions

There are two viable models:

1. directory/auth/placement are ordinary services attached to the fabric
2. some of that logic is implemented inside the router itself by extending
   [server.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/core/server.ts)

This note does not require the first option as a hard rule.

The key architectural rule is weaker and more important:

- keep the application-facing API abstract enough that directory/auth/placement
  can live either as fabric services or as modest router extensions without
  forcing a rewrite of bay code

So the Phase 5 code should target stable interfaces such as:

- resolve bay ownership
- authorize fabric connection
- publish/subscribe to subject families

and should avoid coupling bay code directly to whichever side of the
router-vs-service boundary we initially choose.

## Why A Router Fabric Instead Of A Bay Mesh

The alternatives are:

1. direct bay-to-bay mesh
2. one shared router fabric

The mesh is inferior for the expected scale:

- connection count grows badly with bay count
- service discovery becomes more complex
- auth and certificate/key distribution become more complicated
- client code risks accumulating ad hoc destination-specific clients

The router fabric keeps the topology bounded:

- each bay connects to the fabric
- router nodes scale horizontally
- bays do not need direct knowledge of every other bay connection

## Why Automatic Global Broadcast Is Still A Bad Idea

The router should not broadcast messages to all servers.

Conat's routing model already avoids this by forwarding only when another
server has an explicit subscription match. That is one of the main reasons to
use this router rather than the naive broadcast-style fanout approach that blew
up in earlier production tests.

This is important enough to preserve explicitly:

- no per-message global fanout
- no "forward everywhere and filter later"
- routing should remain subscription-driven and bounded

## Core Phase 5 Principles

### 1. Local-First

If an operation can be fully satisfied within one bay, it should remain local.

### 2. Control-Plane Only

The inter-bay fabric is not for project file data or project runtime streams.

### 3. Bounded Subject Topology

We must not create unbounded per-project inter-bay subjects or per-project
durable streams.

### 4. Explicit Ownership

Every host, project, browser control session, and account-home decision must
have an unambiguous owning bay.

### 5. Failure Should Degrade Inter-Bay Features First

If the inter-bay fabric has problems, local one-bay behavior should continue to
work as much as possible.

## Proposed Topology

### Per Bay

Each bay has:

- its local Conat server(s)
- its local bay services
- one bridge component responsible for attaching the bay to the inter-bay
  fabric

The bridge may be a dedicated process or a hub-hosted service, but its role is
clear:

- connect bay-local Conat to the fabric
- publish and subscribe to the bay's allowed subject families
- provide the single inter-bay client surface used by bay-local code

### Fabric

The inter-bay fabric is a horizontally scalable cluster of Conat router
processes.

The fabric is responsible for:

- subject-pattern routing across bays
- subscription replication across router nodes
- connection admission and auth decisions
- metrics about message routing, backlog, and drops

It is not required to be devoid of all higher-level logic, but the default
should be to keep product-specific semantics out unless doing so materially
improves simplicity or correctness.

## Subject Model

The subject namespace should be made explicit before implementation.

Recommended families:

- `bay.<bay_id>.rpc....`
  destination-bay RPC entrypoints
- `bay.<bay_id>.events....`
  destination-bay durable or replayable event delivery
- `global.directory....`
  ownership/directory lookups if implemented as fabric services
- `global.auth....`
  auth-related control-plane interactions if implemented as fabric services

The exact suffixes can evolve, but the top-level split should be stable:

- bay-scoped traffic
- global service traffic

## Auth Model

Conat auth already provides the right primitive:

- allow a client to publish to some subject patterns
- allow a client to subscribe to some subject patterns

That is enough for Phase 5.

Recommended fabric auth model:

- each bay has its own service identity / key material
- on connection, the bay is granted explicit publish/subscribe subject patterns
- the bridge is only allowed to publish/subscribe to the bay and global
  families that belong to it

Example:

- bay `A` can publish to:
  - `bay.B.rpc....`
  - `global.directory....`
- bay `A` can subscribe to:
  - `bay.A.rpc....`
  - `bay.A.events....`

The exact policy will depend on the final subject scheme, but the important
point is that subject-pattern authorization is already expressive enough for
this phase.

## Directory, Placement, And Auth Placement

This is the main architectural fork.

### Option A: Fabric Services

Directory, placement, and possibly auth are ordinary services attached to the
fabric.

Pros:

- clearer separation of concerns
- easier to reason about independently
- easier to swap implementations later

Cons:

- one more layer of service plumbing
- slightly more moving pieces

### Option B: Router Extensions

Some of that functionality is implemented directly inside the router process.

Pros:

- may reduce operational components
- may simplify very central request paths
- can be implemented by extending already-familiar code in
  [server.ts](/home/wstein/build/cocalc-lite4/src/packages/conat/core/server.ts)

Cons:

- risks mixing routing and product-policy logic
- can make the router harder to evolve independently

### Recommendation

Phase 5 should preserve both as options.

Concretely:

- define stable directory/auth/placement interfaces in bay code
- keep the first implementation small
- choose router-extension vs fabric-service placement pragmatically after
  inspecting the current router code and operational burden

The most important thing is not the placement itself. The most important thing
is avoiding application code that directly depends on that placement.

## What Phase 5 Should Route

Initially:

- project-scoped control RPC when the target project is owned by another bay
- host-scoped control RPC when the host belongs to another bay
- replicated summary/update events needed for browser-visible projections

Not initially:

- project file access
- project terminal streams
- large binary payloads
- arbitrary per-project event fanout

## Event Distribution Model

Use one bounded stream family per destination bay, not per project.

That means:

- durable inter-bay streams are keyed by destination bay
- events for many projects/accounts can flow through the same bay-level stream
- replay/fencing are handled at the bay-stream level

This keeps the topology bounded and aligns with the implementation plan.

## Failure Model

We should decide this up front.

### Fabric Unavailable

- local in-bay operations continue when possible
- cross-bay routing returns explicit retryable errors
- no implicit fallback to stale direct mesh paths

### Directory Stale Or Temporarily Wrong

- ownership lookups may use cache with short TTL
- writes that require authoritative ownership should confirm against the source
  of truth or use a version/epoch fence

### Destination Bay Down

- synchronous RPC fails fast with explicit ownership-preserving errors
- durable event streams accumulate backlog and expose lag

## Rollout Shape

Recommended order:

1. add the fabric-facing bridge abstraction in one-bay mode
2. add explicit subject naming and auth policy for bays
3. add global ownership resolution interface
4. make one or two narrow RPC paths use cross-bay forwarding
5. add bounded durable bay-stream replication
6. add lag/backlog/fencing visibility in CLI/operator status

## Open Questions To Resolve Before Coding

1. Should the first directory implementation be a fabric service or a router
   extension?
2. Should there be one bridge connection per bay or a small configurable pool?
3. Which first RPC path should be the canary?
   - host control
   - project control
   - browser control
4. What exact epoch/fencing mechanism should protect ownership changes during
   replay and restore?

## Recommended Immediate Output

Before Phase 5 code starts, we should freeze:

- subject naming
- bay auth pattern rules
- bridge abstraction API
- initial directory/placement interface
- first canary RPC path

Once those are written down, implementation should be much less likely to
drift into ad hoc routing.
