# Explicit Conat Routing and Authority

Status: current design guidance for CoCalc-ai control/data-plane routing.

This document explains a deliberate architectural choice: Conat is a transport
and typed RPC substrate, not a magic global authority resolver. Application code
is expected to decide who owns an action, which Conat fabric can reach that
owner, and which identity is allowed to perform the action.

This is more explicit than systems such as NATS clusters and superclusters, and
it requires more application code. That cost is intentional for privileged
operations such as auth, billing, project placement, host lifecycle, project
start/stop, backup, and destructive storage actions.

## Core Principle

Authority stays explicit in application code.

Examples:

- Account data is owned by the account `home_bay_id`.
- Project control is owned by the project `owning_bay_id`.
- Project-host lifecycle is owned by the host `bay_id`.
- Project data-plane traffic should go directly to the owning project host when
  possible.

Conat moves messages. It should not silently decide that a subject exists
somewhere else, that another bay is authoritative, or that an already-open
connection still has permission after a user is banned.

The most important rule is:

```text
subject name != location
```

A subject such as `project-host.<host_id>.api` is reachable on a given Conat
fabric only if a service registered that subject on that fabric, or if code
explicitly routes that subject to another fabric.

## Why Not a Magic Mesh?

NATS-style clusters and superclusters are powerful, but they intentionally hide
many routing details. That can be useful when the main goal is moving messages
across a large infrastructure without writing much application routing code.

CoCalc has different pressure points:

- Authz changes must take effect quickly. Banned users, removed collaborators,
  and revoked sessions must not keep using an existing connection indefinitely.
- Privileged control paths must be auditable. It should be clear why a caller
  was allowed to start a project, grow a disk, update SSH keys, or delete data.
- Ownership matters. A bay or host is authoritative because the database says
  so, not because a mesh happened to route a subject there.
- Debugging production incidents must be concrete. Operators should be able to
  answer "which service should have registered this subject on which fabric?"

The tradeoff is that we sometimes have to write glue code that a magic mesh
would hide. Commit `728bc74e19` is a representative example.

## Lesson From `728bc74e19`

The bug:

- Bay-side code routed project-host control RPCs directly to the host-local
  Conat fabric.
- The project host only registered `project-host.<host_id>.api` on its
  master-facing Conat connection.
- The subject name was correct, but it was not registered on the fabric the bay
  was using.
- Calls such as `createProject` timed out.

The fix:

- Keep the same `HostControlApi` implementation.
- Register it on the master-facing Conat client.
- Also register it on the host-local Conat client.
- Preserve the same registration behavior after delayed master-token recovery.

The important point is that this was not a new capability. It was making an
existing capability available on the route that the bay had explicitly chosen.

## Conat Fabrics

Think of a Conat fabric as a scoped communication surface. The same subject text
can mean different things depending on which fabric it is registered on.

Common fabrics:

- Browser to home bay: user control-plane connection for accounts, projects,
  billing, settings, and placement.
- Bay internal: hub workers, Postgres-backed control state, host registry, and
  bay-owned service APIs.
- Inter-bay: explicit bay-to-bay control messages for data owned elsewhere.
- Project-host local: project data-plane services, project-host control APIs,
  file services, terminals, Jupyter, app proxying, and host-local state.
- Project runtime local: narrow project/container-local tokens and services.

Do not assume a service on one fabric exists on another fabric. Either register
it there intentionally or route to the fabric where it is registered.

## Routing Matrix

| Operation class                 | Authority                     | Preferred route                            | Notes                                                                    |
| ------------------------------- | ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Account settings                | Account `home_bay_id`         | Browser or caller to home bay              | Do not write another bay directly unless routing has resolved authority. |
| Billing and membership          | Account/billing authority     | Home bay or global billing layer           | Keep side effects centralized and auditable.                             |
| Project metadata                | Project `owning_bay_id`       | Caller to owning bay                       | Placement, collaborators, and state updates are owner-bay decisions.     |
| Project start/stop              | Owning bay plus assigned host | Owning bay to project-host control API     | Host executes, bay authorizes and records durable state.                 |
| Project files/terminals/Jupyter | Assigned project host         | Browser direct to project host             | Avoid proxying steady-state data through the hub.                        |
| Project-host lifecycle          | Host `bay_id`                 | Bay to provider and host-control APIs      | Cloud/provider and host metadata belong to the bay.                      |
| Host-local maintenance          | Project host                  | Bay to host-control API                    | Requires explicit service registration on the route being used.          |
| Cross-bay project operation     | Source and destination owners | Inter-bay control plus direct host actions | Never assume both projects are local.                                    |

## Auth and Revocation

Explicit routing is tied to explicit auth.

Each boundary should have a concrete identity model:

- Browser to bay uses account/session identity.
- Bay to project host uses a scoped hub/host identity.
- Browser to project host uses a short-lived host-scoped token.
- Project runtime to project host uses a host-local project token.

