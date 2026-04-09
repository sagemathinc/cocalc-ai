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

### 4a. The Browser Has One Control-Plane Bay

The browser should not be redirected between visible bay URLs during normal
operation.

The intended Phase 5 and later model is:

- the user-facing browser URL remains stable
- global bootstrap/login resolves the account home bay
- bootstrap issues bay-scoped browser connection credentials
- the browser then opens one long-lived control-plane connection to the account
  bay
- project control is routed through that account bay
- direct project-host connections remain the separate runtime/compute path

This keeps browser connection management bounded even for users who interact
with many projects at once.

### 5. Separate Control Ownership From Execution Placement

For Phase 5 and beyond, we should not assume that a project's execution host is
co-located with the bay that owns the project's control-plane state.

The intended default shape is:

- accounts have a home bay
- most projects should default to the same bay as their primary owner/account
- project ownership remains a bay-level control-plane decision
- project-host placement is an execution-resource decision that may be remote
  from the project's owning bay

This reflects the expected real product shape:

- collaboration exists, but most projects are effectively single-owner
- therefore keeping account and project on the same bay is usually the best UX
- sparse regional project-host fleets should not force account/project control
  ownership to fragment unnaturally across bays

### 5a. Regions Matter

Bay placement should be region-aware from the start.

In particular:

- account home-bay placement should strongly prefer the user's nearby region
- project default placement should usually follow the account bay/region
- project-host choice should continue to follow the existing region-aware host
  placement model
- bay region metadata should use the same Cloudflare-style regional taxonomy
  that already influences project-host selection, so placement policy is
  operating on one consistent notion of region

The central auth/directory service must stay off the hot path so that a
region-local bay can make the control-plane experience region-local too.

### 6. Failure Should Degrade Inter-Bay Features First

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
- host-scoped control RPC when the relevant host must be reached outside the
  current bay
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
   extension? ANS: i think directory = fabric service makes the most sense.
2. Should there be one bridge connection per bay or a small configurable pool? ANS: I'm not sure -- Interesting -- a haven't implemented pooling yet, but it certainly makes sense as it should increase throughput and hopefully not add too much complexity (?).
3. Which first RPC path should be the canary? ANS: project control: a clear e2e test is to have an account in bay 1 and a project in bay 2 and to start that project via the account.
   - host control
   - project control
   - browser control
4. What exact epoch/fencing mechanism should protect ownership changes during
   replay and restore? ANS: No idea.

## Recommended Immediate Output

Before Phase 5 code starts, we should freeze:

- subject naming
- bay auth pattern rules
- bridge abstraction API
- initial directory/placement interface
- first canary RPC path

The following is the proposed frozen v1 contract.

## 2026-04-08 Execution Focus

The next concrete implementation milestone for this design is:

- remote collaborator auth/session plumbing

This focus comes after proving that cross-bay invite delivery, acceptance,
project listing, LRO forwarding, and projected project visibility work in the
two-bay dev setup.

What remains blocked is deeper authorization and session trust on remote
project paths. In practice this means a remote collaborator can already see a
shared project, but still hits one-bay assumptions on operations such as:

- project metadata/detail reads
- project open flows
- project-host credential issuance
- file/terminal/notebook access that depends on project-host auth

For the next slice, "done" means:

- remote collaborators are recognized as collaborators everywhere auth is
  checked
- account-bay sessions can request valid project-host credentials for remote
  projects
- browser and CLI flows can open and use a remote shared project from the
  collaborator's account bay

This milestone is intentionally deeper than generic UI polish. The goal is to
remove the hidden one-bay auth/session assumptions before broadening the remote
project UX surface further.

## Additional Frozen Phase 5 v1 Ownership Rules

- `account_bay` and `project_bay` are separate concepts, but the default
  placement goal is that a user's projects usually live in the same bay as that
  user's account
- `project_bay == host_bay` is not an architectural requirement
- project-host execution reachability must be explicit in code, not inferred
  from hidden one-bay assumptions
- the representation of host reachability is intentionally not fully frozen
  yet:
  - it may remain `host_id -> bay_id` in the near term
  - or it may evolve into a richer "host route" record if that proves cleaner
    in implementation
- Phase 5 code should therefore depend on an explicit host-routing interface,
  not on broad assumptions that hosts and projects share a bay

## Frozen Phase 5 v1 Contract

### 1. Subject Naming

Use a small fixed family of inter-bay subjects.

Top-level families:

- `bay.<dst_bay>.rpc.project-control.<method>`
- `bay.<dst_bay>.rpc.host-control.<method>`
- `bay.<dst_bay>.events.control`
- `global.directory.rpc.<method>`

Rules:

- The first routing key is always the destination bay, not the source bay.
- We do not create top-level per-project or per-host subject families.
- We do not create per-project durable inter-bay streams.
- Reply traffic in v1 uses ordinary Conat inbox subjects; we do not invent a
  separate bespoke reply namespace in this phase.