Authorization should be checked close to the resource:

- Account and billing authz on the account authority.
- Project metadata authz on the owning bay.
- Project data-plane authz on the project host using local ACL state.
- Host maintenance authz on host-control APIs using bay/system identity.

Revocation must be an active design requirement. If a user is banned, removed
from a project, or signed out, existing connections must be disconnected or made
useless quickly. Avoid designs where a long-lived mesh connection remains valid
only because it authenticated successfully at connection time.

## PostgreSQL Analogy

The same philosophy applies to database architecture.

A magic multi-master PostgreSQL cluster could hide cross-bay writes and
replication, but it would move complexity into conflict resolution, latency,
operator visibility, and unclear ownership. CoCalc instead prefers explicit
ownership:

- Resolve the authoritative bay.
- Perform writes there.
- Replicate projections/events where needed.
- Treat read models and caches as derived state.

This makes the correctness model easier to debug. A wrong route is usually a
code bug with a concrete owner and call site, not a distributed database
conflict that has to be explained after the fact.

## When Magic Is Acceptable

Not every path needs the same level of explicitness.

Mesh-like or best-effort behavior is reasonable for:

- Telemetry.
- Metrics.
- Presence.
- Non-authoritative cache invalidation.
- Debug streams.
- Low-risk pubsub where missed or delayed messages are tolerable.

It is not appropriate as the primary correctness model for:

- Auth and revocation.
- Billing and purchases.
- Project ownership and collaborators.
- Project placement.
- Host lifecycle.
- Project start/stop.
- Backups, restores, and destructive storage operations.

## Operational Debugging Checklist

When a Conat RPC times out or returns "no responders", ask:

- What is the subject?
- Which fabric did the caller use?
- Which fabric did the service register on?
- Which bay/host is authoritative for the action?
- Is there an explicit route from the caller to that authority?
- Is the caller using the right identity for that route?
- Should this be direct data-plane traffic instead of hub-mediated traffic?
- Should this route have a fallback, or should the service register on multiple
  fabrics?

This checklist should usually identify whether the bug is service registration,
route resolution, auth, host placement, or stale metadata.

## Practical Improvements Not Implemented Yet

The current design is explicit, but the code can make that explicitness easier
to maintain. These are feasible improvements, not current guarantees.

### Routing Matrix In Code

Add a machine-readable routing matrix for high-value control APIs:

- API name.
- Authority owner type.
- Expected caller identities.
- Expected Conat fabric.
- Fallback route, if any.
- Whether data-plane traffic is allowed.

Tests can then assert that route clients and service registrations match the
matrix.

### Service Registration Tests

For every route client, add a test proving that the target service is registered
on the fabric the route client uses.

The `728bc74e19` class of bug should be caught as:

```text
route client uses host-local fabric, but HostControlApi is only registered on
the master-facing fabric
```

### Stronger Client Names

Avoid generic names like `client` when multiple Conat fabrics are involved.

Prefer names such as:

- `masterConatClient`
- `hostLocalConatClient`
- `browserConatClient`
- `interBayConatClient`
- `projectRuntimeConatClient`

This is tedious, but it makes routing mistakes much easier to spot in review.

### Explicit Error Metadata

Every high-level Conat and LRO error should carry structured metadata:

- Human-facing summary.
- Machine-readable code.
- Call site or operation name.
- Subject.
- Route/fabric.
- Authority owner.
- Caller identity class.
- Relevant ids: account, project, host, bay, operation.

This is repetitive work, but it is exactly the kind of system-wide polish that
AI-assisted development makes practical for a small team.

### Route Tracing

Add lightweight route tracing for control-plane calls:

- Caller fabric.
- Resolved authority.
- Target fabric.
- Target subject.
- Auth identity class.
- Timeout and retry policy.

This should be safe to log without secrets and should be available in LRO
technical details for admin-facing operations.

### Auth Revocation Tests

Add explicit tests for revocation on long-lived connections:

- Banned account is disconnected.
- Removed collaborator loses project-host data-plane access.
- Revoked browser session cannot mint new project-host tokens.
- Host-scoped token expiry is enforced.
- Existing project-host sockets are disconnected or denied after ACL updates.

These tests are tedious and cross-cutting, but they are more valuable than
assuming the transport layer will handle revocation.

### Ownership Assertions

Add assertions at dangerous write paths:

- "This bay is the account home bay."
- "This bay is the project owning bay."
- "This host belongs to this bay."
- "This operation has resolved source and destination ownership."

These should fail loudly in development and return actionable admin errors in
production.

## Summary

The explicit model costs more code, but it buys security, revocation,
debuggability, and operational control. That tradeoff is increasingly practical
because tedious consistency work can be accelerated with AI assistance.

The goal is not to avoid abstraction. The goal is to avoid hiding authority.