Implications:

- cross-bay project control is always routed to the owning bay first
- once inside the destination bay, normal local project/host routing takes over
- replayable inter-bay events are batched into the bounded
  `bay.<dst_bay>.events.control` family instead of exploding the subject space

### 2. Bay Auth Pattern Rules

Phase 5 v1 assumes each bay bridge is a trusted internal service identity on a
private fabric.

For bay `A`, the bridge is allowed:

- publish:
  - `bay.*.rpc.>`
  - `bay.*.events.>`
  - `global.directory.rpc.>`
  - `_INBOX.>`
- subscribe:
  - `bay.A.rpc.>`
  - `bay.A.events.>`
  - `global.directory.rpc.>`
  - `_INBOX.>`

Notes:

- This is intentionally broad enough to let one bridge request any other bay
  and use ordinary request/reply semantics.
- The `_INBOX.>` allowance is acceptable in v1 because this is an internal
  trusted fabric, not a user-facing Conat surface.
- If we later want tighter reply-path auth, we can move the bridge to an
  explicit bay-owned reply namespace without changing application code.

### 3. Bridge Abstraction API

Bay application code should not construct raw inter-bay subject strings or
manage extra Conat clients directly. It should depend on one bridge interface.

Phase 5 v1 bridge shape:

```ts
interface InterBayBridge {
  readonly bay_id: string;

  request<T = any>(opts: {
    dest_bay: string;
    subject: string;
    data?: any;
    timeout_ms?: number;
  }): Promise<T>;

  publishEvent(opts: {
    dest_bay: string;
    subject: string;
    data?: any;
  }): Promise<void>;

  subscribe(
    subject: string,
    handler: (mesg: any) => Promise<any>,
  ): Promise<{
    close: () => void;
  }>;
}
```

Bridge rules:

- there is one logical bridge connection per bay in v1
- connection pooling is deferred; the interface must not preclude it later
- all outgoing inter-bay RPC from bay code goes through `request(...)`
- all incoming fabric handlers are registered through the bridge, not scattered
  through unrelated modules

Implementation note:

- the bridge may internally use one Conat client today and a small client pool
  later without changing call sites

### 4. Initial Directory / Placement Interface

The first directory implementation should be a fabric service, not a router
extension.

Phase 5 v1 directory surface:

```ts
interface InterBayDirectory {
  resolveProjectBay(project_id: string): Promise<{
    bay_id: string;
    epoch: number;
  } | null>;

  resolveHostBay(host_id: string): Promise<{
    bay_id: string;
    epoch: number;
  } | null>;
}
```

Rules:

- `project_id -> bay_id` is authoritative for project-control routing
- `host_id -> bay_id` is only the current v1 reachability surface for
  host-control routing; it should be treated as an implementation placeholder
  for a more explicit host-route model if the code pushes us that way
- every response includes an `epoch`
- callers may cache responses briefly, but mutating operations should carry or
  check the epoch so stale ownership can be rejected explicitly
- project control must not assume that the execution host lives in the same bay
  as the project

Deferred from v1:

- account home bay
- browser session bay lookup
- automatic placement decisions
- migration / reassignment workflows

The broader placement direction is still frozen, though:

- bays already have explicit region metadata
- new account and project placement should normally follow nearby Cloudflare
  region information
- the account bay is expected to be the browser's long-lived control-plane bay

### 5. First Canary RPC Path

The first canary path is cross-bay project control.

Concretely:

- an account session connected to bay `A`
- acting on a project owned by bay `B`
- sends `project start --wait`
- bay `A` resolves `project_id -> bay B`
- bay `A` issues an inter-bay RPC to
  `bay.B.rpc.project-control.start`
- bay `B` performs the normal local start path
- the result is returned to bay `A`

Why this path first:

- it is a real end-to-end operator-visible workflow
- success/failure is unambiguous
- it exercises directory lookup, inter-bay routing, destination-bay execution,
  and reply handling
- it validates the desired common-case UX, where the user/account bay and the
  project bay are usually aligned even though the execution host may not be
  co-located there
- it does not require browser session migration or project data-plane movement

Non-goals for the first canary:

- browser control
- inter-bay file access
- project execution streams
- ownership migration during the request

### 6. Fencing Rule For v1

The full replay/restore ownership fencing design is still open, but v1 should
freeze one minimal rule so coding can start safely:

- every authoritative directory answer includes `epoch`
- inter-bay mutating RPC should carry the epoch it resolved against
- if the destination bay sees an ownership mismatch or newer epoch, it returns
  an explicit stale-routing error instead of silently acting

That is enough to avoid baking in epoch-free routing while leaving room for a
better migration/replay design later.

Once these are written down, implementation should be much less likely to drift
into ad hoc routing.
